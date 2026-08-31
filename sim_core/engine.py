"""引擎入口：初始化创始村 + 主循环（纯 sim-core，无 IO）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .params import Params
from .person import Person
from .rng import Streams
from .village import Village, T_TIME_LIMIT, T_POP_CAP


@dataclass
class SimResult:
    termination: str
    extinct_year: int | None
    extinct_reasons: list[str]
    history: list[dict]
    people: dict[int, Person]
    events: list[str]
    final_year: int
    total_pop_ever: int
    era_bands: dict[int, Any] = None     # band -> EraParams
    max_lineage_gen: int = 0             # 血脉最大世代（始祖=0）
    params: Params = None


def seed_village(params: Params, streams: Streams,
                 founder_surname: str | None = None,
                 founder_given: str | None = None) -> Village:
    """创始村：focus 夫妻 + 无本地祖先的村庄人口。

    founder_surname/given：玩家自定义血脉始祖姓名（复姓可选，长度校验在上游）。
    """
    rng = streams["birth"]
    nrng = streams["name"]
    v = Village(params, streams)
    year = params.start_year
    from .namer import name_person

    def fresh_person(sex: str, age: int) -> Person:
        p = Person(id=v.next_id, father_id=None, mother_id=None,
                   birth_year=year - age, sex=sex, founder=True)
        p.ln_fertility = float(rng.normal(0.0, 0.2))
        p.ln_vulnerability = float(rng.normal(0.0, 0.2))
        p.name = name_person(nrng, sex, params.era_band(year - age), None)
        v.next_id += 1
        v.add_person(p)
        return p

    n = params.founder_village_size
    n_m = n // 2
    n_f = n - n_m
    for i in range(n_m):
        age = int(rng.integers(0, 60))
        fresh_person("M", age)
    for i in range(n_f):
        age = int(rng.integers(0, 60))
        fresh_person("F", age)

    # 焦点创始夫妻：标记父系血脉（丈夫 = 血脉始祖）
    fh = fresh_person("M", 20)
    fw = fresh_person("F", 18)
    fh.lineage = True
    if founder_surname:
        # 玩家自定义始祖姓名；surname_len 决定后代继承几个字的姓（支持复姓）
        fh.name = founder_surname + (founder_given or "")
        fh.surname_len = len(founder_surname)
    fh.spouse_id = fw.id
    fw.spouse_id = fh.id
    return v


def run(params: Params, seed: int,
        founder_surname: str | None = None, founder_given: str | None = None) -> SimResult:
    streams = Streams(seed)
    v = seed_village(params, streams,
                     founder_surname=founder_surname, founder_given=founder_given)

    while True:
        if v.extinct_year is not None:
            v.termination = v.termination or "EXTINCT_BLOOD"
            break
        if v.year >= params.end_year:
            v.termination = T_TIME_LIMIT
            break
        if v.total_pop_ever > params.pop_cap_total:
            v.termination = T_POP_CAP
            break
        v.step_year()
        v.year += 1

    return SimResult(
        termination=v.termination or T_TIME_LIMIT,
        extinct_year=v.extinct_year,
        extinct_reasons=v.extinct_reasons,
        history=v.history,
        people=v.people,
        events=v.events,
        final_year=v.year,
        total_pop_ever=v.total_pop_ever,
        era_bands=dict(v.era_bands),
        max_lineage_gen=_lineage_depth(v),
        params=params,
    )


def _lineage_depth(v: Village) -> int:
    """血脉最大世代：始祖=0，沿父链数步数。"""
    lin = [p for p in v.people.values() if p.lineage]
    depth = {p.id: None for p in lin}
    people = v.people

    def d(pid: int) -> int:
        if depth.get(pid) is not None:
            return depth[pid]
        p = people[pid]
        val = 0 if (p.father_id is None or not people[p.father_id].lineage) else d(p.father_id) + 1
        depth[pid] = val
        return val

    return max((d(p.id) for p in lin), default=0)
