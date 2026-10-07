// Filter + click-to-sort for the people tables (Directory, Manage).
// Sortable headers carry data-key; each row's cells carry data-<key> with the sort value.
function initPeopleTable({ tableId, filterId, countId }) {
  const table = document.getElementById(tableId);
  const body = table.tBodies[0];
  const rows = Array.from(body.rows);
  const filter = document.getElementById(filterId);
  const count = document.getElementById(countId);
  const headers = Array.from(table.querySelectorAll("thead th[data-key]"));
  const numeric = new Set(["year", "advisees", "descendants"]);
  let sort = { key: null, dir: 1 };

  function applyFilter() {
    const q = (filter.value || "").trim().toLowerCase();
    let shown = 0;
    rows.forEach((tr) => {
      const hit = !q || (tr.dataset.search || tr.innerText.toLowerCase()).includes(q);
      tr.hidden = !hit;
      if (hit) shown++;
    });
    if (count) count.textContent = q ? `${shown} of ${rows.length} people` : `${rows.length} people`;
  }

  function value(tr, key) {
    const v = tr.querySelector(`[data-${key}]`)?.getAttribute(`data-${key}`) ?? "";
    return numeric.has(key) ? Number(v) : v;
  }

  headers.forEach((th) => {
    th.tabIndex = 0;
    th.title = "Sort";
    const activate = () => {
      const key = th.dataset.key;
      sort.dir = sort.key === key ? -sort.dir : (numeric.has(key) && key !== "year" ? -1 : 1);
      sort.key = key;
      const sorted = rows.slice().sort((a, b) => {
        const va = value(a, key), vb = value(b, key);
        const c = typeof va === "number" ? va - vb : va.localeCompare(vb);
        return sort.dir * c || value(a, "name").localeCompare(value(b, "name"));
      });
      sorted.forEach((tr) => body.appendChild(tr));
      headers.forEach((h) => { h.classList.remove("sorted-asc", "sorted-desc"); h.removeAttribute("aria-sort"); });
      th.classList.add(sort.dir === 1 ? "sorted-asc" : "sorted-desc");
      th.setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
  });

  filter.addEventListener("input", applyFilter);
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== filter) { e.preventDefault(); filter.focus(); }
  });
  applyFilter();
}
