#!/usr/bin/env python3
"""
Find people the first research pass left incomplete and write small gap batches.

A person is a gap when research/raw/* has no website (and none is on record),
no photo, or, for root/generation-1 profiles, no bio. Each gap batch lists
what is still needed ("need") and the earlier agent's notes ("hints").

Usage:
  python scripts/find_gaps.py                 # writes research/batches/gap-NN.json
  python scripts/find_gaps.py --size 4 --need photo
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--batches", default=str(ROOT / "research" / "batches"))
    ap.add_argument("--raw", default=str(ROOT / "research" / "raw"))
    ap.add_argument("--size", type=int, default=4, help="people per gap batch")
    ap.add_argument("--need", nargs="*", default=["website", "photo", "bio"], help="which gaps to fill")
    args = ap.parse_args()

    batches, raw = Path(args.batches), Path(args.raw)
    context, kinds = {}, {}
    for f in batches.glob("*.json"):
        if f.name.startswith("gap-"):
            continue
        b = json.loads(f.read_text())
        for p in b["people"]:
            context[p["id"]] = p
            kinds[p["id"]] = b["kind"]

    found: dict[int, dict] = {}
    for f in sorted(raw.glob("*.json")):
        for p in json.loads(f.read_text()).get("people", []):
            agg = found.setdefault(p["id"], {"website": None, "photo": None, "bio": None, "notes": []})
            for k in ("website", "photo", "bio"):
                agg[k] = agg[k] or p.get(k)
            if p.get("notes"):
                agg["notes"].append(p["notes"])

    gaps = []
    for pid, ctx in sorted(context.items()):
        f = found.get(pid)
        if f is None:
            continue  # batch not researched yet
        need = []
        if "website" in args.need and not f["website"] and not ctx.get("website_on_record"):
            need.append("website")
        if "photo" in args.need and not f["photo"]:
            need.append("photo")
        if "bio" in args.need and kinds[pid] in ("root", "profile") and not f["bio"]:
            need.append("bio")
        if need:
            gaps.append({**ctx, "need": need, "hints": " | ".join(f["notes"])[:600],
                         "deep_profile": kinds[pid] in ("root", "profile")})

    for old in batches.glob("gap-*.json"):
        old.unlink()
    for n, i in enumerate(range(0, len(gaps), args.size), start=1):
        name = f"gap-{n:02d}"
        (batches / f"{name}.json").write_text(json.dumps({"batch": name, "kind": "gap", "people": gaps[i:i + args.size]},
                                                          ensure_ascii=False, indent=1))
    print(f"{len(gaps)} people with gaps → {(len(gaps) + args.size - 1) // args.size} gap batches in {batches}")


if __name__ == "__main__":
    main()
