from __future__ import annotations

import hmac
import json
import os
import re
from datetime import datetime
from flask import (
    Flask, render_template, request, redirect, url_for,
    jsonify, session, flash
)
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import inspect, text


# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///genealogy.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)

YEAR_FALLBACK = 9999
SHARED_PASSWORD = os.environ.get("GENEALOGY_PASSWORD", "rtcl")  # required to add/edit

# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------
class Person(db.Model):
    __tablename__ = "people"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    year = db.Column(db.String(16))  # keep free-form: "2020", "PhD 2019", etc.
    institution = db.Column(db.String(255))
    url = db.Column(db.String(500))
    advisor_id = db.Column(db.Integer, db.ForeignKey("people.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    # Filled by scripts/apply_research.py (see docs/research-workflow.md) or the edit form
    photo_url = db.Column(db.String(500))
    photo_source = db.Column(db.String(500))  # page the photo comes from (for attribution)
    position = db.Column(db.String(255))      # current role, e.g. "Professor of EECS, ..."
    bio = db.Column(db.Text)                  # JSON: summary, research_areas, thesis_title, notable, sources

    advisor = db.relationship("Person", remote_side=[id], backref="advisees")

    @property
    def year_num(self) -> int:
        return parse_year(self.year)

    @property
    def descendant_count(self) -> int:
        return sum(1 + c.descendant_count for c in self.advisees)

    def to_node(self):
        return {
            "id": self.id,
            "name": self.name,
            "year": self.year or "",
            "institution": self.institution or "",
            "url": self.url or "",
            "advisor_id": self.advisor_id,
            "year_num": self.year_num,
            "photo_url": self.photo_url or "",
            "photo_source": self.photo_source or "",
            "position": self.position or "",
            "bio": self.bio_data,
        }

    @property
    def bio_data(self) -> dict | None:
        try:
            return json.loads(self.bio) if self.bio else None
        except ValueError:
            return None

# -----------------------------------------------------------------------------
# DB bootstrap
# -----------------------------------------------------------------------------
# Columns added after the first release; created in place on older databases.
ADDED_COLUMNS = {
    "photo_url": "VARCHAR(500)",
    "photo_source": "VARCHAR(500)",
    "position": "VARCHAR(255)",
    "bio": "TEXT",
}


def bootstrap_if_empty():
    with app.app_context():
        db.create_all()
        have = {c["name"] for c in inspect(db.engine).get_columns("people")}
        with db.engine.begin() as conn:
            for name, ddl in ADDED_COLUMNS.items():
                if name not in have:
                    conn.execute(text(f"ALTER TABLE people ADD COLUMN {name} {ddl}"))
        if Person.query.count() == 0:
            # Seed a single root person (edit as you like)
            root = Person(
                name=os.environ.get("ROOT_NAME", "Main Person"),
                institution=os.environ.get("ROOT_INSTITUTION", ""),
                year=os.environ.get("ROOT_YEAR", ""),
                url=os.environ.get("ROOT_URL", ""),
                advisor_id=None
            )
            db.session.add(root)
            db.session.commit()

bootstrap_if_empty()

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def build_tree_json():
    people = [p.to_node() for p in Person.query.order_by(Person.id).all()]
    by_id = {p["id"]: p for p in people}
    for p in people:
        p["children"] = []
    roots = []
    for p in people:
        aid = p["advisor_id"]
        if aid is None:
            roots.append(p)
        else:
            parent = by_id.get(aid)
            (parent["children"] if parent else roots).append(p)

    def sort_children(node):
        node["children"].sort(key=lambda c: (c.get("year_num", YEAR_FALLBACK),
                                             (c.get("name") or "").lower()))
        for ch in node["children"]:
            sort_children(ch)

    if not roots:
        return {}
    if len(roots) == 1:
        sort_children(roots[0])
        return roots[0]
    virtual = {
        "id": 0, "name": "Genealogy", "year": "", "institution": "",
        "url": "", "advisor_id": None, "children": roots, "year_num": YEAR_FALLBACK
    }
    sort_children(virtual)
    return virtual

def is_authed():
    return session.get("authed") is True

def find_person(pid: int):
    return db.session.get(Person, pid)

def would_create_cycle(person_id: int, new_advisor_id: int | None) -> bool:
    """Climb up from new_advisor_id; if we hit person_id, it's a cycle."""
    if new_advisor_id is None:
        return False
    cur = find_person(new_advisor_id)
    while cur is not None:
        if cur.id == person_id:
            return True
        cur = cur.advisor
    return False

def reassign_children_to_grandparent(person: Person):
    """Reattach all children to person's advisor (keeps subtree intact)."""
    for child in list(person.advisees):
        child.advisor_id = person.advisor_id

def delete_subtree(person: Person):
    """Recursively delete person and all descendants."""
    for child in list(person.advisees):
        delete_subtree(child)
    db.session.delete(person)

def parse_year(text: str | None) -> int:
    """Return first 4-digit year (1000–2999) or YEAR_FALLBACK if none."""
    if not text:
        return YEAR_FALLBACK
    m = re.search(r"\b(1[0-9]{3}|2[0-9]{3})\b", text)
    return int(m.group(1)) if m else YEAR_FALLBACK
# -----------------------------------------------------------------------------
# Routes: views
# -----------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html", authed=is_authed())

@app.get("/login")
def login_get():
    return render_template("login.html", authed=is_authed())

@app.post("/login")
def login_post():
    pw = request.form.get("password", "")
    if hmac.compare_digest(pw.encode(), SHARED_PASSWORD.encode()):
        session["authed"] = True
        flash("Welcome! You can now add yourself to the tree.", "success")
        nxt = request.args.get("next", "")
        return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("add_get"))
    flash("Incorrect password.", "danger")
    return redirect(url_for("login_get", next=request.args.get("next")))

@app.get("/logout")
def logout():
    session.pop("authed", None)
    flash("Logged out.", "info")
    return redirect(url_for("index"))

@app.get("/add")
def add_get():
    if not is_authed():
        flash("Please log in to add yourself.", "warning")
        return redirect(url_for("login_get", next=request.full_path.rstrip("?")))
    advisor = find_person(request.args.get("advisor", type=int) or 0)
    return render_template("add.html", advisor=advisor, authed=is_authed())

@app.post("/add")
def add_post():
    if not is_authed():
        flash("Please log in to add yourself.", "warning")
        return redirect(url_for("login_get", next=request.full_path.rstrip("?")))

    name = (request.form.get("name") or "").strip()
    year = (request.form.get("year") or "").strip()
    institution = (request.form.get("institution") or "").strip()
    url = (request.form.get("url") or "").strip()
    parent_id_raw = request.form.get("advisor_id", "").strip()
    advisor_id = int(parent_id_raw) if parent_id_raw.isdigit() else None

    if not name:
        flash("Name is required.", "danger")
        return redirect(url_for("add_get"))

    # NEW: require a parent/advisor
    if advisor_id is None:
        flash("Please choose an advisor/parent node.", "danger")
        return redirect(url_for("add_get"))

    # Validate that the selected parent exists
    if not find_person(advisor_id):
        flash("Selected advisor/parent does not exist.", "danger")
        return redirect(url_for("add_get"))

    person = Person(
        name=name, year=year, institution=institution,
        url=url, advisor_id=advisor_id,
        position=(request.form.get("position") or "").strip() or None,
        photo_url=(request.form.get("photo_url") or "").strip() or None,
    )
    db.session.add(person)
    db.session.commit()
    flash(f"Added {name} to the tree!", "success")
    return redirect(url_for("index", id=person.id))

# -------- Manage (list) --------
@app.get("/manage")
def manage_list():
    if not is_authed():
        flash("Please log in to manage people.", "warning")
        return redirect(url_for("login_get", next=request.full_path.rstrip("?")))
    people = Person.query.all()
    people.sort(key=lambda p: (parse_year(p.year), (p.name or "").lower()))
    return render_template("manage.html", people=people, authed=is_authed())

@app.get("/directory")
def directory():
    people = Person.query.all()
    people.sort(key=lambda p: (parse_year(p.year), (p.name or "").lower()))
    return render_template("directory.html", people=people, authed=is_authed())

# -------- Edit --------
@app.get("/edit/<int:person_id>")
def edit_get(person_id):
    if not is_authed():
        flash("Please log in to edit.", "warning")
        return redirect(url_for("login_get", next=request.full_path.rstrip("?")))
    person = find_person(person_id)
    if not person:
        flash("Person not found.", "danger")
        return redirect(url_for("manage_list"))
    # advisor choices exclude the person itself
    can_change_parent = person.advisor_id is not None  # keep single root simple
    return render_template("edit.html", person=person, can_change_parent=can_change_parent, authed=is_authed())

@app.post("/edit/<int:person_id>")
def edit_post(person_id):
    if not is_authed():
        flash("Please log in to edit.", "warning")
        return redirect(url_for("login_get", next=request.full_path.rstrip("?")))

    person = find_person(person_id)
    if not person:
        flash("Person not found.", "danger")
        return redirect(url_for("manage_list"))

    name = (request.form.get("name") or "").strip()
    year = (request.form.get("year") or "").strip()
    institution = (request.form.get("institution") or "").strip()
    url = (request.form.get("url") or "").strip()

    # Parent handling (keep single-root: root has no advisor and cannot be given one)
    new_advisor_id = person.advisor_id
    if person.advisor_id is not None:  # not root -> require a parent choice
        parent_id_raw = (request.form.get("advisor_id") or "").strip()
        if not parent_id_raw.isdigit():
            flash("Please choose a valid advisor/parent.", "danger")
            return redirect(url_for("edit_get", person_id=person.id))
        new_advisor_id = int(parent_id_raw)
        if new_advisor_id == person.id:
            flash("A person cannot advise themself.", "danger")
            return redirect(url_for("edit_get", person_id=person.id))
        if not find_person(new_advisor_id):
            flash("Selected advisor/parent does not exist.", "danger")
            return redirect(url_for("edit_get", person_id=person.id))
        if would_create_cycle(person.id, new_advisor_id):
            flash("That change would create a cycle in the tree.", "danger")
            return redirect(url_for("edit_get", person_id=person.id))

    if not name:
        flash("Name is required.", "danger")
        return redirect(url_for("edit_get", person_id=person.id))

    person.name = name
    person.year = year
    person.institution = institution
    person.url = url
    person.position = (request.form.get("position") or "").strip() or None
    person.photo_url = (request.form.get("photo_url") or "").strip() or None
    person.advisor_id = new_advisor_id
    db.session.commit()
    flash("Person updated.", "success")
    return redirect(url_for("index", id=person.id))

# -------- Delete --------
@app.post("/delete/<int:person_id>")
def delete_post(person_id):
    if not is_authed():
        flash("Please log in to delete.", "warning")
        return redirect(url_for("login_get", next=request.full_path.rstrip("?")))

    person = find_person(person_id)
    if not person:
        flash("Person not found.", "danger")
        return redirect(url_for("manage_list"))

    # keep it simple: do not allow deleting the single root
    if person.advisor_id is None:
        flash("Cannot delete the root person.", "danger")
        return redirect(url_for("manage_list"))

    mode = (request.form.get("mode") or "reassign").strip()  # "reassign" | "cascade"

    if mode == "cascade":
        delete_subtree(person)
    else:
        # default: reattach children to the deleted person's advisor
        reassign_children_to_grandparent(person)
        db.session.delete(person)

    db.session.commit()
    flash("Delete completed.", "success")
    return redirect(url_for("manage_list"))

# -----------------------------------------------------------------------------
# Routes: APIs
# -----------------------------------------------------------------------------
@app.get("/api/tree")
def api_tree():
    return jsonify(build_tree_json())

@app.get("/api/nodes")
def api_nodes():
    people = [p.to_node() for p in Person.query.all()]
    people.sort(key=lambda n: (n.get("year_num", YEAR_FALLBACK), (n["name"] or "").lower()))
    return jsonify(people)

# -----------------------------------------------------------------------------
# Run
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(debug=True)