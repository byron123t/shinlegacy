#!/usr/bin/env python3
"""
Apply verified research (research/verified/*.json) to the tree database.
Only claims with verdict "confirmed" are used. See docs/research-workflow.md.

Usage:
  python scripts/apply_research.py                       # dry run: print what would change
  python scripts/apply_research.py --apply               # write (backs up the DB first)
  python scripts/apply_research.py --apply --replace-websites
  python scripts/apply_research.py --report research/report.md   # also write a review report
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ADDED_COLUMNS = {  # optional columns; scripts/build_site.py reads them if present
    "photo_url": "VARCHAR(500)",
    "photo_source": "VARCHAR(500)",
    "position": "VARCHAR(255)",
    "bio": "TEXT",
}


def norm_name(name: str) -> str:
    """Order-insensitive, punctuation-free name key; drops parenthesised nicknames."""
    s = re.sub(r"\([^)]*\)", " ", (name or "").lower())
    return " ".join(sorted(re.sub(r"[^a-z]+", " ", s).split()))


# Researcher/verifier notes that sometimes leak into values, e.g. "(per Shin's alumni list)".
NOTE_RE = re.compile(r"\s*[\(\[][^)\]]*\b(per|record|according|source|unverified|not confirmed|as of)\b[^)\]]*[\)\]]", re.I)


def clean(value: str | None) -> str | None:
    if not value:
        return value
    value = NOTE_RE.sub("", value)
    value = re.split(r"\s*;\s*(?:record says|note:)", value, flags=re.I)[0]
    return value.strip(" ;,") or None


def ok(claim) -> bool:
    return isinstance(claim, dict) and claim.get("verdict") == "confirmed"


def is_url(u) -> bool:
    return isinstance(u, str) and re.match(r"^https?://", u) is not None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "instance" / "genealogy.db"))
    ap.add_argument("--verified", default=str(ROOT / "research" / "verified"))
    ap.add_argument("--apply", action="store_true", help="write changes (default is a dry run)")
    ap.add_argument("--replace-websites", action="store_true", help="overwrite existing websites that differ")
    ap.add_argument("--report", help="write a markdown review report to this path")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    have = {r[1] for r in con.execute("PRAGMA table_info(people)")}
    if args.apply:
        backup = Path(args.db).with_name(f"genealogy.backup_{datetime.now():%Y%m%d_%H%M%S}.db")
        shutil.copy2(args.db, backup)
        print(f"Backed up database to {backup}")
        for col, ddl in ADDED_COLUMNS.items():
            if col not in have:
                con.execute(f"ALTER TABLE people ADD COLUMN {col} {ddl}")
        have |= set(ADDED_COLUMNS)

    cols = ["id", "name", "url"] + [c for c in ADDED_COLUMNS if c in have]
    people = {r[0]: dict(zip(cols, r)) for r in con.execute(f"SELECT {', '.join(cols)} FROM people")}
    known = {norm_name(p["name"]): pid for pid, p in people.items()}

    updates: list[tuple[int, str, str | None, str]] = []   # (id, column, value, description)
    review: list[str] = []
    new_students: dict[str, dict] = {}
    rejected = {"website": 0, "photo": 0, "bio": 0, "position": 0, "student": 0}

    files = sorted(Path(args.verified).glob("*.json"))
    if not files:
        raise SystemExit(f"No verified files in {args.verified}")
    for f in files:
        data = json.loads(f.read_text())
        for v in data.get("people", []):
            pid = v.get("id")
            p = people.get(pid)
            if not p:
                review.append(f"- {f.name}: unknown person id {pid} ({v.get('name')}), skipped")
                continue
            name = p["name"]

            w = v.get("website")
            if ok(w) and is_url(w.get("url")):
                if not p["url"]:
                    updates.append((pid, "url", w["url"], f"{name}: website → {w['url']}"))
                elif p["url"].rstrip("/") != w["url"].rstrip("/"):
                    if args.replace_websites:
                        updates.append((pid, "url", w["url"], f"{name}: website {p['url']} → {w['url']}"))
                    else:
                        review.append(f"- {name}: confirmed website {w['url']} differs from {p['url']} (kept; use --replace-websites)")
            elif w:
                rejected["website"] += 1

            ph = v.get("photo")
            if ok(ph) and is_url(ph.get("image_url")):
                updates.append((pid, "photo_url", ph["image_url"], f"{name}: photo → {ph['image_url']}"))
                updates.append((pid, "photo_source", ph.get("page_url"), ""))
            elif ph:
                rejected["photo"] += 1

            pos = v.get("current_position")
            if ok(pos) and clean(pos.get("value")):
                value = clean(pos["value"])
                updates.append((pid, "position", value, f"{name}: position → {value}"))
            elif pos:
                rejected["position"] += 1

            bio = v.get("bio")
            if ok(bio) and bio.get("summary"):
                keep = {k: bio.get(k) for k in ("summary", "research_areas", "phd_institution", "phd_year",
                                                "thesis_title", "notable", "sources") if bio.get(k)}
                updates.append((pid, "bio", json.dumps(keep, ensure_ascii=False), f"{name}: bio ({len(bio['summary'])} chars)"))
            elif bio:
                rejected["bio"] += 1

            for s in v.get("students") or []:
                if not ok(s):
                    rejected["student"] += 1
                    continue
                key = norm_name(s.get("name", ""))
                if not key:
                    continue
                if key in known:
                    other = people[known[key]]["name"]
                    review.append(f"- {name}: student {s['name']} already in tree as {other}, skipped")
                    continue
                if key in new_students:
                    first = new_students[key]
                    if first["advisor_id"] != pid:
                        review.append(f"- {s['name']}: claimed by both {people[first['advisor_id']]['name']} and {name}; "
                                      f"added under {people[first['advisor_id']]['name']} — check")
                    continue
                new_students[key] = {"advisor_id": pid, **s}

    # ----- print plan
    print(f"\n{len(files)} verified files")
    print(f"{sum(1 for u in updates if u[3])} field updates, {len(new_students)} new students")
    print(f"Rejected / unverified claims ignored: {rejected}\n")
    for _, _, _, desc in updates:
        if desc:
            print("  ~", desc)
    for s in new_students.values():
        print(f"  + {s['name']} ({s.get('phd_year') or '?'}) under {people[s['advisor_id']]['name']}"
              f"{' — ' + s['current_institution'] if s.get('current_institution') else ''}  [{s.get('source_url')}]")
    if review:
        print("\nNeeds a human look:")
        print("\n".join(review))

    if args.report:
        lines = ["# Research review", "", f"- Field updates: {sum(1 for u in updates if u[3])}",
                 f"- New students: {len(new_students)}", f"- Ignored (rejected/unverifiable): {rejected}", "",
                 "## New students", ""]
        lines += [f"- **{s['name']}** ({s.get('phd_year') or '?'}) — advisor {people[s['advisor_id']]['name']}; "
                  f"{s.get('current_institution') or ''} — [source]({s.get('source_url')})" for s in new_students.values()]
        lines += ["", "## Needs a human look", ""] + (review or ["(nothing)"])
        lines += ["", "## Field updates", ""] + [f"- {d}" for *_, d in updates if d]
        Path(args.report).write_text("\n".join(lines) + "\n")
        print(f"\nWrote {args.report}")

    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply to write.")
        return

    for pid, col, val, _ in updates:
        con.execute(f"UPDATE people SET {col} = ? WHERE id = ?", (val, pid))
    now = datetime.utcnow().isoformat(sep=" ")
    for s in new_students.values():
        year = s.get("phd_year") or ""
        if year == "current":
            year = ""
        con.execute(
            "INSERT INTO people (name, year, institution, url, advisor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (s["name"], year, s.get("current_institution") or "", s.get("website") or "", s["advisor_id"], now),
        )
    con.commit()
    print(f"\nApplied {sum(1 for u in updates if u[3])} updates and added {len(new_students)} students.")


if __name__ == "__main__":
    main()
