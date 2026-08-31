"""后端起名：真实遗传链。

- 姓：继承父亲（父姓→子姓，真实谱系传播）；无父者（创始者/移民）从姓氏库按权重抽
- 名：按出生时期带从对应性别池抽取（sim_core/names/{male,female}/band_NNN.txt）
- RNG：独立 "name" 子流——改名字库不影响其他子流的复现性

库文件格式：每行一个名字；# 开头为注释。池小（~20）时允许重名——
现实村庄里同名的多的是，且姓+名组合的辨识度足够。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

NAMES_DIR = Path(__file__).parent / "names"


@lru_cache(maxsize=1)
def _surnames() -> list[tuple[str, int]]:
    """[(姓, 权重)]，按权重展开成轮盘数组缓存在调用侧。"""
    out = []
    for line in (NAMES_DIR / "surnames.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        out.append((parts[0], int(parts[1]) if len(parts) > 1 else 1))
    return out


@lru_cache(maxsize=512)
def _given_pool(band: int, sex: str) -> tuple[str, ...]:
    path = NAMES_DIR / sex / f"band_{band:03d}.txt"
    if not path.is_file():
        # 越界带（end_year 超过库覆盖）退回最后一池
        last = max(int(p.stem.split("_")[1]) for p in (NAMES_DIR / sex).glob("band_*.txt"))
        path = NAMES_DIR / sex / f"band_{last:03d}.txt"
    names = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            names.append(line)
    return tuple(names)


def draw_surname(rng, exclude: set[str] | None = None) -> str:
    """创始者/移民抽姓。exclude 用于村庄多样性（暂不用，同姓可共存）。"""
    pairs = _surnames()
    names = [n for n, _ in pairs]
    weights = [w for _, w in pairs]
    return str(rng.choice(names, p=[w / sum(weights) for w in weights]))


def draw_given(rng, band: int, sex: str) -> str:
    pool = _given_pool(band, "male" if sex == "M" else "female")
    return str(pool[rng.integers(len(pool))])


def name_person(rng, sex: str, band: int, father_surname: str | None) -> str:
    """姓 = 父姓（无父抽新姓），名 = 时期带性别池抽取。"""
    surname = father_surname if father_surname else draw_surname(rng)
    return surname + draw_given(rng, band, sex)
