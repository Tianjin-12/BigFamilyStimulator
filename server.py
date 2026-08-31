"""live server：实时驱动的模拟 HTTP 服务。

用法：python server.py [--port 8642] [--seed 42]
浏览器打开 http://localhost:8642/viewer/live.html

API（JSON）：
  POST /api/new    {seed, overrides:{param:value,...}}   → 全量快照（世界重置）
  POST /api/step   {years: 1}                            → 推进 N 年，返回增量补丁
  GET  /api/snapshot                                      → 全量快照
"""

from __future__ import annotations

import argparse
import json
import re
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.parse

from sim_core import Params, default_params, scale_for
from sim_core.engine import seed_village, _lineage_depth
from sim_core.person import Person
from sim_core.rng import Streams
from sim_core.village import Village
from sim_core.params import EraParams


ROOT = Path(__file__).parent


@dataclass
class Session:
    village: Village
    params: Params
    # 前端已知的年份：之后变更的人作为 delta 下发
    synced_year: int = None
    # 世界创建凭据（读档/续玩的恢复依据：种子+参数覆盖+始祖）
    seed: int = 42
    overrides: dict = None
    founder: dict = None


def person_payload(p: Person) -> dict:
    return {
        "id": p.id, "father": p.father_id, "mother": p.mother_id,
        "sex": p.sex, "birth": p.birth_year, "death": p.death_year,
        "spouse": p.spouse_id, "lineage": p.lineage,
        "migrated": p.migrated_out, "founder": p.founder,
        "ln_fertility": round(p.ln_fertility, 4),
        "ln_vulnerability": round(p.ln_vulnerability, 4),
        "children_born": p.children_born,
        "name": p.name,
        "surname_len": getattr(p, "surname_len", 1) or 1,
    }


def era_payload(band: int, e: EraParams, band_years: int) -> dict:
    return {
        "band": band, "start_year": band * band_years,
        "birth_prob": e.birth_prob, "sex_ratio": e.sex_ratio,
        "infant_mortality": e.infant_mortality,
        "adult_mortality_scale": e.adult_mortality_scale,
        "carrying_capacity": e.carrying_capacity,
        "marriage_willingness": e.marriage_willingness,
        "hardship": getattr(e, "hardship", 0.0),
    }


def mortality_curve_payload(params, year: int, e: EraParams | None) -> dict:
    """当前年份的年龄-死亡率曲线（锚点 × 时期乘数），男女暂同曲线（模型如此）。"""
    from sim_core.params import mortality_anchor
    t_frac = (year - params.start_year) / max(1, params.end_year - params.start_year)
    scale = e.adult_mortality_scale if e else 1.0
    ages = [0, 1, 3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 110]
    return {
        "year": year,
        "mode": params.anchor_mode,
        "scale": round(scale, 3),
        "curve": [{"age": a, "q": round(mortality_anchor(a, t_frac, params.anchor_mode) * scale, 5)}
                  for a in ages],
    }


class World:
    """持有单个活动世界（前端重置/new 时替换）。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.session: Session | None = None

    def new(self, seed: int, overrides: dict,
            founder_surname: str | None = None, founder_given: str | None = None) -> dict:
        params = scale_for(default_params(), **overrides) if overrides else default_params()
        streams = Streams(seed)
        v = seed_village(params, streams,
                         founder_surname=founder_surname or None,
                         founder_given=founder_given or None)
        with self.lock:
            self.session = Session(village=v, params=params, synced_year=v.year,
                                   seed=seed, overrides=dict(overrides or {}),
                                   founder={"surname": founder_surname or "",
                                            "given": founder_given or ""}
                                   if (founder_surname or founder_given) else None)
        return self.snapshot()

    def step(self, years: int) -> dict | None:
        with self.lock:
            s = self.session
            if s is None:
                return None
            v = s.village
            from_year = v.year
            bands_before = set(v.era_bands.keys())
            events: list[dict] = []
            delta_ids: set[int] = set()
            # 断绝后仍然允许继续跑全村（观感用），除非到时间/算力上限
            for _ in range(max(0, years)):
                if v.year >= v.p.end_year or v.total_pop_ever > v.p.pop_cap_total:
                    break
                v.step_year()
                v.year += 1
                events.extend(v.world_events)
                delta_ids.update(v.pending_deltas)
            s.synced_year = v.year
            # 本次 step 内新抽出的时期带（era_new）：以 village 的带集合差为准，
            # 不用年份比较（era() 在 year=10 时抽 band1，恰与 from_year 同值，年份法会漏发）
            new_band_keys = set(v.era_bands.keys()) - bands_before
            resp = {
                "year": v.year,
                "years_stepped": v.year - from_year,
                "termination": ("TIME_LIMIT" if v.year >= v.p.end_year else
                                "POP_CAP" if v.total_pop_ever > v.p.pop_cap_total else
                                ("EXTINCT_BLOOD" if v.extinct_year is not None else None)),
                "extinct_year": v.extinct_year,
                "extinct_reasons": v.extinct_reasons,
                "history_tail": v.history[-(years + 1):] if v.history else [],
                "era_new": [era_payload(b, v.era_bands[b], v.p.band_years)
                            for b in sorted(new_band_keys)],
                "world_events": events,
                "delta_ids": sorted(delta_ids),
                "stats": self._stats(v),
                "mortality_curve": mortality_curve_payload(
                    v.p, v.year, v.era_bands.get(max(v.era_bands)) if v.era_bands else None),
            }
            return resp

    def _stats(self, v: Village) -> dict:
        living = v.living()
        lm = [p for p in living if p.lineage]
        return {
            "pop": len(living),
            "lineage_male": len(lm),
            "lineage_male_adult": len([p for p in lm if p.age(v.year) >= 16]),
            "total_pop_ever": v.total_pop_ever,
            "max_lineage_gen": _lineage_depth(v),
            "couples": sum(1 for p in living if p.spouse_id is not None
                           and p.sex == "M"
                           and v.people[p.spouse_id].alive(v.year)),
        }

    def snapshot(self) -> dict:
        with self.lock:
            if self.session is None:
                self.session = None
                s = None
            else:
                s = self.session
        if s is None:
            return {"error": "no world"}
        v = s.village
        last_era = v.era_bands.get(max(v.era_bands)) if v.era_bands else None
        return {
            "year": v.year,
            "world_meta": {"seed": s.seed, "overrides": s.overrides or {},
                           "founder": s.founder},
            "params": vars(v.p),
            "termination": ("EXTINCT_BLOOD" if v.extinct_year is not None else None),
            "extinct_year": v.extinct_year,
            "extinct_reasons": v.extinct_reasons,
            "total_pop_ever": v.total_pop_ever,
            "max_lineage_gen": _lineage_depth(v),
            "history": v.history,
            "events": v.events,
            "era_bands": [era_payload(b, e, v.p.band_years)
                          for b, e in sorted(v.era_bands.items())],
            "people": [person_payload(p) for p in v.people.values()],
            "stats": self._stats(v),
            "mortality_curve": mortality_curve_payload(v.p, v.year, last_era),
        }


WORLD = World()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    def _json(self, code: int, obj) -> None:
        def _default(o):
            import numpy as np
            if isinstance(o, (np.integer,)):
                return int(o)
            if isinstance(o, (np.floating,)):
                return float(o)
            raise TypeError(str(type(o)))
        body = json.dumps(obj, ensure_ascii=False, default=_default).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/snapshot":
            return self._json(200, WORLD.snapshot())
        # 静态文件（viewer/）
        if path.startswith("/viewer/"):
            return self._static(ROOT / "viewer" / path[len("/viewer/"):])
        if path in ("/", "/viewer", "/viewer/"):
            return self._static(ROOT / "viewer" / "live.html")
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            body = self._body()
            if path == "/api/new":
                surname = (body.get("founder_surname") or "").strip()
                given = (body.get("founder_given") or "").strip()
                if surname and not re.fullmatch(r"[\u4e00-\u9fa5]{1,2}", surname):
                    return self._json(400, {"error": "创始者姓氏需为 1-2 个汉字（复姓可）"})
                if given and not re.fullmatch(r"[\u4e00-\u9fa5]{1,2}", given):
                    return self._json(400, {"error": "创始者名需为 1-2 个汉字"})
                if (surname or given) and not (surname and given):
                    return self._json(400, {"error": "姓与名需同时填写（都留空则随机起名）"})
                return self._json(200, WORLD.new(int(body.get("seed", 42)),
                                                 body.get("overrides") or {},
                                                 founder_surname=surname or None,
                                                 founder_given=given or None))
            if path == "/api/step":
                years = max(1, min(int(body.get("years", 1)), 500))
                resp = WORLD.step(years)
                if resp is None:
                    return self._json(400, {"error": "no world; POST /api/new first"})
                # 增量补丁：本批变更的人（前端按需索取全量）
                s = WORLD.session
                if s and resp.get("delta_ids"):
                    resp["delta_people"] = [person_payload(s.village.people[pid])
                                            for pid in resp["delta_ids"]]
                return self._json(200, resp)
            self._json(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})

    def _static(self, path: Path):
        if not path.is_file():
            return self._json(404, {"error": "not found"})
        mime = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css", ".json": "application/json", ".png": "image/png"}.get(
                    path.suffix, "application/octet-stream")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8642)
    ap.add_argument("--seed", type=int, default=None, help="启动即建世界（否则等前端 /api/new）")
    args = ap.parse_args()
    if args.seed is not None:
        WORLD.new(args.seed, {})
    addr = ("127.0.0.1", args.port)
    print(f"live server: http://localhost:{args.port}/viewer/live.html")
    ThreadingHTTPServer(addr, Handler).serve_forever()


if __name__ == "__main__":
    main()
