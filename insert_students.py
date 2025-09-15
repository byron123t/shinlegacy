#!/usr/bin/env python3
"""
Ingest messy student blurbs into your SQLite DB using OpenAI GPT-5
and your existing Flask/SQLAlchemy Person model.

- Input: a .txt file (can include lots of unrelated sections)
- Extraction: OpenAI Chat Completions (model 'gpt-5') -> strict JSON
- Insert: attaches new rows under an EXISTING advisor person.
          By default this is the root "Kang G. Shin" (created only if missing).
          If you pass --advisor "Some Student", that person must already exist.
          Use --advisor-id to disambiguate duplicates.

Usage:
  export OPENAI_API_KEY=sk-...
  pip install openai
  python ingest_students_to_db.py students.txt
  # attach under an existing student of Kang G. Shin:
  python ingest_students_to_db.py students.txt --advisor "Existing Student"
  # unambiguous:
  python ingest_students_to_db.py students.txt --advisor-id 123
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Optional
from openai import AzureOpenAI


# ---- Prompt: what to extract and how to format it ----
SCHEMA_INSTRUCTIONS = """
For each relevant entry, extract:
- name: full name (string).
- year: concise graduation tag for the website (<= 16 chars). Prefer "<YYYY>"
- institution: the first post-graduation placement/employer/org mentioned (string).
               If none is clear, return "".
- url: an explicit web URL if present; otherwise "".

Return EXACTLY this JSON object (no commentary):
{
  "people": [
    {"name": "...", "year": "2024", "institution": "...", "url": ""},
    ...
  ]
}
"""


class OpenAIAPI:

    def __init__(self, deployment):
        self.endpoint = 'https://vlmprivacy.openai.azure.com/'
        self.subscription_key = os.getenv("AZURE_OPENAI_KEY")
        self.deployment = deployment
        if deployment not in {"gpt-4o", "o4-mini", "gpt-4.1-mini", "gpt-5"}:
            raise ValueError("Invalid deployment name. Must be 'gpt-4o', 'o4-mini', 'gpt-4.1-mini', or 'gpt-5'.")
        self.client = AzureOpenAI(
            azure_endpoint=self.endpoint,
            api_key=self.subscription_key,
            api_version="2025-01-01-preview",
        )

    def chat_completion(self, messages, max_tokens=16384):
        completion = self.client.chat.completions.create(
            model=self.deployment,
            messages=messages,
            max_completion_tokens=max_tokens,
            stop=None,
            stream=False
        )
        return completion



# ---- OpenAI call ----
def extract_people_with_openai(raw_text: str, model: str = "gpt-4o") -> List[Dict]:
    # >>> changed: honor the --model flag
    client = OpenAIAPI(model)
    resp = client.chat_completion(
        messages=[
            {
                "role": "system",
                "content": (
                    "You normalize academic CV text into compact website records. "
                    "Only return the requested JSON."
                ),
            },
            {
                "role": "user",
                "content": SCHEMA_INSTRUCTIONS.strip()
                           + "\n\n--- BEGIN TEXT ---\n"
                           + raw_text.strip()
                           + "\n--- END TEXT ---\n",
            },
        ],
        max_tokens=16384
    )
    content = resp.choices[0].message.content
    # Parse JSON (be resilient to any accidental wrappers)
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        start, end = content.find("{"), content.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(content[start:end+1])
        else:
            raise

    people = data.get("people", [])
    cleaned = []
    for p in people:
        name = str(p.get("name", "")).strip()
        year = str(p.get("year", "")).strip()
        inst = str(p.get("institution", "")).strip()
        url  = str(p.get("url", "")).strip()
        if not name:
            continue
        # Ensure year fits your String(16) column (SQLite won’t enforce, but keep tidy)
        if len(year) > 16:
            year = year[:16]
        cleaned.append({"name": name, "year": year, "institution": inst, "url": url})
    return cleaned


# ---- DB insert via your Flask app ----
def upsert_into_sqlite(rows: List[Dict], advisor_name: str, advisor_id: Optional[int] = None, root_name_default: str = "Kang G. Shin"):
    """
    Imports your app.py and Person model, ensures DB exists, resolves the advisor,
    and upserts each person under that advisor.

    Resolution rules:
      - If --advisor-id is provided: use that Person.id or fail if missing.
      - Else, find Person by exact name (no advisor_id filter). If unique, use it.
      - If none found and the name equals root_name_default, create/get the root (advisor_id=None).
      - Otherwise (none found for non-root), FAIL rather than creating a bogus root.
      - If multiple people share the name, prefer the one whose ultimate root is root_name_default.
        If still ambiguous, FAIL with a helpful message.
    """
    try:
        from app import app, db, Person  # relies on your existing code
    except Exception as e:
        raise RuntimeError(
            "Failed to import app.py (need app, db, Person). "
            "Make sure this script is next to app.py."
        ) from e

    with app.app_context():
        db.create_all()

        # ---- helpers ---------------------------------------------------------
        def get_or_create_root(name: str) -> "Person":
            """Create/get the true root node (advisor_id=None) for the root name."""
            root = Person.query.filter_by(name=name, advisor_id=None).first()
            if not root:
                root = Person(name=name, year="", institution="", url="", advisor_id=None)
                db.session.add(root)
                db.session.commit()
            return root

        def ultimate_root(person: "Person") -> "Person":
            """Walk up the advisor chain to the topmost ancestor."""
            seen = set()
            cur = person
            while cur and cur.advisor_id is not None and cur.id not in seen:
                seen.add(cur.id)
                cur = Person.query.get(cur.advisor_id)
            return cur if cur else person

        def resolve_advisor_by_name(name: str) -> "Person":
            matches = Person.query.filter_by(name=name).all()

            if len(matches) == 1:
                return matches[0]

            if len(matches) == 0:
                # Only create a node if the name is the official root name
                if name == root_name_default:
                    return get_or_create_root(name)
                raise RuntimeError(
                    f"Advisor '{name}' not found. Refusing to create a new root node.\n"
                    f"Create this person first (under '{root_name_default}') or pass --advisor-id."
                )

            # Multiple with same name: try to pick the one under the root
            under_root = [p for p in matches if (ultimate_root(p) and ultimate_root(p).name == root_name_default)]
            if len(under_root) == 1:
                return under_root[0]

            # Still ambiguous — ask for ID explicitly
            detail_lines = []
            for p in matches:
                root = ultimate_root(p)
                detail_lines.append(f"- id={p.id} name='{p.name}' year='{p.year or ''}' root='{root.name if root else ''}'")
            raise RuntimeError(
                "Multiple people share that name. Disambiguate with --advisor-id.\n"
                + "\n".join(detail_lines)
            )

        # ---- resolve advisor (no accidental new root creation) ---------------
        if advisor_id is not None:
            advisor = Person.query.get(advisor_id)
            if not advisor:
                raise RuntimeError(f"--advisor-id {advisor_id} not found in Person table.")
        else:
            advisor = resolve_advisor_by_name(advisor_name)

        # Optional safety: ensure non-root advisors ultimately descend from the configured root
        root_for_advisor = ultimate_root(advisor)
        if root_for_advisor and root_for_advisor.name != root_name_default:
            # Not a hard error, but warn loudly to stderr so you notice.
            print(
                f"Warning: selected advisor '{advisor.name}' is not under root '{root_name_default}' "
                f"(found root '{root_for_advisor.name}'). Proceeding.",
                file=sys.stderr
            )

        # ---- upsert people under the chosen advisor --------------------------
        added, updated = 0, 0
        for r in rows:
            person = Person.query.filter_by(name=r["name"]).first()
            if person is None:
                person = Person(
                    name=r["name"],
                    year=r.get("year", ""),
                    institution=r.get("institution", ""),
                    url=r.get("url", ""),
                    advisor_id=advisor.id,  # >>> changed: attach under the resolved advisor
                )
                db.session.add(person)
                added += 1
            else:
                # Update fields & (re)attach under selected advisor (explicit re-parenting)
                person.year = r.get("year", "") or person.year or ""
                person.institution = r.get("institution", "") or person.institution or ""
                person.url = r.get("url", "") or person.url or ""
                person.advisor_id = advisor.id  # >>> changed
                updated += 1

        db.session.commit()
        print(f"DB upsert complete. Added: {added}  Updated: {updated}")


def main():
    ap = argparse.ArgumentParser(description="Extract PhD students from text and insert into genealogy.db")
    ap.add_argument("input", type=Path, help="Path to input .txt file")
    ap.add_argument("--advisor", default="Kang G. Shin",
                    help='Advisor name to attach under (must already exist unless it equals the root name).')
    ap.add_argument("--advisor-id", type=int, default=None,
                    help="Advisor Person.id to attach under (avoids ambiguity).")
    ap.add_argument("--model", default="gpt-4o", help='OpenAI model to use (default: gpt-4o)')
    args = ap.parse_args()

    raw = args.input.read_text(encoding="utf-8")
    if not raw.strip():
        print("Input file is empty.", file=sys.stderr)
        sys.exit(1)

    print("Calling OpenAI to normalize entries…")
    people = extract_people_with_openai(raw, model=args.model)
    if not people:
        print("No PhD entries extracted — check the input content.", file=sys.stderr)
        sys.exit(2)

    target = f"id={args.advisor_id}" if args.advisor_id is not None else f"name='{args.advisor}'"
    print(f"Parsed {len(people)} people. Inserting into DB under advisor: {target}")
    # For visibility, print a compact preview (first 3)
    print(people[:3] + (["…"] if len(people) > 3 else []))

    try:
        upsert_into_sqlite(
            people,
            advisor_name=args.advisor,           # used only if advisor_id is None
            advisor_id=args.advisor_id,          # >>> changed: allow explicit id
            root_name_default="Kang G. Shin",    # keep default root the same
        )
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(3)

    print("Done.")


if __name__ == "__main__":
    main()