"""参数表：DESIGN.md 第 10 节默认值的代码化。全部可调。"""

from __future__ import annotations

from dataclasses import dataclass, field, replace


@dataclass(frozen=True)
class EraParams:
    """一个时期带（10 年）的参数。每带随机抽取，AR(1) 相邻自相关。"""

    birth_prob: float          # 生育年概率基准
    sex_ratio: float           # 男:女 出生比（105.0 表示 105:100）
    infant_mortality: float    # 婴儿夭折率
    adult_mortality_scale: float  # 成人死亡率曲线乘数（1.0=锚点曲线）
    carrying_capacity: int     # K：村庄承载上限
    marriage_willingness: float   # 双方成婚意愿概率
    hardship: float = 0.05     # 时艰度 0-1：驱动常态外迁率与迁出潮


@dataclass(frozen=True)
class Params:
    # —— 世界 ——
    start_year: int = 0
    end_year: int = 1000               # TIME_LIMIT 上限
    pop_cap_total: int = 50_000        # POP_CAP 累计人口算力上限
    founder_village_size: int = 300    # 创始村初始人口（无本地祖先）

    # —— 婚姻 ——
    min_marry_age: int = 16
    couple_age_gap: int = 10           # 双向年龄差上限
    ban_kin_side: int = 2              # 禁婚旁系亲等 k；float('inf') = 封闭内婚
    remarriage: bool = False

    # —— 生育 ——
    female_fertile_min: int = 16
    female_fertile_max: int = 45
    parity_cap_base: int = 5           # 终身子女上限基准

    # —— 时代参数（时期带抽样用） ——
    band_years: int = 10
    era_rho: float = 0.6               # AR(1) 自相关
    # 抽样中心与波动幅度（对数尺度）
    era_log_birth_mean: float = -1.386  # ln(0.25)
    era_log_birth_sd: float = 0.15
    era_sex_ratio_mean: float = 105.0
    era_sex_ratio_sd: float = 2.0
    era_infant_mort_mean: float = 0.15   # 抽样中心：古代偏高，随年份衰减见下
    era_infant_mort_modern: float = 0.005
    era_adult_mort_scale_mean: float = 1.0
    era_adult_mort_scale_sd: float = 0.1
    era_k_mean: int = 600
    era_k_sd: float = 60.0
    era_willingness_mean: float = 0.9
    era_willingness_sd: float = 0.05
    infant_mort_halfway_year: int = 600  # 夭折率中心从古到今线性减半的过渡年
    # —— 时代锚点模式：transition=古代→现代过渡（默认），ancient=恒古代，modern=恒现代 ——
    anchor_mode: str = "transition"      # transition | ancient | modern
    # —— 时艰与外迁（DESIGN.md 1.2 的具象化） ——
    era_hardship_mean: float = 0.15
    era_hardship_sd: float = 0.10
    base_emigration_rate: float = 0.002  # 常态年外迁率（时艰度加成，16-40 岁）
    hardship_wave_prob: float = 0.05     # 每年触发迁出潮的概率（×时艰度）
    hardship_wave_fraction: float = 0.08 # 迁出潮规模：占 16-40 岁人口比例（×时艰度）

    # —— 遗传 ——
    inherit_sigma: float = 0.3         # ln(child) = mean(ln parents) + N(0, σ)
    fertility_base: float = 1.0        # fertility 乘数中心（对数空间 0）
    vulnerability_base: float = 1.0

    # —— 迁移 ——
    migrate_min_fraction: float = 0.25  # 人口 < K/4 补移民

    # —— 行为开关（默认关闭 = 旧行为，保证同 seed 逐字节复现） ——
    matchmaking_per_year: int | None = None    # 每年撮合对数上限；None = 单年全配完（旧行为）
    lineage_emigration_protect: float = 1.0    # 血脉男丁外迁权重乘数；1.0 = 均匀抽取（旧行为），<1 抑制血脉外迁
    # 风物叙事层（天时/送老/冠礼/里程碑/杂闻）：纯事件输出，只读模拟状态，
    # 只消耗独立 flavor 子流 → 开关与否均不改变模拟结果
    flavor_events: bool = True

    # —— 派生 ——
    def era_band(self, year: int) -> int:
        return year // self.band_years


def default_params() -> Params:
    return Params()


def scale_for(params: Params, **overrides) -> Params:
    """生成参数变体（runner 实验用）。"""
    return replace(params, **overrides)


# —— 死亡率曲线（锚点：古代/现代两档，时期乘数插值） ——
# age_bucket -> 年死亡概率。简化 Gompertz 型：古代高夭折+高老年死、现代低。
_ADULT_MORTALITY_ANCIENT = {
    0: 0.15, 1: 0.06, 5: 0.025, 10: 0.018, 15: 0.020,
    20: 0.025, 30: 0.035, 40: 0.050, 50: 0.080, 60: 0.130,
    70: 0.220, 80: 0.380, 90: 0.550, 100: 0.750, 110: 0.920, 120: 1.0,
}
_ADULT_MORTALITY_MODERN = {
    0: 0.005, 1: 0.0005, 5: 0.0002, 10: 0.0002, 15: 0.0003,
    20: 0.0005, 30: 0.001, 40: 0.002, 50: 0.005, 60: 0.012,
    70: 0.030, 80: 0.080, 90: 0.200, 100: 0.450, 110: 0.800, 120: 1.0,
}


def bucket_mortality(buckets: dict[int, float], age: int) -> float:
    """年龄落入的 bucket 死亡率（bucket 起点取最近不大于 age 的键）。"""
    keys = sorted(buckets)
    lo = keys[0]
    for k in keys:
        if k <= age:
            lo = k
    return buckets[lo]


def mortality_anchor(age: int, t_frac: float, mode: str = "transition") -> float:
    """死亡率锚点插值。t_frac: 0=纯古代，1=纯现代。mode 决定时代背景。"""
    a = bucket_mortality(_ADULT_MORTALITY_ANCIENT, age)
    if mode == "ancient":
        return a
    m = bucket_mortality(_ADULT_MORTALITY_MODERN, age)
    if mode == "modern":
        return m
    return a + (m - a) * t_frac


def ancients() -> dict[int, float]:
    return dict(_ADULT_MORTALITY_ANCIENT)


def moderns() -> dict[int, float]:
    return dict(_ADULT_MORTALITY_MODERN)
