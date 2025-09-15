#!/usr/bin/env python3
"""
Delete an accidental ROOT person and ALL of their descendants from a genealogy-like SQLite DB.

Defaults:
  --name "Jennifer Rexford"   (the fake root to remove)
  --table auto-detected table with columns (id, name, advisor_id)
Safety:
  * Makes a timestamped backup first.
  * Supports --dry-run to preview deletions without committing.
  * Only deletes roots where advisor_id IS NULL (so the real student under Kang is safe).

Usage:
  python delete_subtree.py --db genealogy.db --name "Jennifer Rexford"
  # dry-run:
  python delete_subtree.py --db genealogy.db --name "Jennifer Rexford" --dry-run
  # delete by explicit root id (skips name matching):
  python delete_subtree.py --db genealogy.db --root-id 109
"""

import argparse
import datetime
import shutil
import sqlite3
from pathlib import Path
from typing import List, Optional, Tuple


def backup_db(db_path: Path) -> Path:
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = db_path.with_name(f"{db_path.stem}.backup_{ts}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def detect_person_table(conn: sqlite3.Connection) -> str:
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    for (tname,) in cur.fetchall():
        try:
            cur.execute(f"PRAGMA table_info({tname})")
            cols = {row[1].lower() for row in cur.fetchall()}
            if {"id", "name", "advisor_id"}.issubset(cols):
                return tname
        except Exception:
            pass
    raise RuntimeError("Could not find a table with columns (id, name, advisor_id).")


def list_roots(conn: sqlite3.Connection, table: str) -> List[Tuple[int, str]]:
    cur = conn.cursor()
    cur.execute(f"SELECT id, name FROM {table} WHERE advisor_id IS NULL ORDER BY name")
    return [(int(r[0]), r[1]) for r in cur.fetchall()]


def find_fake_root_ids_by_name(conn: sqlite3.Connection, table: str, name: str) -> List[int]:
    cur = conn.cursor()
    cur.execute(
        f"SELECT id FROM {table} WHERE TRIM(name)=TRIM(?) AND advisor_id IS NULL",
        (name,),
    )
    return [int(r[0]) for r in cur.fetchall()]


def collect_subtree_ids(conn: sqlite3.Connection, table: str, root_id: int) -> List[int]:
    # Use a recursive CTE to gather all descendants (including the root itself)
    cur = conn.cursor()
    cur.execute(
        f"""
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM {table} WHERE id = ?
          UNION ALL
          SELECT p.id
          FROM {table} p
          JOIN subtree s ON p.advisor_id = s.id
        )
        SELECT id FROM subtree
        """,
        (root_id,),
    )
    return [int(r[0]) for r in cur.fetchall()]


def delete_subtree(conn: sqlite3.Connection, table: str, ids: List[int]) -> int:
    if not ids:
        return 0
    qmarks = ",".join("?" for _ in ids)
    cur = conn.cursor()
    cur.execute(f"DELETE FROM {table} WHERE id IN ({qmarks})", ids)
    return cur.rowcount


def main():
    ap = argparse.ArgumentParser(description="Delete a fake root person and ALL of their descendants.")
    ap.add_argument("--db", required=True, help="Path to SQLite DB, e.g., genealogy.db")
    ap.add_argument("--name", default="Jennifer Rexford", help="Name of the FAKE ROOT to delete (advisor_id IS NULL)")
    ap.add_argument("--root-id", type=int, default=None, help="Explicit id of the fake root (skips name match)")
    ap.add_argument("--dry-run", action="store_true", help="Preview deletions without committing")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise FileNotFoundError(f"DB not found: {db_path}")

    # Backup first
    backup_path = backup_db(db_path)
    print(f"Backup written to: {backup_path}")

    with sqlite3.connect(str(db_path)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")  # enforce FK integrity if defined

        table = detect_person_table(conn)
        print(f"Detected person table: {table}")

        # Show roots before
        print("\nRoots BEFORE:")
        for rid, rname in list_roots(conn, table):
            print(f"  id={rid:>4}  name='{rname}'")

        # Decide which fake roots to delete
        if args.root_id is not None:
            fake_root_ids = [args.root_id]
        else:
            fake_root_ids = find_fake_root_ids_by_name(conn, table, args.name)

        if not fake_root_ids:
            print(f"\nNo fake root(s) found for name='{args.name}' with advisor_id IS NULL. Nothing to delete.")
            return

        total_deleted = 0
        for root_id in fake_root_ids:
            subtree_ids = collect_subtree_ids(conn, table, root_id)
            print(f"\nWill delete subtree rooted at id={root_id}: {len(subtree_ids)} row(s)")
            print(f"  ids: {subtree_ids}")

            if not args.dry_run:
                deleted = delete_subtree(conn, table, subtree_ids)
                total_deleted += deleted

        if not args.dry_run:
            conn.commit()
            print(f"\nDeleted {total_deleted} row(s) across {len(fake_root_ids)} subtree(s).")
        else:
            print("\n(DRY-RUN) No changes were committed.")

        # Show roots after
        print("\nRoots AFTER:")
        for rid, rname in list_roots(conn, table):
            print(f"  id={rid:>4}  name='{rname}'")


if __name__ == "__main__":
    main()