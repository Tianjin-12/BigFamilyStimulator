"""Person 数据模型（DESIGN.md 5.1）。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Person:
    id: int
    father_id: int | None
    mother_id: int | None
    birth_year: int
    sex: str                     # 'M' | 'F'
    death_year: int | None = None
    spouse_id: int | None = None
    # 可遗传属性（出生定型，对数空间中心 0 → 乘数 1.0）
    ln_fertility: float = 0.0
    ln_vulnerability: float = 0.0
    fertility_cap: int | None = None   # 终身子女上限（女性定型；成婚时按夫妻乘数重定）
    children_born: int = 0
    migrated_out: bool = False          # 外迁（移出模拟）
    founder: bool = False               # 创始村元老（无本地祖先）
    lineage: bool = False               # 焦点家族父系血脉标记（沿父链传播）
    name: str = ""                      # 姓（继承父）+ 名（时期带性别池）
    surname_len: int = 1                # 姓氏长度（1=单字姓，2=复姓）；继承用
    # M3 预留：genes: {locus: [allele, allele]}
    genes: dict = field(default_factory=dict)

    def age(self, year: int) -> int:
        return year - self.birth_year

    def alive(self, year: int) -> bool:
        return self.death_year is None and not self.migrated_out and self.birth_year <= year

    @property
    def dead_or_gone(self) -> bool:
        return self.death_year is not None or self.migrated_out
