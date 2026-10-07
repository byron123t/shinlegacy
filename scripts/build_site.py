#!/usr/bin/env python3
"""
Build the static site (GitHub Pages) from instance/genealogy.db.

Output (default _site/):
  index.html        the tree viewer
  directory.html    sortable list of everyone
  data/tree.json    nested tree the viewer loads
  static/           css + js

Usage:
  python scripts/build_site.py
  python -m http.server -d _site 8000      # preview at http://localhost:8000
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
YEAR_FALLBACK = 9999


def parse_year(text: str | None) -> int:
    """First 4-digit year (1000-2999), or YEAR_FALLBACK if none."""
    m = re.search(r"\b(1[0-9]{3}|2[0-9]{3})\b", text or "")
    return int(m.group(1)) if m else YEAR_FALLBACK


def load_people(db_path: Path) -> list[dict]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    have = {r[1] for r in con.execute("PRAGMA table_info(people)")}
    optional = [c for c in ("photo_url", "photo_source", "position", "bio") if c in have]
    rows = con.execute(
        f"SELECT id, name, year, institution, url, advisor_id{''.join(', ' + c for c in optional)} FROM people"
    ).fetchall()

    people = []
    for r in rows:
        r = dict(r)
        try:
            bio = json.loads(r["bio"]) if r.get("bio") else None
        except ValueError:
            bio = None
        people.append({
            "id": r["id"],
            "name": r["name"],
            "year": r["year"] or "",
            "institution": r["institution"] or "",
            "url": r["url"] or "",
            "advisor_id": r["advisor_id"],
            "year_num": parse_year(r["year"]),
            "photo_url": r.get("photo_url") or "",
            "photo_source": r.get("photo_source") or "",
            "position": r.get("position") or "",
            "bio": bio,
        })
    return people


def sort_key(p: dict):
    return (p["year_num"], p["name"].lower())


def build_tree(people: list[dict]) -> dict:
    """Nested {..., children: [...]} rooted at the person with no advisor."""
    nodes = {p["id"]: {**p, "children": []} for p in people}
    roots = []
    for n in nodes.values():
        parent = nodes.get(n["advisor_id"])
        (parent["children"] if parent else roots).append(n)

    def sort(n):
        n["children"].sort(key=sort_key)
        for c in n["children"]:
            sort(c)

    if not roots:
        return {}
    if len(roots) == 1:
        root = roots[0]
    else:
        root = {"id": 0, "name": "Genealogy", "year": "", "institution": "", "url": "", "advisor_id": None,
                "year_num": YEAR_FALLBACK, "photo_url": "", "photo_source": "", "position": "", "bio": None,
                "children": roots}
    sort(root)
    return root


def directory_rows(people: list[dict]) -> list[dict]:
    """People annotated with advisor, advisees and descendant counts for directory.html."""
    by_id = {p["id"]: dict(p, advisees=[]) for p in people}
    for p in by_id.values():
        p["advisor"] = by_id.get(p["advisor_id"])
        if p["advisor"]:
            p["advisor"]["advisees"].append(p)

    def descendants(p) -> int:
        if "descendant_count" not in p:
            p["descendant_count"] = sum(1 + descendants(c) for c in p["advisees"])
        return p["descendant_count"]

    for p in by_id.values():
        descendants(p)
    return sorted(by_id.values(), key=sort_key)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "instance" / "genealogy.db"))
    ap.add_argument("--out", default=str(ROOT / "_site"))
    args = ap.parse_args()

    people = load_people(Path(args.db))
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    (out / "data").mkdir(parents=True)

    (out / "data" / "tree.json").write_text(json.dumps(build_tree(people), ensure_ascii=False, separators=(",", ":")))
    shutil.copytree(ROOT / "static", out / "static")
    (out / ".nojekyll").write_text("")

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape(["html"]))
    (out / "index.html").write_text(env.get_template("index.html").render(page="index"))
    (out / "directory.html").write_text(
        env.get_template("directory.html").render(page="directory", people=directory_rows(people)))

    print(f"Built {out} — {len(people)} people")


if __name__ == "__main__":
    main()
