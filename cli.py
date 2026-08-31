"""CLI：单次运行，输出断绝时刻+原因+人口曲线（M1 验收）。"""

from __future__ import annotations

import argparse
import json

from sim_core import run, default_params, scale_for
from sim_core.village import EXTINCT_REASON_TEXT


def main() -> None:
    ap = argparse.ArgumentParser(description="家族模拟器 M1")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--end-year", type=int, default=1000)
    ap.add_argument("--village-size", type=int, default=300)
    ap.add_argument("--founder-surname", default=None, help="自定义血脉始祖姓（1-2 汉字，复姓可）")
    ap.add_argument("--founder-given", default=None, help="自定义血脉始祖名（1-2 汉字）")
    ap.add_argument("--json-out", type=str, default=None, help="可选：把结果写为 JSON")
    args = ap.parse_args()

    if args.founder_surname or args.founder_given:
        import re
        if not (re.fullmatch(r"[\u4e00-\u9fa5]{1,2}", args.founder_surname or "")
                and re.fullmatch(r"[\u4e00-\u9fa5]{1,2}", args.founder_given or "")):
            raise SystemExit("创始者姓名需为汉字：姓 1-2 字、名 1-2 字")

    params = scale_for(default_params(),
                       end_year=args.end_year,
                       founder_village_size=args.village_size)

    result = run(params, args.seed,
                 founder_surname=args.founder_surname, founder_given=args.founder_given)

    print(f"=== 家族模拟器 M1 (seed={args.seed}) ===")
    print(f"终止态:        {result.termination}")
    print(f"最终年份:      {result.final_year}")
    print(f"累计人口:      {result.total_pop_ever}")
    print(f"血脉断绝年份:  {result.extinct_year if result.extinct_year is not None else '未断绝'}")
    if result.extinct_reasons:
        zh = "、".join(EXTINCT_REASON_TEXT.get(r, r) for r in result.extinct_reasons)
        print(f"断绝原因:      {zh} [{','.join(result.extinct_reasons)}]")
    else:
        print("断绝原因:      —")
    print(f"血脉世代数:    {result.max_lineage_gen}")
    print()
    # 人口曲线（ASCII）：每 25 年采样
    h = result.history
    if h:
        step = max(1, len(h) // 40)
        samples = h[::step]
        max_pop = max(r["pop"] for r in samples) or 1
        max_lm = max(r["lineage_male"] for r in samples) or 1
        print(f"{'年份':>6} {'人口':>5} {'男血裔':>5}  曲线(人口|男血裔)")
        for r in samples:
            bar = "#" * int(30 * r["pop"] / max_pop)
            lmbar = "+" * int(20 * r["lineage_male"] / max_lm)
            print(f"{r['year']:>6} {r['pop']:>5} {r['lineage_male']:>5}  {bar}|{lmbar}")

    if result.events:
        print()
        print("血脉事件（最后 10 条）:")
        for ev in result.events[-10:]:
            print(f"  {ev}")

    if args.json_out:
        payload = export_payload(result, seed=args.seed)
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        print(f"\nJSON 已写入 {args.json_out}")


def export_payload(result, seed: int) -> dict:
    """导出 viewer 所需的完整数据（DESIGN.md 第 8 节输出格式）。"""
    return {
        "seed": seed,
        "params": vars(result.params) if result.params else {},
        "termination": result.termination,
        "extinct_year": result.extinct_year,
        "extinct_reasons": result.extinct_reasons,
        "final_year": result.final_year,
        "total_pop_ever": result.total_pop_ever,
        "max_lineage_gen": result.max_lineage_gen,
        "history": result.history,
        "events": result.events,
        "era_bands": [
            {
                "band": band,
                "start_year": band * result.params.band_years if result.params else band * 10,
                **vars(e),
            }
            for band, e in sorted(result.era_bands.items())
        ] if result.era_bands else [],
        "people": [
            {
                "id": p.id, "father": p.father_id, "mother": p.mother_id,
                "sex": p.sex, "birth": p.birth_year, "death": p.death_year,
                "spouse": p.spouse_id, "lineage": p.lineage,
                "migrated": p.migrated_out,
                "ln_fertility": round(p.ln_fertility, 4),
                "ln_vulnerability": round(p.ln_vulnerability, 4),
                "children_born": p.children_born,
                "founder": p.founder,
                "name": p.name,
            }
            for p in result.people.values()
        ],
    }


if __name__ == "__main__":
    main()
