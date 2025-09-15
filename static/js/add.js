(function () {
  const input = document.getElementById("parentInput");
  const list = document.getElementById("parentList");
  const hiddenId = document.getElementById("advisorId");
  const err = document.getElementById("parentError");
  const form = input.closest("form");

  let nodes = [];      // {id, name, institution, year}
  let items = [];      // filtered items currently shown
  let activeIndex = -1;

  const labelFor = (n) => {
    const inst = n.institution ? ` — ${n.institution}` : "";
    const year = n.year ? ` (${n.year})` : "";
    return `${n.name}${inst}${year}`;
  };

  const fetchNodes = async () => {
    const res = await fetch("/api/nodes");
    const data = await res.json();
    nodes = data.map(n => ({
      id: n.id,
      name: n.name || "",
      institution: n.institution || "",
      year: n.year || ""
    }));
  };

  const openList = () => {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const closeList = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    activeIndex = -1;
    list.innerHTML = "";
  };

  const setActive = (idx) => {
    activeIndex = idx;
    Array.from(list.children).forEach((el, i) =>
      el.setAttribute("aria-selected", i === idx ? "true" : "false")
    );
  };

  const pick = (node) => {
    input.value = labelFor(node);
    hiddenId.value = String(node.id);
    err.hidden = true;
    closeList();
  };

  const filterAndRender = (q) => {
    const qq = q.trim().toLowerCase();
    if (!qq) { closeList(); hiddenId.value = ""; return; }

    // simple contains across name + institution
    items = nodes.filter(n =>
      n.name.toLowerCase().includes(qq) ||
      n.institution.toLowerCase().includes(qq)
    ).slice(0, 20);

    if (!items.length) {
      list.innerHTML = `<div class="typeahead-item" aria-selected="false" aria-disabled="true">No matches</div>`;
      openList();
      hiddenId.value = "";
      return;
    }

    list.innerHTML = "";
    items.forEach((n, i) => {
      const el = document.createElement("div");
      el.className = "typeahead-item";
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", "false");
      el.textContent = labelFor(n);
      el.addEventListener("mousedown", (e) => { // mousedown so blur doesn't kill it
        e.preventDefault();
        pick(n);
      });
      list.appendChild(el);
    });
    setActive(0);
    openList();
    hiddenId.value = "";
  };

  // Event wiring
  input.addEventListener("input", () => {
    filterAndRender(input.value);
  });

  input.addEventListener("focus", () => {
    if (input.value && list.hidden) filterAndRender(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!items.length) return;
        setActive((activeIndex + 1) % items.length);
        ensureVisible(activeIndex);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!items.length) return;
        setActive((activeIndex - 1 + items.length) % items.length);
        ensureVisible(activeIndex);
        break;
      case "Enter":
        e.preventDefault();
        if (items[activeIndex]) pick(items[activeIndex]);
        break;
      case "Escape":
        closeList();
        break;
    }
  });

  input.addEventListener("blur", () => {
    // Close after click-handlers run
    setTimeout(() => {
      closeList();
      // If user typed but didn’t select, invalidate
      if (!hiddenId.value) {
        // Let native required message handle empty; show ours for non-empty mismatch
        if (input.value.trim()) err.hidden = false;
      }
    }, 0);
  });

  list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on input

  const ensureVisible = (idx) => {
    const el = list.children[idx];
    if (!el) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (elTop < viewTop) list.scrollTop = elTop;
    else if (elBottom > viewBottom) list.scrollTop = elBottom - list.clientHeight;
  };

  // Client-side guard on submit
  form.addEventListener("submit", (e) => {
    if (!hiddenId.value) {
      e.preventDefault();
      err.hidden = false;
      input.focus();
      filterAndRender(input.value);
    }
  });

  // init
  fetchNodes();

  // If this input has a data-initial-id (edit screen), prefill label once nodes are loaded
  const initialIdAttr = input.getAttribute("data-initial-id");
  if (initialIdAttr) {
    const init = () => {
      const idNum = parseInt(initialIdAttr, 10);
      const n = nodes.find(x => x.id === idNum);
      if (n) {
        input.value = labelFor(n);
        hiddenId.value = String(n.id);
      }
    };
    // nodes may not be loaded yet; wait a tick
    setTimeout(init, 50);
  }
})();