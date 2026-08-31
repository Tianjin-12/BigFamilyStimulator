"""runner：批量运行 + 聚合统计（DESIGN.md M2）。

用法：
  python -m runner.batch --n 200 --out results/m1
  python -m runner.batch --n 100 --sweep parity_cap_base:5,6,7,8 --out results/sweep_cap
  python -m runner.batch --n 100 --sweep ban_kin_side:2,3,4 --out results/sweep_k

输出（out 目录）：
  runs.csv        每次运行一行
  summary.json    聚合：断绝率/原因分布/存续年数分布/世代分布/人口分位带
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass

from sim_core import default_params, run, scale_for


@dataclass(frozen=True)
class Job:
    seed: int
    overrides: dict


def _one(job: Job) -> dict:
    params = scale_for(default_params(), **job.overrides)
    r = run(params, job.seed)
    return {
        "seed": job.seed,
        "termination": r.termination,
        "extinct_year": r.extinct_year,
        "reasons": "|".join(r.extinct_reasons) if r.extinct_reasons else "",
        "final_year": r.final_year,
        "max_lineage_gen": r.max_lineage_gen,
        "total_pop_ever": r.total_pop_ever,
        "survived_years": r.extinct_year if r.extinct_year is not None else r.final_year,
        # 人口曲线抽样（每 10 年一点，聚合用）
        "pop_series": [h["pop"] for h in r.history[::10]],
    }


def parse_sweep(spec: str | None) -> list[dict]:
    """解析 --sweep 'param:v1,v2,v3[;param2:...]' → override 组合列表。"""
    if not spec:
        return [{}]
    axes = []
    for part in spec.split(";"):
        key, values = part.split(":")
        vals = []
        for v in values.split(","):
            try:
                vals.append(int(v))
            except ValueError:
                try:
                    vals.append(float(v))
                except ValueError:
                    vals.append(v)
        axes.append((key, vals))
    combos: list[dict] = [{}]
    for key, vals in axes:
        combos = [{**c, key: v} for c in combos for v in vals]
    return combos


def percentile(sorted_vals: list, q: float):
    if not sorted_vals:
        return None
    idx = min(len(sorted_vals) - 1, max(0, round(q * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


def aggregate(rows: list[dict]) -> dict:
    n = len(rows)
    extinct = [r for r in rows if r["termination"] == "EXTINCT_BLOOD"]
    reasons: dict[str, int] = {}
    for r in extinct:
        for x in r["reasons"].split("|"):
            if x:
                reasons[x] = reasons.get(x, 0) + 1
    surv = sorted(r["survived_years"] for r in extinct)
    gens = sorted(r["max_lineage_gen"] for r in rows)
    # 人口分位带：对齐各 run 的 pop_series（截到最短）
    series = [r["pop_series"] for r in rows if r["pop_series"]]
    band = []
    if series:
        m = min(len(s) for s in series)
        for i in range(m):
            col = sorted(s[i] for s in series)
            band.append({
                "t": i * 10,
                "p25": percentile(col, 0.25),
                "p50": percentile(col, 0.50),
                "p75": percentile(col, 0.75),
            })
    return {
        "n_runs": n,
        "extinct_rate": len(extinct) / n if n else 0,
        "reasons_dist": reasons,
        "survived_years_extinct": {
            "median": statistics.median(surv) if surv else None,
            "p10": percentile(surv, 0.10),
            "p90": percentile(surv, 0.90),
        },
        "max_lineage_gen": {
            "median": statistics.median(gens) if gens else None,
            "p90": percentile(gens, 0.90),
        },
        "pop_band": band,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="批量运行 + 聚合")
    ap.add_argument("--n", type=int, default=200, help="每个参数组合的运行次数")
    ap.add_argument("--seed-start", type=int, default=0)
    ap.add_argument("--sweep", type=str, default=None,
                    help="参数扫描 'param:v1,v2;param2:v1,v2'（不扫则单组合）")
    ap.add_argument("--out", type=str, required=True)
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()

    combos = parse_sweep(args.sweep)
    jobs = [Job(seed=s, overrides=c)
            for c in combos
            for s in range(args.seed_start, args.seed_start + args.n)]

    os.makedirs(args.out, exist_ok=True)

    rows = []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for row in ex.map(_one, jobs, chunksize=4):
            rows.append(row)

    # runs.csv
    csv_path = os.path.join(args.out, "runs.csv")
    fields = ["seed", "termination", "extinct_year", "reasons", "final_year",
              "max_lineage_gen", "total_pop_ever", "survived_years",
              "sweep_key"] + sorted({k for c in combos for k in c})
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for i, row in enumerate(rows):
            combo = combos[i // args.n]
            row = {**row, "sweep_key": json.dumps(combo, ensure_ascii=False), **combo}
            w.writerow(row)

    # summary.json（单组合直接聚合；扫描则按组合分组 + 总表）
    if len(combos) == 1:
        summary = {"sweep": None, "all": aggregate(rows)}
    else:
        by_combo: dict[str, list[dict]] = {}
        for i, row in enumerate(rows):
            key = json.dumps(combos[i // args.n], ensure_ascii=False)
            by_combo.setdefault(key, []).append(row)
        summary = {
            "sweep": args.sweep,
            "combos": {k: aggregate(v) for k, v in by_combo.items()},
            "all": aggregate(rows),
        }
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    agg = summary["all"]
    print(f"runs={agg['n_runs']}  断绝率={agg['extinct_rate']:.1%}  "
          f"断绝中位年={agg['survived_years_extinct']['median']}  "
          f"世代中位={agg['max_lineage_gen']['median']}")
    print(f"原因分布: {agg['reasons_dist']}")
    print(f"输出: {csv_path} / summary.json")


if __name__ == "__main__":
    main()
