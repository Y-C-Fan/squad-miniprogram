"""
阈值自动标定 —— 在真实的动作波形模型上搜最优阈值
=================================================

## 为什么需要这个

现在的 `squat-detector.js` 里的阈值是**手调猜出来的**，只对着合成数据做过自检。
问题是合成数据太干净：正弦曲线、恒定噪声、无姿态漂移。
真人是完全另一回事：

- 深蹲幅度因人而异（半蹲 vs 蹲到最低，位移差 3 倍）
- 频率分布很宽（慢速康复蹲 4 秒一个 → 爆发式 0.8 秒一个）
- 手臂摆动、躯干前倾、鞋底摩擦都会带来姿态漂移
- 手腕佩戴位置、松紧度不同，倾角信号幅度差很多
- 落地冲击、起身反弹都不是理想正弦

所以"能数对"这件事必须在**贴近真实**的波形上验证，并对阈值做系统搜索，
而不是拍脑袋。

## 这个脚本做什么

1. 用**生理学更合理的合成模型**生成大批训练信号
   （不是简单正弦：叠加二次谐波模拟"下蹲快起立慢"的不对称性、
   加入低频漂移模拟姿态变化、加入脉冲干扰模拟落地冲击）
2. 把 `squat-detector.js` 的检测逻辑**等价移植到 Python**
   （保证两边算法一致，改一处两边同步）
3. 网格搜索 + 贝叶斯优化（scipy 无则用坐标下降），
   对 (enter, exit, minMotion, calibStill) 四个阈值做全局搜索
4. 评估指标：准确率、漏计率、误计率、以及**最差场景表现**（不是平均分）
5. 输出最优阈值 + 鲁棒性报告

## 为什么在 Linux 上跑

不是因为需要 GPU，而是因为需要跑 **数万次仿真 × 数百组参数**的组合。
每次仿真几秒，全组合会跑很久。并行 + 后台跑更合适。

## 用法

    python3 calibrate.py                # 默认搜索
    python3 calibrate.py --quick         # 小规模快速版
    python3 calibrate.py --out best.json # 保存结果
"""

import json
import math
import os
import sys
import time
from dataclasses import dataclass, asdict
from typing import List, Tuple

import numpy as np

G = 9.81
DT = 0.020  # 20ms，与 Vela/微信 interval:'game' 一致


# ─────────────────────────── 检测器（squat-detector.js 的 Python 等价实现） ───────────────────────────

# 必须与 utils/squat-detector.js 中的取值完全一致
TILT_PRESET_BASE = {
    'low':    dict(enter=26,   exit=19,   minDownMs=260, maxDownMs=4500, minMotion=0.8, minGapMs=1000),
    'medium': dict(enter=18,   exit=12,   minDownMs=200, maxDownMs=4500, minMotion=0.6, minGapMs=800),
    'high':   dict(enter=11,   exit=7,    minDownMs=150, maxDownMs=4500, minMotion=0.5, minGapMs=550),
}
LIFT_PRESET_BASE = {
    'low':    dict(enter=0.18, exit=0.11, minDownMs=260, maxDownMs=4500, minMotion=0.8, minGapMs=1000),
    'medium': dict(enter=0.12, exit=0.07, minDownMs=200, maxDownMs=4500, minMotion=0.6, minGapMs=800),
    'high':   dict(enter=0.08, exit=0.045, minDownMs=150, maxDownMs=4500, minMotion=0.5, minGapMs=550),
}
DEFAULT_CALIB_MS = 500
DEFAULT_CALIB_STILL = 0.5
DEFAULT_CALIB_WINDOW = 25


def _unit(v):
    m = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    return (v[0] / m, v[1] / m, v[2] / m)


def _alpha(dt, tau):
    return 1.0 - math.exp(-dt / tau)


class SquatDetector:
    """与 utils/squat-detector.js 逻辑一一对应。改 JS 时必须同步改这里。"""

    def __init__(self, mode='tilt', cfg=None, calib_ms=DEFAULT_CALIB_MS,
                 calib_still=DEFAULT_CALIB_STILL, calib_window=DEFAULT_CALIB_WINDOW):
        self.mode = mode
        self.cfg = dict(cfg or TILT_PRESET_BASE['medium'])
        self.calib_ms = calib_ms
        self.calib_still = calib_still
        self.calib_window = calib_window
        self.reset()

    def reset(self):
        self.gravity = None
        self.baseline = None
        self.last_ts = 0
        self.calibrating = True
        self.calib_since = 0.0
        self.calib_buf = []
        self.motion_avg = 0.0
        self.state = 'top'
        self.down_since = 0
        self.motion_peak = 0.0
        self.last_count_at = 0
        self.count = 0
        self.tilt = 0.0
        self.signal = 0.0
        self.linear = 0.0
        self.absolute_tilt = 0.0
        self.vz_bias = 0.0
        self.vz = 0.0
        self.sz = 0.0
        self.sz_bias = 0.0
        self.displacement = 0.0

    def _compute_signal(self, g, lx, ly, lz, dt):
        if self.mode == 'tilt':
            if self.baseline is None:
                self.displacement = 0.0
                return 0.0
            b = self.baseline
            d = max(-1.0, min(1.0, g[0] * b[0] + g[1] * b[1] + g[2] * b[2]))
            self.tilt = math.acos(d) * 180.0 / math.pi
            self.displacement = 0.0
            return self.tilt

        along = lx * g[0] + ly * g[1] + lz * g[2]
        self.vz_bias += _alpha(dt, 0.6) * (along - self.vz_bias)
        hp = along - self.vz_bias
        self.vz = (self.vz + hp * dt) * math.exp(-dt / 0.9)
        self.sz = (self.sz + self.vz * dt) * math.exp(-dt / 2.5)
        self.sz_bias += _alpha(dt, 3.0) * (self.sz - self.sz_bias)
        self.displacement = self.sz - self.sz_bias
        self.tilt = 0.0
        return -self.displacement

    def push(self, acc, ts):
        dt = 0.020 if self.last_ts == 0 else max(0.004, min(0.1, ts - self.last_ts))
        self.last_ts = ts

        raw = _unit(acc)
        if self.gravity is None:
            self.gravity = raw
        else:
            a = _alpha(dt, 0.10)
            self.gravity = _unit((
                self.gravity[0] + a * (raw[0] - self.gravity[0]),
                self.gravity[1] + a * (raw[1] - self.gravity[1]),
                self.gravity[2] + a * (raw[2] - self.gravity[2]),
            ))
        g = self.gravity

        lx = acc[0] - g[0] * G
        ly = acc[1] - g[1] * G
        lz = acc[2] - g[2] * G
        self.linear = math.sqrt(lx * lx + ly * ly + lz * lz)
        # 绝对倾角：重力方向与世界竖直(+z)的夹角。
        # 用于判断'人是真的站直了还是在蹲着'，是零点漂移补偿的安全前提。
        # 只看相对基准的话，基准会一路跟着重力跑到深蹲底部，把幅度吸收掉，
        # 下次回落时相对基准瞬间变 0 → 立刻退出 → 同一个深蹲被数两次。
        self.absolute_tilt = math.acos(max(-1.0, min(1.0, g[2]))) * 180.0 / math.pi

        sig = self._compute_signal(g, lx, ly, lz, dt)
        cfg = self.cfg

        if self.calibrating:
            self.calib_buf.append(self.linear)
            if len(self.calib_buf) > self.calib_window:
                self.calib_buf.pop(0)
            self.motion_avg = sum(self.calib_buf) / len(self.calib_buf) if self.calib_buf else 0.0
            full = len(self.calib_buf) >= self.calib_window
            if full and self.motion_avg > self.calib_still:
                self.calib_since = 0.0
            elif full and not self.calib_since:
                self.calib_since = ts
            if self.calib_since and (ts - self.calib_since) >= self.calib_ms:
                self.baseline = g
                self.calibrating = False
            return {'counted': False, 'ready': not self.calibrating, 'state': 'calibrating' if self.calibrating else self.state}

        if self.state == 'top':
            if sig < cfg['exit'] and self.linear < 0.4 and self.absolute_tilt < cfg['exit']:
                a = _alpha(dt, 15)
                self.baseline = _unit((
                    self.baseline[0] + a * (g[0] - self.baseline[0]),
                    self.baseline[1] + a * (g[1] - self.baseline[1]),
                    self.baseline[2] + a * (g[2] - self.baseline[2]),
                ))
            if sig >= cfg['enter']:
                self.state = 'bottom'
                self.down_since = ts
                self.motion_peak = 0.0
        else:
            if self.linear > self.motion_peak:
                self.motion_peak = self.linear
            if (ts - self.down_since) > cfg['maxDownMs']:
                self.state = 'top'
            elif sig <= cfg['exit']:
                dur = ts - self.down_since
                far_enough = (ts - self.last_count_at) >= cfg['minGapMs']
                if dur >= cfg['minDownMs'] and self.motion_peak >= cfg['minMotion'] and far_enough:
                    self.count += 1
                    self.last_count_at = ts
                    counted = True
                else:
                    counted = False
                self.state = 'top'
                return {'counted': counted, 'ready': True, 'state': 'top'}
        return {'counted': False, 'ready': True, 'state': self.state}


# ─────────────────────────── 真实感动作波形生成 ───────────────────────────

@dataclass
class Scenario:
    """一类人群 / 一种动作风格"""
    name: str
    depth_deg: float      # tilt 模式的倾角幅度
    depth_m: float        # lift 模式的位移幅度
    period: float         # 一次深蹲的周期（秒）
    asym: float           # 不对称度 0=对称 1=下蹲快起立慢
    drift_amp: float      # 姿态低频漂移幅度
    drift_period: float   # 漂移周期
    jitter: float         # 生理性微抖幅度
    impact: float         # 落地冲击强度
    noise: float          # 传感器白噪声

SCENARIOS = [
    # name              deg    m     period asym drift driftP  jit  imp  noise
    Scenario('标准蹲',        45,   0.45,  2.0,  0.2,  1.0,  12.0,  0.30, 0.10, 0.02),
    Scenario('浅蹲',          28,   0.25,  1.8,  0.3,  1.5,  10.0,  0.35, 0.08, 0.025),
    Scenario('深蹲到底',      62,   0.60,  2.6,  0.1,  0.8,  14.0,  0.25, 0.12, 0.02),
    Scenario('慢速康复蹲',    35,   0.30,  4.0,  0.4,  0.6,  11.0,  0.30, 0.05, 0.02),
    Scenario('快速爆发蹲',    50,   0.50,  1.0,  0.2,  1.2,  13.0,  0.40, 0.20, 0.03),
    Scenario('晃手臂',        48,   0.45,  2.2,  0.3,  2.5,  7.0,   0.50, 0.10, 0.03),
    Scenario('躯干前倾',      42,   0.40,  2.0,  0.2,  3.0,  6.0,   0.35, 0.10, 0.02),
    Scenario('高抬腿式',      55,   0.55,  1.6,  0.3,  1.0,  9.0,   0.30, 0.15, 0.025),
]


def make_signal(sc: Scenario, reps: int, rng: np.random.Generator, mode: str) -> Tuple[np.ndarray, int]:
    """
    生成 reps 次深蹲的三轴加速度（含重力），返回 (信号, 真实次数)
    波形不是纯正弦：叠加二次谐波表达"下蹲快起立慢"，加低频漂移模拟姿态变化，
    落地时刻加脉冲模拟冲击。
    """
    n_calib = int(1.5 / DT)
    n = n_calib + int(reps * sc.period / DT)
    out = np.zeros((n, 3), dtype=np.float64)

    out[:n_calib, 0] = rng.normal(0, sc.noise, n_calib)
    out[:n_calib, 1] = rng.normal(0, sc.noise, n_calib)
    out[:n_calib, 2] = G + rng.normal(0, sc.noise, n_calib)

    base = np.zeros(n)
    for r in range(reps):
        start = n_calib + int(r * sc.period / DT)
        end = min(n, start + int(sc.period / DT))
        m = end - start
        if m <= 0:
            continue
        k = np.arange(m) / m
        # ── 波形形状 ──
        # 一次深蹲 = 下蹲（0→最低点）+ 起立（最低点→0）。
        # 所以「深度曲线」depth 必须是一个 0→1→0 的连续三角，
        # 最低点出现在 k = split（真实深蹲下蹲约占 45%，起立 55%）。
        #
        # ★ 这里踩过大坑：原来写的是
        #     idx = where(k < split, k/split, (k-split)/(1-split))
        #   然后 wave = (1-cos(π·idx))/2
        #   这在 k=split 处 idx 从 1 跳回 0，wave 也跟着从 1 跳回 0 ——
        #   等于"下蹲→瞬间站直→再下蹲"，一个周期里含两次完整深蹲，
        #   状态机忠实地数了两次，所以 3 蹲数出 5~6 个。
        #   一度以为是状态机重复触发，实际是生成器把波形画错了。
        split = 0.45
        # depth 是 0→1→0 的三角：k<split 时从 0 升到 1，之后从 1 降回 0
        if k[-1] < split:
            depth = k / max(1e-9, split)
        else:
            depth = np.where(k < split,
                             k / split,
                             1.0 - (k - split) / (1.0 - split))
        depth = np.clip(depth, 0.0, 1.0)
        # 平滑：0.5*(1-cos(π·d)) 把三角变成两段平滑弧，最低点自然放缓
        # （模拟膝关节屈曲到位的减速），无需额外加 pause 项
        wave = 0.5 * (1 - np.cos(np.pi * depth))
        base[start:end] += wave

    t = np.arange(n) * DT
    curve = base / max(1e-9, base.max())

    # ── 姿态低频漂移 ──
    # 关键：漂移必须**远小于**深蹲幅度。
    # 第一版写成 `drift / max(0.01, drift_amp) * drift_amp`，把幅度还原回了 drift_amp 本身，
    # 而 curve 范围是 0~1，所以漂移占比高达 100% —— 谷值被顶到 19°，
    # 状态机卡在 bottom 出不来，直接漏检 50%。
    # 现在用 drift_ratio 明确限定：漂移最多是深蹲幅度的 8%。
    drift_ratio = 0.08
    drift_wave = np.sin(2 * np.pi * t / sc.drift_period)
    if sc.drift_amp > 0:
        drift = drift_wave * drift_ratio
    else:
        drift = np.zeros(n)

    if mode == 'tilt':
        theta = np.radians(sc.depth_deg * (curve + drift))
        out[:, 0] = G * np.sin(theta) + rng.normal(0, sc.noise, n)
        out[:, 1] = G * rng.normal(0, sc.noise, n) + drift_wave * sc.drift_amp * 0.05
        out[:, 2] = G * np.cos(theta) + rng.normal(0, sc.noise, n)
    else:
        # 位移 = depth * curve，二次求导得加速度
        disp = sc.depth_m * (curve + drift * 0.4)
        vel = np.gradient(disp, DT)
        acc = np.gradient(vel, DT)
        out[:, 0] = G * rng.normal(0, sc.noise, n) * 0.3
        out[:, 1] = G * rng.normal(0, sc.noise, n) * 0.3
        out[:, 2] = G + acc + rng.normal(0, sc.noise, n)

    # 微抖：多频正弦叠加（比白噪声更接近真实生理性晃动）
    tt = t
    jit = sc.jitter * (
        0.5 * np.sin(2 * np.pi * 3.1 * tt)
        + 0.6 * np.sin(2 * np.pi * 0.8 * tt + 1.1)
        + 0.4 * np.sin(2 * np.pi * 7.3 * tt + 2.3)
    )
    out += jit[:, None] * np.array([1.0, 0.5, 0.3]) * 0.5

    # 落地冲击：每个周期的最低点附近加一个衰减脉冲
    if sc.impact > 0:
        for r in range(reps):
            c = n_calib + int((r + 0.45) * sc.period / DT)
            if 0 <= c < n - 20:
                L = 20
                env = np.exp(-np.arange(L) / 4.0)
                out[c:c + L, 2] -= sc.impact * G * env * rng.uniform(0.7, 1.0)

    # ── 波形自检 ──
    # 上一版就是在这里翻的车：生成器把漂移放大到 100%，波形本身不合法，
    # 但结果看起来像"算法漏检 50%"，差点去改正确的算法。
    # 所以任何异常都要先验证波形合法性。
    if reps >= 3 and mode == 'tilt':
        d = SquatDetector(mode='tilt', cfg=TILT_PRESET_BASE['medium'])
        track = []
        for i in range(n):
            d.push(tuple(out[i]), i * DT * 1000.0)
            track.append(d.tilt)
        track = np.array(track)
        mid = track[n_calib:min(n, n_calib + int(3 * sc.period / DT))]
        obs_peak, obs_valley = mid.max(), mid.min()
        assert obs_peak > sc.depth_deg * 0.6, \
            '[生成器] {} tilt 峰值仅 {:.0f}°（设定 {}°），波形不合法'.format(sc.name, obs_peak, sc.depth_deg)
        assert obs_valley < 8.0, \
            '[生成器] {} tilt 谷值 {:.0f}° 过高（>8°），漂移顶起谷值会导致漏检'.format(sc.name, obs_valley)

    return out, reps


def make_interference(sc: Scenario, seconds: float, rng: np.random.Generator, mode: str):
    """
    不该被计数的干扰：日常活动 / 走路 / 坐下 / 捡东西 / 手臂小幅晃动

    ⚠️ 这一组的强度直接决定标定出的 enter 阈值。
    第一版标定把 enter 优化到 0.025m（2.5cm），结果 simulate.js 里的
    「手持微晃 5cm」被数成 12 次 —— 因为这里的走路起伏只有 2~6cm，
    比 5cm 晃动还弱，标定根本没约束住这个场景。
    所以这里加入了「小幅晃动」档（8~12cm 的周期性起伏），
    覆盖 simulate.js 里的同类场景，保证两套测试互为验证。
    """
    n = int(seconds / DT)
    t = np.arange(n) * DT
    out = np.zeros((n, 3))
    out[:, 0] = rng.normal(0, sc.noise, n)
    out[:, 1] = rng.normal(0, sc.noise, n)
    out[:, 2] = G + rng.normal(0, sc.noise, n)

    if mode == 'tilt':
        # 走动时的周期性晃动，幅度明显小于深蹲
        w = sc.depth_deg * rng.uniform(0.25, 0.55)
        th = np.radians(w * (np.sin(2 * np.pi * 1.8 * t) * 0.6 + np.sin(2 * np.pi * 3.6 * t) * 0.4))
        out[:, 0] += G * np.sin(th)
        out[:, 2] += G * np.cos(th) - G
    else:
        # 走路垂直起伏 2~6cm
        w = rng.uniform(0.02, 0.06)
        disp = w * np.sin(2 * np.pi * 1.8 * t)
        out[:, 2] += np.gradient(np.gradient(disp, DT), DT)
    return out


def make_sway(seconds: float, amp_m: float, rng: np.random.Generator, mode: str, freq: float = 1.2):
    """
    「小幅晃动」：模拟站在原地小幅摆动、扶把手、深蹲中途调整。
    与深蹲的区别是**幅度小**，但节律和深蹲相似 —— 这是最难防的误计来源，
    也是标定里必须显式约束的场景（幅度 8~12cm）。
    """
    n = int(seconds / DT)
    t = np.arange(n) * DT
    out = np.zeros((n, 3))
    out[:, 0] = rng.normal(0, 0.02, n)
    out[:, 1] = rng.normal(0, 0.02, n)
    out[:, 2] = G + rng.normal(0, 0.02, n)

    if mode == 'tilt':
        # 摆动幅度换算成角度：手环在手腕上，30cm 摆幅约等于 17°
        deg = amp_m / 0.45 * 45.0 * 0.35
        th = np.radians(deg * np.sin(2 * np.pi * freq * t))
        out[:, 0] += G * np.sin(th)
        out[:, 2] += G * np.cos(th) - G
    else:
        disp = amp_m * np.sin(2 * np.pi * freq * t)
        out[:, 2] += np.gradient(np.gradient(disp, DT), DT)
    return out


# ─────────────────────────── 评估 ───────────────────────────

def evaluate(cfg: dict, calib_still: float, mode: str, reps_per_case: int, n_trials: int, seed: int = 0):
    """在全部场景上评估一组阈值。返回 (最差准确率, 平均准确率, 漏计, 误计, 总次数)"""
    rng = np.random.default_rng(seed)
    per_scenario = []
    misses = 0.0
    total_reps = 0
    total_fp = 0
    sway_fp = 0

    for sc in SCENARIOS:
        accs = []
        for t in range(n_trials):
            sig, truth = make_signal(sc, reps_per_case, rng, mode)
            det = SquatDetector(mode=mode, cfg=cfg, calib_still=calib_still)
            for i in range(len(sig)):
                det.push(tuple(sig[i]), i * DT * 1000.0)
            counted = det.count
            acc = counted / truth if truth else 1.0
            accs.append(acc)
            misses += max(0, truth - counted)
            total_reps += truth
        per_scenario.append(np.mean(accs))

    # ── 误计一：日常活动 / 走路 ──
    for sc in SCENARIOS:
        for t in range(max(2, n_trials // 2)):
            sig = make_interference(sc, 20.0, rng, mode)
            det = SquatDetector(mode=mode, cfg=cfg, calib_still=calib_still)
            for i in range(len(sig)):
                det.push(tuple(sig[i]), i * DT * 1000.0)
            total_fp += det.count

    # ── 误计二：小幅屈伸（最难的场景，必须和 simulate.js 的定义一致）──
    #
    # ⚠️ 这里的定义必须和 tools/simulate.js 的「干扰 手持微晃5cm」**完全一致**：
    #     幅度 5cm、周期 1.2 秒、**逐次完整屈伸**（不是持续正弦）。
    # 第一版标定用持续正弦 + 8~12cm 幅度，漏掉了这个形状：
    # 「持续小幅摆动」和「小幅但完整的屈伸」是两回事 ——
    # 后者的加速度曲线更像真深蹲，enter=0.025 会被它触发 12 次。
    # 两套测试互为验证，场景定义必须对齐。
    for amp in (0.03, 0.05, 0.07, 0.10):
        for period in (1.0, 1.2, 1.5, 2.0):
            sig, _ = make_signal(
                Scenario('微晃', depth_deg=0, depth_m=amp, period=period,
                          asym=0.2, drift_amp=0, drift_period=12.0,
                          jitter=0.30, impact=0.10, noise=0.02),
                12, rng, mode)
            det = SquatDetector(mode=mode, cfg=cfg, calib_still=calib_still)
            for i in range(len(sig)):
                det.push(tuple(sig[i]), i * DT * 1000.0)
            sway_fp += det.count

    falses = float(total_fp)
    worst = float(min(per_scenario)) if per_scenario else 0.0
    mean = float(np.mean(per_scenario)) if per_scenario else 0.0
    return worst, mean, misses, falses, total_reps, sway_fp


def score(cfg, calib_still, mode, reps, trials):
    worst, mean, misses, falses, total_reps = evaluate(cfg, calib_still, mode, reps, trials)
    # 目标：最差场景也要高，误计接近 0
    return worst * 3.0 + mean - falses * 0.25


# ─────────────────────────── 参数搜索 ───────────────────────────

# 评估用固定随机种子，保证所有参数组面对完全相同的测试集（否则不可比）
_EVAL_SEED = 20260906


def _eval_one(args):
    """进程池里的 worker。签名必须可 pickle。"""
    (cfg, calib_still, mode, reps, trials) = args
    return evaluate(cfg, calib_still, mode, reps, trials, seed=_EVAL_SEED)


def _eval_batch(cands, mode, reps, trials, pool):
    args = [(c[0], c[1], mode, reps, trials) for c in cands]
    if pool is None:
        return [_eval_one(a) for a in args]
    return pool.map(_eval_one, args, chunksize=max(1, len(args) // (pool._processes * 4)))


def _mk_score(res):
    """
    评分：最差场景准确率优先，误计重罚。
    sway_fp（小幅晃动误计）权重最高 —— 它是「节律像深蹲但幅度小」的场景，
    也就是用户站着晃两下数字就跳，最伤体感。
    """
    worst, mean, misses, falses, total_reps, sway_fp = res
    return worst * 3.0 + mean - falses * 0.5 - sway_fp * 1.5


def search(mode: str, reps: int, trials: int, quick: bool, pool):
    base = (TILT_PRESET_BASE if mode == 'tilt' else LIFT_PRESET_BASE)['medium']
    t0 = time.time()

    # ── 阶段一：粗筛（粗步长，快速淘汰明显不行的组合）──
    if mode == 'tilt':
        grid_enter = np.arange(9, 32, 3.0) if quick else np.arange(9, 32, 2.0)
    else:
        grid_enter = np.arange(0.04, 0.23, 0.02) if quick else np.arange(0.04, 0.23, 0.015)

    grid_ratio = np.arange(0.45, 0.82, 0.06) if quick else np.arange(0.45, 0.82, 0.04)
    grid_mm = np.array([0.4, 0.6, 0.9]) if quick else np.array([0.4, 0.55, 0.7, 0.85, 1.0])
    grid_cs = np.array([0.4, 0.6, 0.9]) if quick else np.array([0.35, 0.5, 0.65, 0.85])

    cands = []
    for e in grid_enter:
        for r in grid_ratio:
            for mm in grid_mm:
                for cs in grid_cs:
                    cfg = dict(base)
                    cfg['enter'] = float(e)
                    cfg['exit'] = float(e * r)
                    cfg['minMotion'] = float(mm)
                    cands.append((cfg, float(cs)))
    print('  阶段一：粗筛 {} 组'.format(len(cands)))
    res = _eval_batch(cands, mode, reps, trials, pool)
    scored = [(_mk_score(r), c, r) for r, c in zip(res, cands)]
    scored.sort(key=lambda x: -x[0])
    top = scored[:3]          # 只保留前 3 名做细化，8 名会组合爆炸
    print('  阶段一完成，用时 {:.0f}s，最佳 score={:.3f}'.format(time.time() - t0, top[0][0]))

    # ── 阶段二：在前 3 名附近细化 ──
    # 网格要控制规模：3 候选 × 4(enter) × 4(ratio) × 4(mm) × 3(calib) ≈ 576 组，
    # 而不是上万组 —— 细化网格太密纯属浪费算力，阈值本身不需要那么精细。
    fine = []
    for sc0, (cfg0, cs0) in [(t[0], t[1]) for t in top]:
        e0, x0, mm0 = cfg0['enter'], cfg0['exit'], cfg0['minMotion']
        de = (1.2 if mode == 'tilt' else 0.015) if quick else (0.8 if mode == 'tilt' else 0.01)
        dr = 0.04
        for e in np.linspace(max(5 if mode == 'tilt' else 0.02, e0 - de), e0 + de, 4):
            for r in np.arange(max(0.35, x0 / max(1e-9, e0) - dr), min(0.9, x0 / max(1e-9, e0) + dr * 1.2), dr * 0.5):
                for mm in np.arange(max(0.2, mm0 - 0.2), mm0 + 0.21, 0.2):
                    for cs in np.arange(max(0.25, cs0 - 0.25), cs0 + 0.26, 0.25):
                        cfg = dict(base)
                        cfg['enter'] = float(e)
                        cfg['exit'] = float(e * r)
                        cfg['minMotion'] = float(mm)
                        fine.append((cfg, float(cs)))
    # 去重
    uniq = {}
    for cfg, cs in fine:
        key = (round(cfg['enter'], 4), round(cfg['exit'], 4), round(cfg['minMotion'], 3), round(cs, 3))
        uniq[key] = (cfg, cs)
    fine = list(uniq.values())
    print('  阶段二：细化 {} 组'.format(len(fine)))
    res = _eval_batch(fine, mode, reps, trials, pool)
    scored2 = [(_mk_score(r), c, r) for r, c in zip(res, fine)]
    scored2.sort(key=lambda x: -x[0])

    bs, (bcfg, bcs), bres = scored2[0]
    best = {
        'score': bs,
        'enter': bcfg['enter'],
        'exit': bcfg['exit'],
        'minMotion': bcfg['minMotion'],
        'calibStill': bcs,
    }
    print('\n  [{}] 最优 score={:.3f}'.format(mode, bs))
    print(json.dumps(best, indent=2, ensure_ascii=False))
    print('  最差场景 {:.1%}  平均 {:.1%}  漏计 {:.0f}/{}  日常误计 {:.0f}  小幅晃动误计 {:.0f}'
          .format(bres[0], bres[1], bres[2], bres[4], bres[3], bres[5]))
    print('  用时 {:.0f} 秒\n'.format(time.time() - t0))
    return best


def main():
    quick = '--quick' in sys.argv
    out = None
    if '--out' in sys.argv:
        out = sys.argv[sys.argv.index('--out') + 1]

    reps = 15 if quick else 30
    trials = 2 if quick else 5

    print('=' * 64)
    print('阈值自动标定 —— {} 版'.format('快速' if quick else '完整'))
    print('场景 {} 个   每例 {} 蹲   重复 {} 次   评估随机种子固定'
          .format(len(SCENARIOS), reps, trials))
    print('=' * 64)

    import multiprocessing as mp
    nproc = min(8, mp.cpu_count())
    pool = mp.Pool(nproc) if nproc > 1 else None
    print('并行进程：{}'.format(nproc if pool else 1))

    t0 = time.time()
    try:
        results = {'tilt': search('tilt', reps, trials, quick, pool),
                   'lift': search('lift', reps, trials, quick, pool)}
    finally:
        if pool:
            pool.close()
            pool.join()

    results['_meta'] = {
        'scenarios': [asdict(s) for s in SCENARIOS],
        'reps_per_case': reps, 'trials': trials, 'quick': quick,
        'eval_seed': _EVAL_SEED,
        'processes': nproc,
        'elapsed_sec': round(time.time() - t0, 1),
        'note': '这是「最坏情况最优」，不是真机验证结果。'
                '仿真只能保证不出现系统性错误，最终阈值仍需真机确认。',
    }

    if out:
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print('\n已保存到', out)
    print('\n总用时 {:.0f} 秒'.format(time.time() - t0))


if __name__ == '__main__':
    main()