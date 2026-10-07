# Research workflow: finding descendants, websites, photos and bios

How to refresh the academic family tree from public sources: find each person's website and photo, write short bios for Prof. Shin's direct students, and discover PhD students who aren't in the tree yet. Every claim is checked by a second, independent pass before anything is written to the database.

Run it whenever the tree needs updating. Each run adds newly found students to the tree, so the next run can then look for *their* students too (see [Going deeper](#going-deeper-later-runs)).

## Overview

```
 instance/genealogy.db
        │  1. export         scripts/export_people.py
        ▼
 research/batches/*.json     (one file per batch of people, with context)
        │  2. research       one agent per batch, follows "Research instructions"
        ▼
 research/raw/*.json         (claims + sources)
        │  3. verify         a DIFFERENT agent per batch, follows "Verification instructions"
        ▼
 research/verified/*.json    (each claim marked confirmed / rejected / unverifiable)
        │  4. review + apply scripts/apply_research.py  (dry run first)
        ▼
 instance/genealogy.db       (backup taken automatically)
```

| Batch kind | Who | What to find |
|---|---|---|
| `root` | Kang G. Shin | Bio, photo, website, and the **complete** list of his PhD students (two independent searches: his own pages, then dissertation records) |
| `profile` (`g1-*`) | Generation 1: Shin's direct students | Bio (summary, research areas, PhD thesis, notable roles), current position, website, photo, their PhD students |
| `basic` (`g2-*`) | Generation 2 and later | Current position, website, photo, their PhD students |

## 1. Export

```bash
python scripts/export_people.py            # every person → research/batches/
python scripts/export_people.py --since-id 368   # only people added since a previous run
python scripts/export_people.py --only 14 48     # specific people
```

Each batch lists, per person: id, name, institution, year, advisor, the website on record, and the students already in the tree. Researchers use this to disambiguate people and to avoid re-reporting known students.

## 2. Research

Run one research agent per batch file. Sonnet is fine and cheaper, and since batches are independent you can run many in parallel.

> **Web search is capped per Claude Code session (200 searches, shared by every agent in it).** One full pass over ~370 people needs more than that. Split the work across sessions: for example, run generation 1 in one session, generation 2 in the next, and the gap-filling pass in a third. Page fetches and image downloads aren't capped, so verification (step 3) can run in any session.
>
> **Keep batches small.** Each agent has a limited web-search budget. A 20-person batch runs out partway through and leaves the rest blank, so use the export defaults: 3 deep profiles or 5 basic people per batch. Tell the agent to spread its searches evenly across people.

Prompt:

> Follow the **Research instructions** in `docs/research-workflow.md` for `research/batches/<batch>.json` and write `research/raw/<batch>.json`.

### Research instructions

Use WebSearch and WebFetch. You may use `curl` to check that a URL resolves. Don't modify anything except your output file.

For **each person** in the batch:

- **website**: the best single link, in order of preference: personal homepage > current official faculty/lab/company profile > Google Scholar > DBLP. Avoid LinkedIn unless nothing else exists. If the website on record still works and is still the best link, return it.
- **photo**: a *direct* image URL of a headshot of this person alone, from their personal site or an official institutional page, plus `page_url`, the page that embeds it. Never use search-engine thumbnails, LinkedIn/Facebook/X CDN links (they expire), group photos, logos or placeholders.
- **current_position**: one line, e.g. "Professor of EECS, Texas A&M University".
- **bio** (`root` and `profile` batches only): 2–4 neutral sentences, plus `research_areas`, `phd_institution`, `phd_year`, `thesis_title`, `notable` (awards, fellowships, major roles), and `sources`. Write with no gendered pronouns; use the person's name or role.
- **students**: PhD students this person advised or co-advised, graduated or current, who are **not** already in `students_in_tree` (watch for name variants such as "Jen-Wei Huang" / "Jen Wei Huang" / "Huang, Jen-Wei"). Exclude MS students, undergraduates, postdocs and visitors. Each student needs `name`, `phd_year` (or `"current"`), `current_institution`, `website` (if obvious), `source_url`, and `evidence`: a short quote or description showing the advising relationship. Be exhaustive for faculty: check their lab's people/alumni page, their CV, dissertation repositories and the Mathematics Genealogy Project. For industry people who never supervised PhDs, return an empty list and say so in `notes`.

For the `root` batch, find Kang G. Shin's complete student list in **two independent passes** and merge them. First pass: RTCL pages, alumni lists and his CV. Second pass: dissertation records, i.e. Deep Blue (`deepblue.lib.umich.edu`) theses with Shin as chair or co-chair, ProQuest, and the Mathematics Genealogy Project.

Rules:
- **Identity first.** Many names are common. Only accept information you can tie to *this* person through their advisor, PhD institution, field, or the affiliation on record.
- **Never invent** URLs, names, years or facts. Every claim needs a `source_url` you actually opened. `null` or an empty list beats a guess.
- Good sources: personal and faculty pages, lab people/alumni pages, university dissertation repositories, ProQuest abstracts, mathgenealogy.org, DBLP, IEEE/ACM author bios, university news releases, Wikipedia.

### Raw output format: `research/raw/<batch>.json`

```json
{
  "batch": "g1-02",
  "people": [
    {
      "id": 14,
      "name": "Ming-Syan (Frank) Chen",
      "website": {"url": "https://…", "source_note": "NTU EE faculty page"},
      "photo": {"image_url": "https://…/chen.jpg", "page_url": "https://…"},
      "current_position": "Distinguished Professor, National Taiwan University",
      "bio": {
        "summary": "…", "research_areas": ["…"], "phd_institution": "University of Michigan",
        "phd_year": "1988", "thesis_title": "…", "notable": ["IEEE Fellow"], "sources": ["https://…"]
      },
      "students": [
        {"name": "…", "phd_year": "2004", "current_institution": "…", "website": null,
         "source_url": "https://…", "evidence": "Listed under 'Ph.D. graduates' on Chen's lab page"}
      ],
      "notes": "What was searched; why anything is missing."
    }
  ]
}
```

Use `null` for anything not found. For `basic` batches `bio` is always `null`.

### Gap-filling pass

After the first pass, some people will still have no website or photo. Often that's because a batch ran out of searches, not because nothing exists. List the gaps and research just those people again in small batches, with the earlier `notes` as hints:

```bash
python scripts/find_gaps.py     # writes research/batches/gap-*.json for people still missing website/photo
```

The research agent writes `research/raw/gap-NN.json`. It can return *only* the fields it newly found, with `null` for the rest; the apply step merges all files per person.

## 3. Verify

Run a **different** agent per raw file. It must not trust the researcher; it re-opens every source itself. Prompt:

> Follow the **Verification instructions** in `docs/research-workflow.md` for `research/raw/<batch>.json` (people context in `research/batches/<batch>.json`) and write `research/verified/<batch>.json`.

### Verification instructions

Be skeptical. Mark a claim `"rejected"` when the evidence is missing, ambiguous, or could be about someone else with the same name. Use `"unverifiable"` only when a source can't be loaded at all. Never add new claims; only check, correct or reject.

- **website**: fetch it. It must load, and clearly be this person's own page or official profile (name present, consistent affiliation or field). Reject dead links, wrong people and generic search or directory pages.
- **photo**, all three steps:
  1. Fetch `page_url`. It must name this person and embed `image_url` (check the `<img src>`; relative paths are fine).
  2. Download `image_url` with `curl -sL` into a temporary directory (`mktemp -d`, never inside the repo). It must return HTTP 200 with an `image/*` content type.
  3. Open the downloaded file with the Read tool and look at it. It must be a real photograph of a single person (headshot or portrait), not a logo, placeholder, group photo, poster or diagram.
- **current_position**: confirm it from a current official page.
- **bio**: check every sentence and field against the sources. Rewrite the summary to keep **only** confirmed facts (no gendered pronouns), and drop unconfirmed fields. Mark it `confirmed` only if a meaningful summary remains.
- **students**: open each `source_url`. It must explicitly show the advising relationship with *this* advisor: a student or alumni list on the advisor's or lab's page, "Advisor"/"Chair" on the dissertation, or a mathgenealogy.org record. Correct `phd_year` or `current_institution` if the sources say otherwise; otherwise set unconfirmed fields to `null`.

### Verified output format: `research/verified/<batch>.json`

Same shape as the raw file, but every claim gains a `verdict` and a `reason`, and values are the *corrected* ones:

```json
{
  "batch": "g1-02",
  "people": [
    {
      "id": 14,
      "name": "Ming-Syan (Frank) Chen",
      "website": {"verdict": "confirmed", "url": "https://…", "reason": "NTU page, name and photo match"},
      "photo": {"verdict": "confirmed", "image_url": "https://…", "page_url": "https://…", "reason": "200 image/jpeg; single-person headshot; embedded on page"},
      "current_position": {"verdict": "confirmed", "value": "…", "reason": "…"},
      "bio": {"verdict": "confirmed", "summary": "…", "research_areas": [], "phd_institution": "…", "phd_year": "…",
              "thesis_title": "…", "notable": [], "sources": [], "reason": "dropped one unsupported award"},
      "students": [
        {"name": "…", "verdict": "confirmed", "phd_year": "2004", "current_institution": "…", "website": null,
         "source_url": "https://…", "reason": "Listed on lab alumni page"}
      ]
    }
  ]
}
```

A claim that was `null` in the raw file stays `null`.

## 4. Review and apply

```bash
python scripts/apply_research.py                 # dry run: prints every change it would make
python scripts/apply_research.py --apply         # writes to instance/genealogy.db (backs it up first)
python scripts/apply_research.py --apply --replace-websites   # also overwrite existing websites that differ
```

Only `"confirmed"` claims are applied:
- **website**: filled in when the person has none. Existing ones are only replaced with `--replace-websites`; otherwise a different confirmed URL is reported for manual review.
- **photo, current position, bio**: stored on the person and shown in the tree's details panel and slideshow.
- **students**: added under their advisor, skipping anyone whose normalized name is already in the tree. The dry run lists students claimed under two different advisors, so you can decide.

Skim the dry run before applying, especially new students and any URL replacements. Spot-check a few photos in the browser afterwards.

## Going deeper (later runs)

New students added in step 4 have no research yet. Run again for just them:

```bash
python scripts/export_people.py --since-id <first new id>
```

Then repeat steps 2–4. Each round goes one generation deeper. Stop when a round finds no new students.

## Tips

- Keep `research/raw` and `research/verified` from each run. They record why every fact is in the tree. Move old runs to `research/runs/<date>/` before starting a new one.
- To redo one batch, delete its raw and verified files and rerun steps 2–3 for it.
- Rejected claims and their reasons stay in the verified files and are worth a skim: they often point to a better source a human can confirm.
