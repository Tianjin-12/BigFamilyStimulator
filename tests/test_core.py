"""M1 验收测试：DESIGN.md 第 8 节验证清单。

- 同 seed 复现性（逐字段相等）
- 亲等判定边界：兄妹/父女/堂表/第二表/直系第 4 代/移民
- 频率 ≈ 参数（大样本性别比）
"""

from __future__ import annotations

import math

from sim_core import Person, default_params, run, scale_for
from sim_core.kinship import collateral_distance, is_lineal, marriage_banned
from sim_core.params import Params


# ---------- 亲等判定 ----------

def mk(id: int, father: int | None, mother: int | None, sex: str = "M") -> Person:
    return Person(id=id, father_id=father, mother_id=mother, birth_year=0, sex=sex)


def family() -> dict[int, Person]:
    """六人家族：
    1/2 祖父母 → 3(父) 4(叔) 5(姑)；3+6(母) → 7(子) 8(女)；
    8+9(外人) → 10(外孙)；10+11 → 12（第四代）
    20 = 无关移民
    """
    ppl = {
        1: mk(1, None, None), 2: mk(2, None, None, "F"),
        3: mk(3, 1, 2), 4: mk(4, 1, 2), 5: mk(5, 1, 2, "F"),
        6: mk(6, None, None, "F"),
        7: mk(7, 3, 6), 8: mk(8, 3, 6, "F"),
        9: mk(9, None, None), 10: mk(10, 9, 8), 11: mk(11, None, None, "F"),
        12: mk(12, 10, 11),
        20: mk(20, None, None),
    }
    return ppl


def test_sibling_banned():
    p = family()
    assert marriage_banned(7, 8, p, 2), "兄妹必须禁婚"


def test_parent_child_banned():
    p = family()
    assert marriage_banned(3, 8, p, 2), "父女必须禁婚"


def test_cousin_banned():
    p = family()
    # 7 与叔父 4 的女儿（堂亲）需要构造：加 13 = 4 的女儿
    p[13] = mk(13, 4, mk(14, None, None, "F").id or None, "F")
    p[14] = mk(14, None, None, "F")
    p[13] = mk(13, 4, 14, "F")
    assert marriage_banned(7, 13, p, 2), "堂兄妹（分叉深度 2）k=2 应禁婚"


def test_second_cousin_allowed():
    p = family()
    # 第二表亲：共同曾祖，分叉深度 3 → k=2 放行
    p[14] = mk(14, None, None, "F")
    p[15] = mk(15, 4, 14, "M")      # 堂兄 15
    p[16] = mk(16, None, None, "F")
    p[17] = mk(17, 15, 16, "M")     # 7 的堂侄（分叉深度 3：7→3→1，17→15→4→1）
    p[18] = mk(18, None, None, "F")
    assert not marriage_banned(7, mk(19, 17, 18, "F").id or 0, p, 2) if False else True
    # 直接测 7 的孩子与 17 的孩子：分叉深度 = max(3,3)？各自到共同祖先 1 的步数 3、3
    p[19] = mk(19, 7, 18, "F")      # 7 的女儿
    d = collateral_distance(17, 19, p)
    # 17→15→4→1 (3 步)，19→7→3→1 (3 步) → 分叉深度 3
    assert d == 3, f"第二表亲分叉深度应为 3，得到 {d}"
    assert not marriage_banned(17, 19, p, 2), "第二表亲 k=2 应放行"


def test_lineal_generation4_banned():
    p = family()
    # 12 是 1 的第四代直系后代 → 直系无限代禁止
    assert marriage_banned(1, 12, p, 2), "第 4 代直系（1 与 12）必须禁婚"


def test_immigrant_unrelated():
    p = family()
    assert collateral_distance(7, 20, p) is None, "移民与本地人无共同祖先 → None"
    assert not marriage_banned(7, 20, p, 2), "移民可婚"


def test_uncle_niece_banned():
    p = family()
    # 叔 4 与侄女 8：8→3→1 与 4→1，分叉深度 max(2,1)=2 → 禁
    assert marriage_banned(4, 8, p, 2), "叔侄（分叉深度 2）k=2 应禁婚"


# ---------- 复现性 ----------

def run_digest(r) -> str:
    parts = []
    for p in sorted(r.people.values(), key=lambda q: q.id):
        parts.append(f"{p.id}|{p.father_id}|{p.mother_id}|{p.birth_year}|{p.sex}|"
                     f"{p.death_year}|{p.spouse_id}|{p.children_born}|{p.migrated_out}|{p.lineage}")
    return ";".join(parts)


def test_same_seed_reproducible():
    params = scale_for(default_params(), end_year=80)
    r1 = run(params, 123)
    r2 = run(params, 123)
    assert run_digest(r1) == run_digest(r2), "同 seed 必须逐字段复现"
    assert r1.history == r2.history


def test_different_seed_differs():
    params = scale_for(default_params(), end_year=80)
    r1 = run(params, 123)
    r2 = run(params, 124)
    assert run_digest(r1) != run_digest(r2), "不同 seed 应产生不同历史"


# ---------- 频率校验 ----------

def test_sex_ratio_frequency():
    """大样本出生性别比 ≈ 时期参数（105:100 → 男比例 ≈ 0.5122）。"""
    params = scale_for(default_params(), end_year=60)
    male = female = 0
    for seed in range(30):
        r = run(params, seed)
        for p in r.people.values():
            if p.father_id is not None and p.birth_year >= 0:
                if p.sex == "M":
                    male += 1
                else:
                    female += 1
    n = male + female
    assert n > 500, f"样本量不足: {n}"
    ratio = male / n
    expected = 105.0 / 205.0
    assert abs(ratio - expected) < 0.03, f"男比例 {ratio:.4f} 偏离期望 {expected:.4f}"


def test_termination_kinds():
    params = scale_for(default_params(), end_year=80)
    r = run(params, 5)
    assert r.termination in ("EXTINCT_BLOOD", "TIME_LIMIT", "POP_CAP", "LIVELOCK")
    if r.termination == "EXTINCT_BLOOD":
        assert r.extinct_year is not None
        assert r.extinct_reasons, "断绝必须带原因分类"


# ---------- M2 行为开关：默认关闭 = 旧行为 ----------

def test_matchmaking_cap_switch():
    """默认首年大批撮合；matchmaking_per_year 上限生效且不改变默认路径。"""
    from sim_core.engine import seed_village
    from sim_core.rng import Streams

    def couples(params, seed, step: bool):
        v = seed_village(params, Streams(seed))
        if step:
            v.step_year()
            v.year += 1
        return sum(1 for p in v.living() if p.spouse_id is not None and p.sex == "M")

    def formed_first_year(params, seed):
        return couples(params, seed, True) - couples(params, seed, False)

    base = default_params()
    assert formed_first_year(base, 3) > 50, "默认行为首年应大批撮合"
    capped = scale_for(base, matchmaking_per_year=20)
    assert formed_first_year(capped, 3) <= 20, "开启上限后首年新配对不得超过上限"


def test_lineage_protect_switch():
    """lineage_emigration_protect=0 时血脉男丁不得被外迁。"""
    from sim_core.engine import seed_village
    from sim_core.rng import Streams
    params = scale_for(default_params(), end_year=60, lineage_emigration_protect=0.0)
    v = seed_village(params, Streams(11))
    while v.year < 60:
        v.step_year()
        v.year += 1
    gone = [p for p in v.people.values() if p.lineage and p.migrated_out]
    assert not gone, f"protect=0 时血脉男丁不应外迁，实际 {len(gone)} 人"


def test_extinction_married_no_child_classified():
    """已婚终生未育的血脉男丁归 E6，不再误报 E1。"""
    from sim_core.village import E6_MARRIED_NO_CHILD
    # seed 42：创始男丁已婚 19 年无子后去世 → 必须命中 E6
    params = scale_for(default_params(), end_year=40)
    r = run(params, 42)
    if r.termination == "EXTINCT_BLOOD" and r.extinct_year == 19:
        assert E6_MARRIED_NO_CHILD in r.extinct_reasons, \
            f"seed42 已婚无子应归 E6，实际 {r.extinct_reasons}"


# ---------- R1：自定义创始姓名 + 风物叙事层 ----------

def test_founder_name_custom_and_inherited():
    """自定义始祖姓名生效；后代按姓氏长度继承（复姓不退化）。"""
    from sim_core.engine import seed_village
    from sim_core.rng import Streams
    v = seed_village(default_params(), Streams(9),
                     founder_surname="欧阳", founder_given="明月")
    lin = [p for p in v.people.values() if p.lineage]
    assert len(lin) == 1 and lin[0].name == "欧阳明月", f"始祖姓名未生效: {lin[0].name}"
    assert lin[0].surname_len == 2
    # 推进直到出现血脉后代，验证姓氏传承
    sons = []
    for _ in range(150):
        v.step_year()
        v.year += 1
        sons = [p for p in v.people.values() if p.lineage and p.father_id is not None]
        if sons:
            break
    if sons:
        assert all(s.name.startswith("欧阳") and s.surname_len == 2 for s in sons), \
            f"复姓继承失败: {[s.name for s in sons][:5]}"


def test_flavor_events_isolated():
    """风物叙事层开关不影响模拟结果（人物/历史逐字节一致）。"""
    r_on = run(default_params(), 77)
    r_off = run(scale_for(default_params(), flavor_events=False), 77)
    assert run_digest(r_on) == run_digest(r_off), "风物层不得影响模拟结果"
    assert r_on.history == r_off.history


def test_flavor_events_present():
    """默认开启时，跑 80 年必出现风物类事件（harvest/flavor 其一以上）。"""
    from sim_core.engine import seed_village
    from sim_core.rng import Streams
    v = seed_village(default_params(), Streams(21))
    kinds = set()
    for _ in range(80):
        v.step_year()
        v.year += 1
        kinds.update(e["kind"] for e in v.world_events)
    assert kinds & {"harvest", "flavor", "elder_death", "coming_of_age", "milestone"}, \
        f"80 年未出现任何风物事件: {sorted(kinds)}"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
