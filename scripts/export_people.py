#!/usr/bin/env python3
"""
Export the tree for the research process in docs/research-workflow.md.

Writes one JSON file per research batch into --out (default research/batches/):
  root.json        Kang G. Shin (deep profile + complete student list)
  g1-01.json ...   generation 1, deep profiles (bio, photo, website, students)
  g2-01.json ...   generation 2+, basic (photo, website, students)

Each batch: {"batch", "kind": "root"|"profile"|"basic", "people": [
  {"id", "name", "institution", "year", "advisor", "website_on_record",
   "students_in_tree": ["Name (year)", ...]}]}

Usage:
  python scripts/export_people.py                       # all batches
  python scripts/export_people.py --only 14 48 88       # just these person ids
  python scripts/export_people.py --since-id 368        # people added after a previous run
  python scripts/export_people.py --profile-size 10 --basic-size 20
"""
import argparse
import json
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "instance" / "genealogy.db"))
    ap.add_argument("--out", default=str(ROOT / "research" / "batches"))
    ap.add_argument("--only", type=int, nargs="*", help="only these person ids")
    ap.add_argument("--since-id", type=int, help="only people with id >= this (new since the last run)")
    ap.add_argument("--profile-size", type=int, default=3, help="generation-1 people per batch")
    ap.add_argument("--basic-size", type=int, default=5, help="generation-2+ people per batch")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    rows = con.execute(
        "SELECT id, name, COALESCE(institution, ''), COALESCE(year, ''), advisor_id, COALESCE(url, '') "
        "FROM people ORDER BY id"
    ).fetchall()
    by_id = {r[0]: r for r in rows}
    kids: dict[int, list] = {}
    for r in rows:
        if r[4] is not None:
            kids.setdefault(r[4], []).append(r)

    def depth(pid: int) -> int:
        d = 0
        while by_id[pid][4] is not None:
            pid = by_id[pid][4]
            d += 1
        return d

    def record(r) -> dict:
        pid, name, inst, year, advisor_id, url = r
        return {
            "id": pid,
            "name": name,
            "institution": inst,
            "year": year,
            "advisor": by_id[advisor_id][1] if advisor_id else None,
            "website_on_record": url,
            "students_in_tree": [f"{k[1]} ({k[3]})" if k[3] else k[1] for k in kids.get(pid, [])],
        }

    selected = [
        r for r in rows
        if (not args.only or r[0] in args.only) and (args.since_id is None or r[0] >= args.since_id)
    ]
    groups = {"root": [], "profile": [], "basic": []}
    for r in selected:
        d = depth(r[0])
        groups["root" if d == 0 else "profile" if d == 1 else "basic"].append(record(r))

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    def write(name: str, kind: str, people: list) -> None:
        (out / f"{name}.json").write_text(json.dumps({"batch": name, "kind": kind, "people": people}, ensure_ascii=False, indent=1))

    if groups["root"]:
        write("root", "root", groups["root"])
    for kind, prefix, size in (("profile", "g1", args.profile_size), ("basic", "g2", args.basic_size)):
        people = groups[kind]
        for n, i in enumerate(range(0, len(people), size), start=1):
            write(f"{prefix}-{n:02d}", kind, people[i:i + size])

    files = sorted(p.name for p in out.glob("*.json"))
    print(f"wrote {len(files)} batches ({len(selected)} people) to {out}: {', '.join(files)}")


if __name__ == "__main__":
    main()
