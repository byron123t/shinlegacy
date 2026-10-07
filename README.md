# Kang G. Shin Academic Family Tree

An interactive academic family tree of Prof. Kang G. Shin (University of Michigan, RTCL), covering his PhD students, their students, and beyond. It's a static site hosted on GitHub Pages.

## How it works

- `instance/genealogy.db`: the data (SQLite), the single source of truth.
- `scripts/build_site.py`: turns the database into a static site: `index.html` (tree viewer), `directory.html` and `data/tree.json`.
- `.github/workflows/pages.yml`: rebuilds and publishes the site on every push to `main`.

## Preview locally

```bash
pip install -r requirements.txt
python scripts/build_site.py
python -m http.server -d _site 8000     # open http://localhost:8000
```

## Updating the tree

The site has no editing UI. Change the data, then push:

- **Research new descendants, photos and bios**: follow [docs/research-workflow.md](docs/research-workflow.md). Its last step (`scripts/apply_research.py --apply`) updates the database.
- **Small manual fixes**: edit the database directly, for example:
  ```bash
  sqlite3 instance/genealogy.db "UPDATE people SET url='https://…' WHERE name='Jane Doe';"
  sqlite3 instance/genealogy.db "INSERT INTO people (name, year, institution, advisor_id) VALUES ('New Student', '2027', 'University of Michigan', 1);"
  ```

Commit `instance/genealogy.db` and push to `main`. The site redeploys within a minute or two.

## One-time GitHub Pages setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Pages on a private repository needs GitHub Pro, which students get free through the GitHub Student Developer Pack. Otherwise the repository must be public. The published site is public either way.
