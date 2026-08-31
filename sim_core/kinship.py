"""亲等判定与禁婚规则（DESIGN.md 第 4 节）。

默认：直系血亲无限代禁止；旁系三代以内禁止（k=2 可调）。
移民/创始者无本地祖先，视为与所有人旁系无关（直系仍真实——他们的后代算）。

亲等口径（对齐法律"三代以内旁系"）：共同祖先到两人的**分叉深度**取 max。
同辈堂/表兄妹：共同祖先是祖辈，各 2 步 → 距离 2 → k=2 时禁。
第二表兄妹：各 3 步 → 距离 3 → k=2 时放行。

亲等缓存：id -> {祖先id: 步数}（含本人:0）。父母身份出生即定不变 → 缓存安全。
"""

from __future__ import annotations

from .person import Person


def ancestor_chain(person_id: int, people: dict[int, Person],
                   cache: dict[int, dict[int, int]] | None = None) -> dict[int, int]:
    """沿父+母两路上溯的全部祖先（含本人）到步数的映射。"""
    if cache is not None and person_id in cache:
        return cache[person_id]
    chain: dict[int, int] = {person_id: 0}
    frontier = [(person_id, 0)]
    while frontier:
        pid, d = frontier.pop()
        p = people.get(pid)
        if p is None:
            continue
        for parent in (p.father_id, p.mother_id):
            if parent is not None and parent not in chain:
                chain[parent] = d + 1
                frontier.append((parent, d + 1))
    if cache is not None:
        cache[person_id] = chain
    return chain


def is_lineal(a: int, b: int, people: dict[int, Person],
              cache: dict[int, dict[int, int]] | None = None) -> bool:
    """b 是否在 a 的直系链上（a 的祖先或后代，无限代）。"""
    if b in ancestor_chain(a, people, cache):
        return True
    return a in ancestor_chain(b, people, cache)


def _fork_depth(anc_a: dict[int, int], anc_b: dict[int, int]) -> int | None:
    """最近共同祖先处的分叉深度 = max(两人到该祖先的步数)。无共同祖先 → None。"""
    common = anc_a.keys() & anc_b.keys()
    if not common:
        return None
    return max(min(anc_a[c] for c in common), min(anc_b[c] for c in common))


def collateral_distance(a: int, b: int, people: dict[int, Person],
                        cache: dict[int, dict[int, int]] | None = None) -> int | None:
    """旁系亲等（分叉深度口径）。无共同祖先 → None（无关）。直系关系 → 0。"""
    anc_a = ancestor_chain(a, people, cache)
    if b in anc_a:
        return 0
    anc_b = ancestor_chain(b, people, cache)
    if a in anc_b:
        return 0
    return _fork_depth(anc_a, anc_b)


def marriage_banned(a: int, b: int, people: dict[int, Person], ban_side_k: int,
                    cache: dict[int, dict[int, int]] | None = None) -> bool:
    """禁婚判定。直系（0）恒禁；旁系分叉深度 ≤ ban_side_k 禁。"""
    d = collateral_distance(a, b, people, cache)
    if d is None:
        return False
    if d == 0:
        return True
    return d <= ban_side_k
