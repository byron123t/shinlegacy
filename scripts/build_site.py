#!/usr/bin/env python3
"""
Build the static site (GitHub Pages) from instance/genealogy.db.

Output (default _site/):
  index.html        the tree viewer
  directory.html    sortable list of everyone
  data/tree.json    nested tree the viewer loads
  static/           css + js
  p/<id>.html       share link per person: preview metadata, then redirects into the tree
  p/<id>.jpg        that person's preview card (needs Pillow; skipped without it)

Usage:
  python scripts/build_site.py
  python scripts/build_site.py --no-cards  # skip the preview images (faster)
  python -m http.server -d _site 8000      # preview at http://localhost:8000
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
YEAR_FALLBACK = 9999
SITE_URL = "https://byron123t.github.io/shinlegacy/"
REPO_URL = "https://github.com/byron123t/shinlegacy"


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


def norm_name(name: str) -> str:
    """Same key as scripts/apply_research.py: order-insensitive, punctuation-free."""
    s = re.sub(r"\([^)]*\)", " ", (name or "").lower())
    return " ".join(sorted(re.sub(r"[^a-z]+", " ", s).split()))


def load_sources(people: list[dict], verified_dir: Path) -> dict[int, list[dict]]:
    """Per person, the pages that back up what the tree says: {id: [{label, url}]}.

    Taken from confirmed claims in research/verified/*.json, including the page
    that shows who advised them (recorded on the advisor's entry).
    """
    by_name = {norm_name(p["name"]): p for p in people}
    by_id = {p["id"]: p for p in people}
    out: dict[int, list[dict]] = {}

    def add(pid, label, url):
        if not isinstance(url, str) or not re.match(r"^https?://", url):
            return
        lst = out.setdefault(pid, [])
        if all(x["url"].rstrip("/") != url.rstrip("/") for x in lst):
            lst.append({"label": label, "url": url})

    def ok(c):
        return isinstance(c, dict) and c.get("verdict") == "confirmed"

    for f in sorted(verified_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
        except ValueError:
            continue
        for v in data.get("people", []):
            pid = v.get("id")
            if pid not in by_id:
                continue
            for s in v.get("students") or []:
                kid = by_name.get(norm_name(s.get("name", "")))
                if ok(s) and kid and kid["advisor_id"] == pid:
                    add(kid["id"], f"Advised by {by_id[pid]['name']}", s.get("source_url"))
            if ok(v.get("phd")):
                add(pid, "PhD record", v["phd"].get("source_url"))
            if ok(v.get("photo")):
                add(pid, "Photo", v["photo"].get("page_url"))
            if ok(v.get("bio")):
                for u in v["bio"].get("sources") or []:
                    add(pid, "Biography", u)
    return out


def lineage(p: dict, by_id: dict) -> list[dict]:
    chain = [p]
    while chain[-1]["advisor_id"] in by_id and len(chain) < 20:
        chain.append(by_id[chain[-1]["advisor_id"]])
    return chain[::-1]


def initials(name: str) -> str:
    words = re.sub(r"\([^)]*\)", " ", name).replace("-", " ").split()
    words = [w for w in words if w[0].isalpha()]
    return (words[0][0] + (words[-1][0] if len(words) > 1 else "")).upper() if words else "?"


# ---------------------------------------------------------------------------
# Share pages and preview cards
# ---------------------------------------------------------------------------
GEN_COLORS = ["#1b2230", "#1f4e8c", "#2a8a7a", "#c26a1d", "#8a4fb0"]
GEN_WORDS = ["Root of the tree", "Student", "Grand-student", "Great-grand-student", "Great-great-grand-student"]


def fetch_photos(people: list[dict], cache: Path) -> dict[int, Path]:
    """Download headshots for the preview cards (cached; failures are skipped)."""
    cache.mkdir(parents=True, exist_ok=True)

    def get(p):
        url = p["photo_url"]
        path = cache / hashlib.sha1(url.encode()).hexdigest()
        for _ in range(2):
            if path.exists():
                break
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (family-tree card builder)"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    if not r.headers.get("Content-Type", "").startswith("image/"):
                        return None
                    path.write_bytes(r.read())
            except Exception:
                pass
        if not path.exists():
            return None
        return p["id"], path

    with ThreadPoolExecutor(16) as pool:
        got = pool.map(get, [p for p in people if re.match(r"^https?://", p["photo_url"])])
    return dict(g for g in got if g)


def draw_card(p: dict, chain: list[dict], photo: Path | None, dest: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    W, H = 1200, 630
    depth = len(chain) - 1
    color = GEN_COLORS[min(depth, 4)]
    img = Image.new("RGB", (W, H), "#f6f4ef")
    d = ImageDraw.Draw(img)
    font = lambda size: ImageFont.load_default(size)  # noqa: E731  (Pillow >= 10.1 ships a scalable font)
    d.rectangle([0, 0, W, 14], fill=color)

    # Portrait or initials
    cx, cy, r = 230, 300, 150
    face = None
    if photo:
        try:
            face = ImageOps.fit(Image.open(photo).convert("RGB"), (2 * r, 2 * r), centering=(0.5, 0.3))
        except Exception:
            face = None
    if face is None:
        face = Image.new("RGB", (2 * r, 2 * r), color)
        fd = ImageDraw.Draw(face)
        fd.text((r, r), initials(p["name"]), font=font(110), fill="#ffffff", anchor="mm")
    mask = Image.new("L", (2 * r, 2 * r), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, 2 * r - 1, 2 * r - 1], fill=255)
    d.ellipse([cx - r - 8, cy - r - 8, cx + r + 8, cy + r + 8], fill=color)
    img.paste(face, (cx - r, cy - r), mask)

    def fit_text(text, size, width, min_size=28):
        while size > min_size and d.textlength(text, font=font(size)) > width:
            size -= 2
        f = font(size)
        while d.textlength(text, font=f) > width and len(text) > 4:
            text = text[:-2].rstrip() + "…"
        return text, f

    x, width = 440, W - 440 - 60
    gen = GEN_WORDS[min(depth, 4)] + ("" if depth == 0 else f" of {chain[0]['name']}" if depth < 5 else "")
    d.text((x, 130), gen.upper(), font=font(26), fill=color)
    name, f = fit_text(p["name"], 76, width)
    d.text((x, 170), name, font=f, fill="#1b2230")
    sub = p["position"] or ", ".join(v for v in (p["institution"], p["year"] and f"PhD {p['year']}") if v)
    if sub:
        # Up to two lines, broken at a word boundary
        f, lines, line = font(30), [], ""
        for word in sub.split():
            if line and d.textlength(f"{line} {word}", font=f) > width:
                lines.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        lines.append(line)
        if len(lines) > 2:
            lines = [lines[0], fit_text(" ".join(lines[1:]), 30, width, 30)[0]]
        for i, text in enumerate(lines):
            d.text((x, 268 + i * 38), text, font=f, fill="#5d6676")
    if depth:
        sep = "  ›  "  # the default font has no arrow glyph
        path = sep.join(c["name"] for c in chain)
        if d.textlength(path, font=font(26)) > width and depth > 2:
            path = sep.join([chain[0]["name"], "…", chain[-2]["name"], chain[-1]["name"]])
        path, f = fit_text(path, 26, width, 20)
        d.text((x, 365), path, font=f, fill="#1b2230")
    d.line([x, 440, W - 60, 440], fill="#e2ddd3", width=2)
    d.text((x, 470), "Kang G. Shin · Academic Family Tree", font=font(26), fill="#1f4e8c")
    img.save(dest, quality=86, optimize=True)


def build_share_pages(env, out: Path, people: list[dict], cards: bool) -> int:
    by_id = {p["id"]: p for p in people}
    (out / "p").mkdir()
    photos = {}
    if cards:
        try:
            import PIL  # noqa: F401
        except ImportError:
            print("Pillow not installed: skipping preview cards")
            cards = False
        else:
            photos = fetch_photos(people, ROOT / ".cache" / "photos")
    tpl = env.get_template("share.html")
    for p in people:
        chain = lineage(p, by_id)
        if cards:
            draw_card(p, chain, photos.get(p["id"]), out / "p" / f"{p['id']}.jpg")
        desc = " → ".join(c["name"] for c in chain) if len(chain) > 1 else "The academic family tree of Prof. Kang G. Shin."
        if p["position"]:
            desc = f"{p['position']}. {desc}"
        (out / "p" / f"{p['id']}.html").write_text(tpl.render(
            person=p, description=desc, site_url=SITE_URL, image=cards and f"{SITE_URL}p/{p['id']}.jpg"))
    return len(photos)


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
    ap.add_argument("--verified", default=str(ROOT / "research" / "verified"))
    ap.add_argument("--no-cards", action="store_true", help="skip the per-person preview images")
    args = ap.parse_args()

    people = load_people(Path(args.db))
    sources = load_sources(people, Path(args.verified))
    for p in people:
        p["sources"] = sources.get(p["id"], [])
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    (out / "data").mkdir(parents=True)

    (out / "data" / "tree.json").write_text(json.dumps(build_tree(people), ensure_ascii=False, separators=(",", ":")))
    shutil.copytree(ROOT / "static", out / "static")
    (out / ".nojekyll").write_text("")

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape(["html"]))
    env.globals.update(site_url=SITE_URL, repo_url=REPO_URL)
    (out / "index.html").write_text(env.get_template("index.html").render(page="index"))
    (out / "directory.html").write_text(
        env.get_template("directory.html").render(page="directory", people=directory_rows(people)))
    photos = build_share_pages(env, out, people, cards=not args.no_cards)

    print(f"Built {out} — {len(people)} people, {sum(1 for p in people if p['sources'])} with sources"
          f"{'' if args.no_cards else f', {photos} card photos'}")


if __name__ == "__main__":
    main()
