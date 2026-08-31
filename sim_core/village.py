"""村庄状态与年事件流水线（DESIGN.md 第 6 节，顺序固定保证可复现）。

1. 出生判定 → 2. 撮合 → 3. 死亡判定 → 4. 迁移 → 5. 断绝检查
"""

from __future__ import annotations

import math

from .params import EraParams, Params, mortality_anchor
from .person import Person
from .rng import Streams
from .kinship import marriage_banned

# 断绝原因（DESIGN.md 2.1）
E1_NO_MALE_BORN = "E1_no_male_born"
E2_MALE_UNBRED = "E2_male_unbred"
E3_MALE_EARLY_DEATH = "E3_male_early_death"
E4_MALE_MIGRATED = "E4_male_migrated"
E6_MARRIED_NO_CHILD = "E6_married_no_child"

# 断绝原因中文文案（cli 报表与前端共用语义；未知码回退原码展示）
EXTINCT_REASON_TEXT = {
    E1_NO_MALE_BORN: "始终没有男丁出生",
    E2_MALE_UNBRED: "男丁未婚未育",
    E3_MALE_EARLY_DEATH: "男丁早年夭折",
    E4_MALE_MIGRATED: "男丁外迁离村",
    E6_MARRIED_NO_CHILD: "已婚但终生未育",
}

# 终止态（DESIGN.md 第 7 节）
T_EXTINCT_BLOOD = "EXTINCT_BLOOD"
T_TIME_LIMIT = "TIME_LIMIT"
T_POP_CAP = "POP_CAP"
T_LIVELOCK = "LIVELOCK"


class Village:
    def __init__(self, params: Params, streams: Streams):
        self.p = params
        self.rng = streams
        self.people: dict[int, Person] = {}
        self.next_id = 0
        self.year = params.start_year
        self.era_bands: dict[int, EraParams] = {}
        self.total_pop_ever = 0
        self.extinct_year: int | None = None
        self.extinct_reasons: list[str] = []
        self.termination: str | None = None
        self.history: list[dict] = []               # 逐年统计
        self.events: list[str] = []                 # 关键事件日志（血脉相关）
        self._caps: dict = {}                       # 夫妻终身上限缓存
        # 亲等缓存：id -> {祖先id: 步数}（含本人:0）。父母不变，出生即定型 → 缓存安全
        self._anc_cache: dict[int, dict[int, int]] = {}
        # —— 实时查看支持（live server 消费，不影响模拟本身） ——
        # 当年发生的结构级事件：婚/亡/外迁/移民/断绝/时期更替，world-flavor 用
        self.world_events: list[dict] = []
        # 当年变更的人 id 集合（出生/婚/亡/外迁），供前端做增量补丁
        self.pending_deltas: set[int] = set()
        self._era_announced: set[int] = set()
        # 待产男血裔：出生判定在断绝检查前执行，年内即结算，
        # 但若断绝检查提前于次年 births 之间出现空窗，此计数兜底（当前流水线恒为 0）
        self.pending_male_fetuses: int = 0
        # 年度流量（step_year 开始时重置）
        self._born_this_year = 0
        self._died_this_year = 0
        self._flow = {"born": 0, "died": 0, "emigrated": 0, "immigrated": 0, "wave": False}
        # 民生流水累计器（每 5 年汇总播报一条）
        self._vital_acc = None
        # 血脉危急预警锁存：开局即锁（创始之初男丁本就只有 1 人，不预警），
        # 在世男丁 >2 后解锁进入正常边沿监测
        self._lineage_danger_latch = True
        # 人口里程碑档位（首次校准后从此升档播报）
        self._pop_mark = 0

    # ---------- 时期参数 ----------

    def era(self) -> EraParams:
        band = self.p.era_band(self.year)
        if band not in self.era_bands:
            self.era_bands[band] = self._draw_era(band)
        return self.era_bands[band]

    def _draw_era(self, band: int) -> EraParams:
        rng = self.rng["era"]
        rho = self.p.era_rho
        prev = self.era_bands.get(band - 1)
        im_c = self._infant_center()

        if prev is None:
            birth = rng.normal(self.p.era_log_birth_mean, self.p.era_log_birth_sd)
            sr = rng.normal(self.p.era_sex_ratio_mean, self.p.era_sex_ratio_sd)
            im = rng.normal(im_c, im_c * 0.2)
            ams = rng.normal(self.p.era_adult_mort_scale_mean, self.p.era_adult_mort_scale_sd)
            k = int(round(rng.normal(self.p.era_k_mean, self.p.era_k_sd)))
            will = rng.normal(self.p.era_willingness_mean, self.p.era_willingness_sd)
            hard = rng.normal(self.p.era_hardship_mean, self.p.era_hardship_sd)
        else:
            # 生育概率走对数空间 AR（ln 链路），其余线性 AR
            prev_ln_birth = math.log(prev.birth_prob)
            birth = _ar_lin(rng, rho, prev_ln_birth, self.p.era_log_birth_mean, self.p.era_log_birth_sd)
            sr = _ar_lin(rng, rho, prev.sex_ratio, self.p.era_sex_ratio_mean, self.p.era_sex_ratio_sd)
            im = _ar_lin(rng, rho, prev.infant_mortality, im_c, im_c * 0.2)
            ams = _ar_lin(rng, rho, prev.adult_mortality_scale,
                          self.p.era_adult_mort_scale_mean, self.p.era_adult_mort_scale_sd)
            k = int(round(_ar_lin(rng, rho, prev.carrying_capacity,
                                  self.p.era_k_mean, self.p.era_k_sd)))
            will = _ar_lin(rng, rho, prev.marriage_willingness,
                           self.p.era_willingness_mean, self.p.era_willingness_sd)
            hard = _ar_lin(rng, rho, prev.hardship, self.p.era_hardship_mean, self.p.era_hardship_sd)

        k = max(50, k)
        return EraParams(
            birth_prob=math.exp(birth),
            sex_ratio=max(80.0, min(130.0, sr)),
            infant_mortality=min(0.5, max(0.001, im)),
            adult_mortality_scale=max(0.2, ams),
            carrying_capacity=k,
            marriage_willingness=min(0.99, max(0.3, will)),
            hardship=min(1.0, max(0.0, hard)),
        )

    def _infant_center(self) -> float:
        """夭折率中心：按时代锚点模式取值。"""
        p = self.p
        if p.anchor_mode == "ancient":
            return p.era_infant_mort_mean
        if p.anchor_mode == "modern":
            return p.era_infant_mort_modern
        t = (self.year - p.start_year) / max(1, p.end_year - p.start_year)
        halfway = p.infant_mort_halfway_year / max(1, p.end_year - p.start_year)
        frac = min(1.0, t / halfway)
        return p.era_infant_mort_mean + (p.era_infant_mort_modern - p.era_infant_mort_mean) * frac

    # ---------- 人口登记 ----------

    def add_person(self, person: Person) -> None:
        self.people[person.id] = person
        self.total_pop_ever += 1

    def spawn(self, year: int, sex: str, father: Person | None, mother: Person | None,
              rng) -> Person:
        ln_f = self._inherit_ln(father, mother, rng, "ln_fertility")
        ln_v = self._inherit_ln(father, mother, rng, "ln_vulnerability")
        # 起名：姓继承父（真实遗传链，按姓氏长度支持复姓），名按出生带性别池
        from .namer import name_person
        nrng = self.rng["name"]
        father_surname = father.name[:father.surname_len] if father is not None and father.name else None
        name = name_person(nrng, sex, self.p.era_band(year), father_surname)
        p = Person(
            id=self.next_id, father_id=father.id if father else None,
            mother_id=mother.id if mother else None, birth_year=year, sex=sex,
            ln_fertility=ln_f, ln_vulnerability=ln_v,
            lineage=bool(father and father.lineage and sex == "M"),
            founder=(father is None and mother is None),
            name=name,
            surname_len=len(father_surname) if father_surname else 1,
        )
        self.next_id += 1
        self.add_person(p)
        return p

    def _inherit_ln(self, father: Person | None, mother: Person | None, rng, key: str) -> float:
        sigma = self.p.inherit_sigma
        vals = []
        if father is not None:
            vals.append(getattr(father, key))
        if mother is not None:
            vals.append(getattr(mother, key))
        if not vals:
            return float(rng.normal(0.0, 0.2))   # 移民/创始：从人群分布抽
        return sum(vals) / len(vals) + float(rng.normal(0.0, sigma))

    # ---------- 在世人口视图 ----------

    def living(self) -> list[Person]:
        return [p for p in self.people.values() if p.alive(self.year)]

    def living_male_lineage(self) -> list[Person]:
        return [p for p in self.living() if p.lineage]

    # ---------- 年事件流水线 ----------

    def step_year(self) -> None:
        e = self.era()
        self.world_events = []
        self.pending_deltas = set()
        self._born_this_year = 0
        self._died_this_year = 0
        self._flow = {"born": 0, "died": 0, "emigrated": 0, "immigrated": 0, "wave": False}
        if self.p.era_band(self.year) not in self._era_announced:
            self._era_announced.add(self.p.era_band(self.year))
            self.world_events.append({
                "kind": "era", "year": self.year,
                "band": self.p.era_band(self.year),
            })
        self._births(e)
        self._matchmaking(e)
        self._deaths(e)
        self._migration(e)
        self._lineage_danger()
        self._vital_event()
        if self.p.flavor_events:
            self._flavor_events(e)
        self._record()
        self._check_extinction()

    # 1. 出生判定
    def _births(self, e: EraParams) -> None:
        rng = self.rng["birth"]
        year = self.year
        for couple in list(self._couples()):
            husband, wife = couple
            if wife.age(year) < self.p.female_fertile_min or wife.age(year) > self.p.female_fertile_max:
                continue
            cap = self._couple_cap(husband, wife)
            if wife.children_born >= cap:
                continue
            prob = e.birth_prob * math.exp(wife.ln_fertility + husband.ln_fertility)
            prob = min(0.95, prob)
            if rng.random() < prob:
                sex = "M" if rng.random() < e.sex_ratio / (e.sex_ratio + 100.0) else "F"
                child = self.spawn(year, sex, husband, wife, rng)
                husband.children_born += 1
                wife.children_born += 1
                # 父母计数器随孩子一并下发，前端"亲生子女"才不会停留在旧值
                self.pending_deltas.update((husband.id, wife.id))
                self._born_this_year += 1
                self.pending_deltas.add(child.id)
                if child.lineage:
                    self.world_events.append({
                        "kind": "lineage_birth", "year": year, "id": child.id,
                        "name": f"#{child.id}", "father": husband.id, "mother": wife.id,
                    })
                # 婴儿当年夭折判定
                if rng.random() < e.infant_mortality:
                    child.death_year = year
                    if child.lineage:
                        self.world_events.append({
                            "kind": "lineage_infant_death", "year": year, "id": child.id,
                        })

    def _couples(self):
        seen = set()
        for p in self.people.values():
            if p.spouse_id is not None and p.id not in seen and p.alive(self.year) \
                    and self.people[p.spouse_id].alive(self.year):
                seen.add(p.spouse_id)
                seen.add(p.id)
                if p.sex == "M":
                    yield (p, self.people[p.spouse_id])
                else:
                    yield (self.people[p.spouse_id], p)

    def _couple_cap(self, husband: Person, wife: Person) -> int:
        # cap 缓存：夫妻第一次尝试时定型（含夫妻生育力乘数与噪声），之后不变
        key = (min(husband.id, wife.id), max(husband.id, wife.id))
        if key not in self._caps:
            fert = math.exp((husband.ln_fertility + wife.ln_fertility) / 2)
            rng = self.rng["birth"]
            raw = self.p.parity_cap_base * fert * rng.uniform(0.6, 1.4)
            self._caps[key] = max(0, round(raw))
        return self._caps[key]

    # 2. 撮合
    def _matchmaking(self, e: EraParams) -> None:
        rng = self.rng["match"]
        year = self.year
        singles = [p for p in self.living()
                   if p.spouse_id is None
                   and p.age(year) >= self.p.min_marry_age
                   and not p.dead_or_gone]
        males = [p for p in singles if p.sex == "M"]
        females = [p for p in singles if p.sex == "F"]
        order = rng.permutation(len(males))
        used = set()
        # 渐进撮合开关：None = 单年全配完（旧行为，RNG 序列不变）
        per_year = self.p.matchmaking_per_year
        formed = 0
        first_wed = None   # 本年第一对新人（婚宴叙事用）
        for i in order:
            if per_year is not None and formed >= per_year:
                break
            m = males[i]
            if m.id in used or m.spouse_id is not None:
                continue
            for f in females:
                if f.id in used or f.spouse_id is not None:
                    continue
                if abs(m.age(year) - f.age(year)) > self.p.couple_age_gap:
                    continue
                if marriage_banned(m.id, f.id, self.people, self.p.ban_kin_side,
                                   cache=self._anc_cache):
                    continue
                if rng.random() < e.marriage_willingness and rng.random() < e.marriage_willingness:
                    m.spouse_id = f.id
                    f.spouse_id = m.id
                    used.add(m.id)
                    used.add(f.id)
                    formed += 1
                    if first_wed is None:
                        first_wed = (m.id, f.id)
                    self.pending_deltas.update((m.id, f.id))
                    if m.lineage or f.lineage:
                        self.world_events.append({
                            "kind": "lineage_marriage", "year": year,
                            "ids": [m.id, f.id],
                        })
                    break
                # 意愿不足则换下一个候选（不 break——尝试其他对象）
        # 婚宴叙事：本年有成婚则播报对数与头一队新人（纯事件，flavor 关时不发）
        if formed and self.p.flavor_events and first_wed:
            self.world_events.append({
                "kind": "weddings", "year": year, "count": formed,
                "ids": list(first_wed),
            })

    # 3. 死亡判定
    def _deaths(self, e: EraParams) -> None:
        rng = self.rng["death"]
        year = self.year
        t_frac = (year - self.p.start_year) / max(1, self.p.end_year - self.p.start_year)
        for p in self.living():
            base = mortality_anchor(p.age(year), t_frac, self.p.anchor_mode)
            prob = min(1.0, base * e.adult_mortality_scale * math.exp(p.ln_vulnerability))
            if rng.random() < prob:
                p.death_year = year
                self._died_this_year += 1
                self.pending_deltas.add(p.id)
                if p.lineage:
                    self.world_events.append({
                        "kind": "lineage_death", "year": year, "id": p.id,
                        "age": p.age(year), "children": p.children_born,
                    })
        # 丧偶者不自动再婚（remarriage=False）；配偶保留 spouse_id 供谱系图

    # 4. 迁移：常态外迁 + 时艰迁出潮 + K 压力外迁 + 低谷补移民
    def _migration(self, e: EraParams) -> None:
        rng = self.rng["migrate"]
        year = self.year
        pop = self.living()
        K = e.carrying_capacity
        youths = [p for p in pop if 16 <= p.age(year) <= 40]
        emigrated = 0
        wave = False
        moved_ids: list[int] = []

        def emigrate(n: int, reason: str) -> None:
            nonlocal emigrated
            if n <= 0 or not youths:
                return
            k = min(n, len(youths))
            ids = [p.id for p in youths]
            prot = self.p.lineage_emigration_protect
            if prot >= 1.0:
                # 旧行为：均匀无放回抽取（RNG 序列不变）
                picks = rng.choice(ids, size=k, replace=False)
            else:
                # 血脉保护：血脉男丁权重 × prot 的加权抽取（独立分支，不影响旧行为）
                w = [prot if p.lineage else 1.0 for p in youths]
                total = sum(w)
                picks = rng.choice(ids, size=k, replace=False, p=[x / total for x in w])
            for pid in picks:
                self.people[pid].migrated_out = True
                self.pending_deltas.add(pid)
                moved_ids.append(pid)
                emigrated += 1
                if self.people[pid].lineage:
                    self.events.append(f"y{year}: 血脉男丁 id={pid} 外迁")
                    self.world_events.append({"kind": "lineage_migrated", "year": year, "id": pid})

        # 通道 1：常态外迁——每个青年独立 Bernoulli（小期望不被 int 截断吞掉）
        rate = min(0.3, self.p.base_emigration_rate * (1.0 + e.hardship * 6.0))
        n_steady = int(rng.binomial(len(youths), rate)) if youths else 0
        emigrate(n_steady, "steady")

        # 通道 2：时艰迁出潮——年概率 ~ hardship_wave_prob × 时艰度，一次卷走一片青年
        if rng.random() < self.p.hardship_wave_prob * (0.3 + e.hardship * 4.0):
            wave = True
            n_wave = int(rng.binomial(len(youths),
                                      min(0.5, self.p.hardship_wave_fraction * (0.5 + e.hardship)))
                         ) if youths else 0
            emigrate(n_wave, "wave")

        # 通道 3：K 压力外迁（限流 3%K/年，防 K 波动清洗）
        if len(pop) > K:
            emigrate(min(len(pop) - K, max(1, int(K * 0.03))), "pressure")

        # 事件附代表姓名（取自已选定的名单前 3 人，不引入新抽样）
        mover_names = [self.people[pid].name for pid in moved_ids[:3]]
        if wave and emigrated:
            self.world_events.append({
                "kind": "emigration_wave", "year": year, "count": emigrated,
                "names": mover_names,
            })
        elif emigrated:
            self.world_events.append({
                "kind": "emigration", "year": year, "count": emigrated,
                "names": mover_names,
            })

        # 通道 4：低谷补移民
        if len(pop) < K * self.p.migrate_min_fraction:
            n_come = min(20, int(K * self.p.migrate_min_fraction) - len(pop))
            came = 0
            came_names: list[str] = []
            from .namer import name_person
            nrng = self.rng["name"]
            for _ in range(max(0, n_come)):
                sex = "M" if rng.random() < 0.5 else "F"
                age = int(rng.integers(16, 35))
                m = Person(id=self.next_id, father_id=None, mother_id=None,
                           birth_year=year - age, sex=sex, founder=True)
                m.ln_fertility = float(rng.normal(0.0, 0.2))
                m.ln_vulnerability = float(rng.normal(0.0, 0.2))
                # 移民取名：姓从库抽，名按其出生带（year-age）性别池
                m.name = name_person(nrng, sex, self.p.era_band(year - age), None)
                self.next_id += 1
                self.add_person(m)
                self.pending_deltas.add(m.id)
                came += 1
                came_names.append(m.name)
            if came:
                event = {"kind": "immigration", "year": year, "count": came,
                         "names": came_names[:3]}
                if self.p.flavor_events:
                    # 移民来处：纯叙事字段（只进事件 payload；用 flavor 流，模拟量与人名流不动）
                    pool = _ORIGINS_HARD if e.hardship >= 0.25 else _ORIGINS_CALM
                    event["from"] = _pick(self.rng["flavor"], pool)
                self.world_events.append(event)

        # 年度流量（history 记录用）
        self._flow = {
            "born": self._born_this_year,
            "died": self._died_this_year,
            "emigrated": emigrated,
            "immigrated": (came if len(pop) < K * self.p.migrate_min_fraction else 0),
            "wave": wave,
        }

    # 4.5 事件层：血脉危急预警 + 年度纪事（纯事件输出，不影响模拟与 RNG）
    def _lineage_danger(self) -> None:
        n = len(self.living_male_lineage())
        if 0 < n <= 2:
            if not self._lineage_danger_latch:
                self._lineage_danger_latch = True
                self.world_events.append({
                    "kind": "lineage_danger", "year": self.year, "count": n,
                })
        else:
            self._lineage_danger_latch = False

    def _vital_event(self) -> None:
        # 民生流水按自然年累积、每 5 年汇总一条——逐年播报会淹没血脉主线
        f = self._flow
        acc = self._vital_acc
        if acc is None:
            acc = self._vital_acc = {
                "start": self.year, "born": 0, "died": 0,
                "emigrated": 0, "immigrated": 0,
            }
        for k in ("born", "died", "emigrated", "immigrated"):
            acc[k] += f[k]
        if self.year - acc["start"] >= 4:
            self.world_events.append({
                "kind": "vital", "year": self.year,
                "born": acc["born"], "died": acc["died"],
                "emigrated": acc["emigrated"], "immigrated": acc["immigrated"],
                "span": self.year - acc["start"] + 1,
            })
            self._vital_acc = None

    def _flavor_events(self, e: EraParams) -> None:
        """世界模拟感叙事层：天时/送老/冠礼/里程碑/风物杂闻。

        只读模拟状态 + 独立 flavor 子流，不写任何模拟量 → 开关不影响结果复现。
        """
        rng = self.rng["flavor"]
        year = self.year
        # 天时（6% 播报，文本随时艰度分档）
        if rng.random() < 0.06:
            pool = (_HARVEST_BAD if e.hardship >= 0.30 else
                    _HARVEST_GOOD if e.hardship <= 0.10 else _HARVEST_PLAIN)
            self.world_events.append({
                "kind": "harvest", "year": year, "text": _pick(rng, pool),
            })
        # 风物杂闻（4%；时艰年混入流民/狼患等暗色见闻）
        if rng.random() < 0.04:
            pool = list(_FLAVOR_CALM) + (_FLAVOR_HARD if e.hardship >= 0.25 else [])
            self.world_events.append({
                "kind": "flavor", "year": year, "text": _pick(rng, pool),
            })
        # 高寿辞世：当年最年长的逝者（≥75 岁才播报，保持稀有感）
        died = [p for p in self.people.values()
                if p.death_year == year and p.age(year) >= 75]
        if died:
            o = max(died, key=lambda q: q.age(year))
            self.world_events.append({
                "kind": "elder_death", "year": year, "id": o.id, "age": o.age(year),
            })
        # 血脉男丁冠礼（年满 16，入族谱）
        for p in self.living():
            if p.lineage and p.age(year) == 16:
                self.world_events.append({
                    "kind": "coming_of_age", "year": year, "id": p.id,
                })
        # 人口里程碑（升档触发；首次调用先校准基线避免开局连报）
        pop = len(self.living())
        if self._pop_mark == 0:
            self._pop_mark = pop
        else:
            for t in (200, 300, 500, 800, 1300, 2100, 3400):
                if pop >= t > self._pop_mark:
                    self._pop_mark = t
                    self.world_events.append({
                        "kind": "milestone", "year": year, "pop": pop, "tier": t,
                    })
                    break

    # 5. 逐年记录与断绝检查
    def _record(self) -> None:
        living = self.living()
        lm = self.living_male_lineage()
        self.history.append({
            "year": self.year,
            "pop": len(living),
            "lineage_male": len(lm),
            "lineage_male_adult": len([p for p in lm if p.age(self.year) >= 16]),
            **self._flow,
        })

    def _check_extinction(self) -> None:
        if self.extinct_year is not None:
            return
        males = self.living_male_lineage()
        if not males and self.pending_male_fetuses == 0:
            self.extinct_year = self.year
            self.extinct_reasons = self._classify_extinction()
            self.termination = T_EXTINCT_BLOOD
            self.world_events.append({
                "kind": "extinct", "year": self.year,
                "reasons": self.extinct_reasons,
            })

    def _classify_extinction(self) -> list[str]:
        """基于历史人口推断断绝原因。"""
        reasons = []
        all_lineage = [p for p in self.people.values() if p.lineage]
        if not any(p.lineage for p in self.people.values()):
            return [E1_NO_MALE_BORN]
        # E4：有男血裔但全部外迁
        if any(p.lineage and p.migrated_out for p in self.people.values()) and \
                not any(p.lineage and p.migrated_out is False and p.death_year is None for p in self.people.values()):
            migrated_alive_or_gone = [p for p in self.people.values() if p.lineage and p.migrated_out]
            # 外迁者移出模拟，状态视为流失
            if migrated_alive_or_gone:
                reasons.append(E4_MALE_MIGRATED)
        # E2：男血裔有成年者但从未结婚
        unbred = [p for p in all_lineage
                  if p.death_year is not None and p.spouse_id is None and p.age(p.death_year) >= 30]
        if unbred:
            reasons.append(E2_MALE_UNBRED)
        # E6：已婚但终生未育（有配偶却无出的男丁；修正原先误报 E1 的情况）
        married_barren = [p for p in all_lineage
                          if p.death_year is not None and p.spouse_id is not None
                          and p.children_born == 0
                          and p.age(p.death_year) >= self.p.min_marry_age]
        if married_barren:
            reasons.append(E6_MARRIED_NO_CHILD)
        # E3：男血裔全部早夭（<16 死亡）
        early = [p for p in all_lineage if p.death_year is not None and p.age(p.death_year) < 16]
        if all_lineage and len(early) == len([p for p in all_lineage if p.death_year is not None]) \
                and all(p.death_year is not None for p in all_lineage):
            reasons.append(E3_MALE_EARLY_DEATH)
        if not reasons:
            reasons.append(E1_NO_MALE_BORN)
        return reasons


def _ar_lin(rng, rho: float, prev: float, mean: float, sd: float) -> float:
    return mean + rho * (prev - mean) + rng.normal(0, sd * math.sqrt(1 - rho * rho))


def _ar_log(rng, rho: float, prev_ln: float, mean_ln: float, sd: float) -> float:
    return mean_ln + rho * (prev_ln - mean_ln) + rng.normal(0, sd * math.sqrt(1 - rho * rho))


# —— 风物叙事文案池（纯叙述，随 hardship 分档；只消耗 flavor 子流） ——
_HARVEST_GOOD = [
    "风调雨顺，谷仓满溢，新饭香飘过半条巷。",
    "今岁大熟，场圃堆金，狗吠深巷，鸡鸣桑颠。",
    "雨旸时若，麻麦丰茂，家家趁着好日修葺屋顶。",
]
_HARVEST_PLAIN = [
    "今岁平平，够吃够用，日子照旧过。",
    "不丰不歉，赋税缴清，围炉夜话寻常事。",
]
_HARVEST_BAD = [
    "入夏大旱，河床龟裂，长老率众在庙前祈雨。",
    "蝗群过境，青苗啃食殆尽，粮价暗涨。",
    "秋霜早至，晚稻尽萎，家家勒紧了裤带。",
]
_FLAVOR_CALM = [
    "货郎担进了村，糖人与花线引来一圈孩童。",
    "河滩上一群孩子摸鱼，笑声惊起白鹭。",
    "庙前搭了草台，锣鼓哐锵响了三天。",
    "夜雨敲窗，屋檐滴水到天明。",
    "猎户在东山套住一头獐，分肉时全村闻香。",
    "老井淘了一眼，水比往年更旺。",
    "谁家的新媳妇酿的酱格外香，半条巷都来讨方子。",
]
_FLAVOR_HARD = [
    "流民路过村口，讨了一瓢水又匆匆南去。",
    "邻村传来抢粮的消息，家家闭门早睡。",
    "野菜被挖尽了，有人开始变卖农具。",
    "野狼夜里袭了畜栏，天亮只剩几缕毛。",
]
_ORIGINS_CALM = [
    "邻县", "山那头的王家村", "河下游的渡口镇", "北边的旧营垒", "三十里外的柳林屯",
]
_ORIGINS_HARD = [
    "遭了蝗灾的下河邑", "被兵灾烧毁的前朝故镇", "税吏横行的县郭", "泛了黄水的滩区",
]


def _pick(rng, pool: list[str]) -> str:
    return pool[int(rng.integers(len(pool)))]
