/* Academic family tree viewer.
 *
 * Three layouts share one set of node positions (cartesian px/py), so switching
 * between them animates smoothly:
 *   - "radial": butterfly — two side fans, rings = generations
 *   - "tree":   left-to-right tidy tree with two-line labels
 *   - "story":  storybook — a full circle that shows only the focused person's
 *               lineage, fellow students and own students, and revolves so the
 *               focused person always sits at 3 o'clock
 *
 * Keyboard (all layouts): Tab / Shift+Tab walk the whole family in chronological
 * order (by graduation year), ↑/↓ move between fellow students, →/← go to
 * students / advisor (mirrored on the butterfly's left fan so keys always match
 * what you see), Space plays the story automatically.
 *
 * Playing in Storybook turns it into a slideshow: a slide card pops in beside
 * the focused person, students pop out one by one, a large year watermark marks
 * each chapter, and the camera drifts in slowly (skipped for reduced motion).
 *
 * Expansion state lives on each hierarchy node: `d.kids` is the full list of
 * advisees, `d.children` is what is currently shown (null when collapsed).
 */
function initGenealogy({ dataUrl, authed, editUrl, addUrl }) {
  const canvas = document.getElementById("treeCanvas");
  const detailsEl = document.getElementById("details");
  const searchInput = document.getElementById("searchInput");
  const resultsEl = document.getElementById("searchResults");

  const DUR = 500;
  const ROW_H = 38;          // tree: vertical distance between rows
  const COL_W = 330;         // tree: horizontal distance between generations
  const MIN_ARC = 15;        // radial: min pixels between neighbours on a ring
  const LABEL_W = 180;       // radial: room reserved for a label
  const FAN_HALF = (35 * Math.PI) / 180; // radial: each fan spans ±35° around horizontal
  const RADIAL_CHARS = 26;
  const TREE_CHARS = 44;
  const OVERLAY = { top: 72, bottom: 96, side: 24 }; // keep fit() clear of floating UI
  const NOW_YEAR = new Date().getFullYear();
  const GEN_NAMES = ["Advisor", "Students", "Grand-students", "Great-grand-students", "Later generations"];
  const LAYOUTS = ["radial", "tree", "story"];
  const PLAY_MS = 4500;       // one slide at 1×
  const SPEEDS = [1, 2, 5, 10];
  const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stage = canvas.closest(".stage");
  const slideHost = document.getElementById("slideHost");
  const slideYear = document.getElementById("slideYear");

  let layout = LAYOUTS.includes(readPref("layout")) ? readPref("layout") : "radial";
  let lastLayout = null;      // layout of the previous render (story→story revolves)
  let storyRot = 0;           // storybook: current rotation of the circle
  let polarCache = new Map(); // storybook: id -> {a, r} from the previous render
  let storyOrder = [];        // everyone in chronological order (graduation year)
  let playTimer = null;
  let playK = 1;              // slideshow: fixed zoom level, so slow zooms don't accumulate
  let speed = SPEEDS.includes(Number(readPref("speed"))) ? Number(readPref("speed")) : 1;
  const playMs = () => PLAY_MS / speed;
  // Transition length: normal when browsing, squeezed to fit a slide when playing fast.
  const dur = () => (playTimer ? Math.min(DUR, playMs() * 0.7) : DUR);
  const slideshow = () => playTimer !== null && layout === "story";
  let root = null;
  let allNodes = [];
  const byId = new Map();
  let selected = null;

  // ---------------------------------------------------------------------------
  // SVG scaffolding
  // ---------------------------------------------------------------------------
  const svg = d3.select(canvas).append("svg")
    .attr("role", "img")
    .attr("aria-label", "Academic family tree diagram");
  const gZoom = svg.append("g");
  const gLinks = gZoom.append("g").attr("class", "links");
  const gNodes = gZoom.append("g").attr("class", "nodes");

  const zoom = d3.zoom()
    .scaleExtent([0.06, 4])
    .on("zoom", (e) => gZoom.attr("transform", e.transform));
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", (e) => { if (e.target === svg.node()) clearSelection(); });

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  canvas.appendChild(tooltip);

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------
  fetch(dataUrl)
    .then((r) => r.json())
    .then((data) => {
      canvas.querySelector(".loading")?.remove();
      if (!data || data.id === undefined) {
        canvas.insertAdjacentHTML("beforeend", '<div class="loading">No people yet.</div>');
        return;
      }
      root = d3.hierarchy(data);
      allNodes = root.descendants();
      root.eachAfter((d) => {
        d.kids = d.children || null;
        d.desc = (d.kids || []).reduce((n, c) => n + 1 + c.desc, 0);
        byId.set(d.data.id, d);
      });

      // Chronological: by graduation year, then generation, then name.
      // People with no year come last.
      storyOrder = allNodes.slice().sort((a, b) =>
        a.data.year_num - b.data.year_num || a.depth - b.depth || a.data.name.localeCompare(b.data.name));

      collapseTo(root, 1); // start with direct students; branches open on click
      root.px0 = root.py0 = 0;

      renderStats();
      setLayoutButtons();
      render(root, { anchor: false });
      fit(0);

      const params = new URLSearchParams(location.search);
      const id = parseInt(params.get("id"), 10);
      const q = params.get("q");
      const target = byId.get(id) || (q && searchPeople(q)[0]);
      if (target || layout === "story") select(target || root, { center: true });
    })
    .catch(() => {
      canvas.querySelector(".loading").textContent = "Could not load the tree.";
    });

  // ---------------------------------------------------------------------------
  // Expand / collapse
  // ---------------------------------------------------------------------------
  function setOpen(d, open) { d.children = open && d.kids ? d.kids : null; }
  function isCollapsed(d) { return d.kids && !d.children; }

  function collapseTo(node, depth) {
    allNodes.forEach((d) => setOpen(d, d.depth < depth));
    if (selected) reveal(selected);
  }

  function reveal(d) {
    for (let p = d.parent; p; p = p.parent) setOpen(p, true);
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------
  function computeLayout() {
    const visible = root.descendants();
    if (layout === "tree") {
      d3.tree().nodeSize([ROW_H, COL_W])
        .separation((a, b) => (a.parent === b.parent ? 1 : 1.3))(root);
      visible.forEach((d) => { d.px = d.depth * COL_W; d.py = d.x; d.angle = null; });
      return;
    }

    d3.tree().size([1, 1])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(root);

    if (layout === "story") {
      // Full circle, leaving one empty slot so the first and last people don't touch.
      const leaves = root.leaves().length;
      visible.forEach((d) => { d.angle = d.depth === 0 ? 0 : d.x * 2 * Math.PI * (leaves / (leaves + 1)); });
    } else {
      // "Butterfly" radial: the root's branches are split into two balanced fans,
      // one opening right and one opening left, so no label sits near 12 or 6
      // o'clock where it would have to be read vertically.
      const split = fanSplit(root);
      visible.forEach((d) => {
        const right = d.x <= split;
        const t = right ? d.x / (split || 1) : (d.x - split) / (1 - split || 1);
        const centre = right ? Math.PI / 2 : (3 * Math.PI) / 2; // angles run clockwise from north
        d.angle = d.depth === 0 ? 0 : centre - FAN_HALF + t * 2 * FAN_HALF;
      });
    }

    // Pick each ring's radius so neighbours never overlap and labels have room.
    const radii = [0];
    const byDepth = d3.group(visible, (d) => d.depth);
    for (let depth = 1; depth <= root.height; depth++) {
      const ring = (byDepth.get(depth) || []).map((d) => d.angle).sort((a, b) => a - b);
      if (!ring.length) break;
      let gap = 2 * Math.PI;
      for (let i = 1; i < ring.length; i++) gap = Math.min(gap, ring[i] - ring[i - 1]);
      if (ring.length > 1) gap = Math.min(gap, 2 * Math.PI - ring[ring.length - 1] + ring[0]);
      const inward = (byDepth.get(depth) || []).some((d) => d.children);
      const minArc = layout === "story" ? 22 : MIN_ARC; // storybook: room for the two-line focus label
      const needed = minArc / Math.max(gap, 1e-3) + (inward ? LABEL_W : 0);
      radii[depth] = Math.max(needed, radii[depth - 1] + (depth === 1 ? 140 : LABEL_W + 40));
    }
    if (layout === "story" && selected && selected.depth > 0) {
      // Revolve the circle so the focused person sits at 3 o'clock (horizontal label).
      storyRot = Math.PI / 2 - selected.angle;
    }
    visible.forEach((d) => {
      if (layout === "story" && d.depth > 0) d.angle = mod2pi(d.angle + storyRot);
      d.radius = radii[d.depth] || 0;
      d.px = d.radius * Math.sin(d.angle);
      d.py = -d.radius * Math.cos(d.angle);
    });
  }

  function mod2pi(a) { const t = 2 * Math.PI; return ((a % t) + t) % t; }

  // Interpolate along the circle (shortest way round) instead of a straight line,
  // so the storybook turns like a revolver cylinder.
  function arcTween(from, to) {
    const da = mod2pi(to.a - from.a + Math.PI) - Math.PI;
    return (t) => {
      const a = from.a + da * t, r = from.r + (to.r - from.r) * t;
      return { x: r * Math.sin(a), y: -r * Math.cos(a) };
    };
  }

  // Position (in tree-layout x units, 0..1) that divides the root's visible
  // branches into two halves with roughly equal numbers of leaves.
  function fanSplit(node) {
    const kids = node.children || [];
    if (kids.length < 2) return 1; // everything in the right-hand fan
    const extents = kids.map((c) => d3.extent(c.leaves(), (l) => l.x));
    let best = 1, bestDist = Infinity;
    for (let i = 1; i < kids.length; i++) {
      const cut = (extents[i - 1][1] + extents[i][0]) / 2;
      if (Math.abs(cut - 0.5) < bestDist) { bestDist = Math.abs(cut - 0.5); best = cut; }
    }
    return best;
  }

  const radialLink = d3.linkRadial().angle((p) => p.a).radius((p) => p.r);
  function linkPath(s, t) {
    if (layout === "tree") {
      const mx = (s.x + t.x) / 2;
      return `M${s.x},${s.y}C${mx},${s.y} ${mx},${t.y} ${t.x},${t.y}`;
    }
    const polar = (p) => ({ a: Math.atan2(p.x, -p.y), r: Math.hypot(p.x, p.y) });
    return radialLink({ source: polar(s), target: polar(t) });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const nodeRadius = (d) => Math.min(16, 4.5 + Math.sqrt(d.desc) * 1.1);
  const genColor = (d) => `var(--gen-${Math.min(d.depth, 4)})`;

  function render(source, { anchor = true } = {}) {
    const before = { x: source.px, y: source.py };
    computeLayout();
    const nodes = root.descendants();
    const links = root.links();
    const t = svg.transition().duration(dur());
    const story = layout === "story";
    const revolve = story && lastLayout === "story";
    const polar = (d) => ({ a: d.angle, r: d.radius });
    const prevPolar = (d) => polarCache.get(d.data.id) || polar(d);
    const at = (d) => ({ x: d.px, y: d.py });
    gZoom.classed("story", story);

    // Keep the clicked node still on screen while everything else reflows.
    if (anchor && before.x !== undefined) {
      svg.transition(t).call(zoom.translateBy, before.x - source.px, before.y - source.py);
    }

    // ----- links
    const from = { x: source.px0 ?? source.px, y: source.py0 ?? source.py };
    gLinks.selectAll("path.link")
      .data(links, (d) => d.target.data.id)
      .join(
        (enter) => enter.append("path").attr("class", "link").attr("opacity", 0)
          .attr("d", (d) => (story ? linkPath(at(d.source), at(d.target)) : linkPath(from, from))),
        (update) => update,
        (exit) => (story ? exit : exit.attr("d", () => linkPath(at(source), at(source))))
          .transition(t)
          .attr("opacity", 0)
          .remove()
      )
      .transition(t)
      .attr("opacity", 1)
      .call((tr) => (revolve
        ? tr.attrTween("d", (d) => {
          const s = arcTween(prevPolar(d.source), polar(d.source));
          const e = arcTween(prevPolar(d.target), polar(d.target));
          return (k) => linkPath(s(k), e(k));
        })
        : tr.attr("d", (d) => linkPath(at(d.source), at(d.target)))));

    // ----- nodes
    const node = gNodes.selectAll("g.node")
      .data(nodes, (d) => d.data.id)
      .join(
        (enter) => {
          const g = enter.append("g")
            .attr("class", "node")
            .attr("transform", (d) => (story ? `translate(${d.px},${d.py})` : `translate(${from.x},${from.y})`))
            .attr("opacity", 0)
            .on("click", (e, d) => { e.stopPropagation(); onNodeClick(d); })
            .on("mouseenter", (e, d) => showTooltip(e, d))
            .on("mousemove", (e, d) => showTooltip(e, d))
            .on("mouseleave", hideTooltip);
          // Slideshow: a newly shown student of the focused person pops in, staggered.
          g.classed("pop", (d) => slideshow() && d.parent === selected)
            .style("--pop-i", (d) => (d.parent ? Math.min(d.parent.kids.indexOf(d), 30) : 0));
          g.append("circle").attr("class", "pulse");
          g.append("circle").attr("class", "collapsed-ring");
          g.append("circle").attr("class", "dot");
          const label = g.append("g").attr("class", "label");
          label.append("text").attr("class", "label-name");
          label.append("text").attr("class", "label-meta");
          return g;
        },
        (update) => update,
        (exit) => (story ? exit.transition(t) : exit.transition(t).attr("transform", `translate(${source.px},${source.py})`))
          .attr("opacity", 0)
          .remove()
      );

    node.transition(t)
      .attr("opacity", 1)
      .call((tr) => (revolve
        ? tr.attrTween("transform", (d) => {
          const p = arcTween(prevPolar(d), polar(d));
          return (k) => { const q = p(k); return `translate(${q.x},${q.y})`; };
        })
        : tr.attr("transform", (d) => `translate(${d.px},${d.py})`)));

    node.select("circle.pulse").attr("r", nodeRadius);
    node.select("circle.dot")
      .attr("r", nodeRadius)
      .style("fill", genColor);
    node.select("circle.collapsed-ring")
      .attr("r", (d) => nodeRadius(d) + 3.5)
      .style("color", genColor)
      .attr("display", (d) => (isCollapsed(d) ? null : "none"));

    node.each(function (d) { placeLabel(d3.select(this), d, t); });

    allNodes.forEach((d) => { d.px0 = d.px; d.py0 = d.py; });
    polarCache = story ? new Map(nodes.map((d) => [d.data.id, polar(d)])) : new Map();
    lastLayout = layout;
    applyHighlight();
  }

  function placeLabel(g, d, t) {
    const label = g.select("g.label");
    const name = g.select("text.label-name");
    const meta = g.select("text.label-meta");
    const r = nodeRadius(d) + 6;
    const hasKids = !!d.children;

    if (layout === "tree") {
      const right = !hasKids;
      const metaText = metaLine(d);
      name.text(truncate(d.data.name, TREE_CHARS))
        .attr("x", right ? r : -r).attr("text-anchor", right ? "start" : "end")
        .attr("dy", metaText ? "-0.15em" : "0.32em");
      meta.text(metaText).attr("display", metaText ? null : "none")
        .attr("x", right ? r : -r).attr("text-anchor", right ? "start" : "end")
        .attr("dy", "1.05em");
      label.transition(t).attr("transform", "rotate(0)");
      return;
    }

    const focus = layout === "story" && d === selected;
    meta.attr("display", "none");
    if (d.depth === 0) {
      name.text(d.data.name).attr("x", 0).attr("text-anchor", "middle")
        .attr("dy", `${nodeRadius(d) + 18}px`);
      label.transition(t).attr("transform", "rotate(0)");
      return;
    }
    const deg = (d.angle * 180) / Math.PI - 90;
    const rightSide = d.angle < Math.PI;
    const forward = rightSide === !hasKids; // leaves point outward, parents inward
    const metaText = focus ? [d.data.institution, d.data.year].filter(Boolean).join(" · ") : "";
    name.text(focus ? d.data.name : truncate(d.data.name, RADIAL_CHARS))
      .attr("x", forward ? r : -r)
      .attr("text-anchor", forward ? "start" : "end")
      .attr("dy", metaText ? "-0.2em" : "0.32em");
    if (metaText) {
      meta.text(truncate(metaText, 48)).attr("display", null)
        .attr("x", forward ? r : -r).attr("text-anchor", forward ? "start" : "end").attr("dy", "1.1em");
    }
    label.transition(t).attr("transform", `rotate(${rightSide ? deg : deg + 180})`);
  }

  function metaLine(d) {
    const parts = [];
    if (d.data.institution) parts.push(truncate(d.data.institution, 40));
    if (d.data.year) parts.push(d.data.year);
    if (isCollapsed(d)) parts.push(`+${d.desc} hidden`);
    return parts.join(" · ");
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ---------------------------------------------------------------------------
  // Viewport
  // ---------------------------------------------------------------------------
  function fit(duration = 600) {
    if (!root) return;
    if (layout === "story" && selected && selected.depth > 0) { storyCamera(selected); return; }
    const nodes = root.descendants();
    const pad = layout === "tree" ? { l: 260, r: 330, t: 30, b: 30 } : { l: LABEL_W, r: LABEL_W, t: LABEL_W, b: LABEL_W };
    const x0 = d3.min(nodes, (d) => d.px) - pad.l;
    const x1 = d3.max(nodes, (d) => d.px) + pad.r;
    const y0 = d3.min(nodes, (d) => d.py) - pad.t;
    const y1 = d3.max(nodes, (d) => d.py) + pad.b;
    const W = canvas.clientWidth - OVERLAY.side * 2;
    const H = canvas.clientHeight - OVERLAY.top - OVERLAY.bottom;
    const minK = layout === "tree" ? 0.55 : 0.06; // keep tree labels readable; pan for the rest
    const k = Math.max(minK, Math.min(1.2, W / (x1 - x0), H / (y1 - y0)));
    const tx = OVERLAY.side + (W - k * (x1 - x0)) / 2 - k * x0;
    const ty = OVERLAY.top + (H - k * (y1 - y0)) / 2 - k * y0;
    if (layout === "tree" && k === minK) {
      // Too tall to fit: centre on the root instead of the middle of the bounds.
      const cy = OVERLAY.top + H / 2 - k * root.py;
      svg.transition().duration(duration).call(zoom.transform, d3.zoomIdentity.translate(tx, cy).scale(k));
      return;
    }
    svg.transition().duration(duration)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }

  // Storybook camera: the focused person always appears at the same spot,
  // left of centre, so the circle seems to turn underneath them.
  function storyCamera(d) {
    const cur = d3.zoomTransform(svg.node());
    const show = slideshow();
    const k = show ? playK : cur.k >= 0.6 && cur.k <= 2 ? cur.k : 1;
    const mobile = detailsEl.offsetLeft === 0 && !detailsEl.hidden;
    const sheet = mobile ? detailsEl.offsetHeight : show && canvas.clientWidth < 900 ? 260 : 0;
    // On narrow screens a focus label that points inward (toward the centre) needs room on the left.
    const x = canvas.clientWidth * (canvas.clientWidth >= 700 ? 0.36 : d.children ? 0.58 : 0.22);
    const y = sheet
      ? OVERLAY.top + (canvas.clientHeight - sheet - OVERLAY.top) / 2
      : OVERLAY.top + (canvas.clientHeight - OVERLAY.top - OVERLAY.bottom) / 2;
    const move = svg.transition().duration(dur())
      .call(zoom.transform, d3.zoomIdentity.translate(x - k * d.px, y - k * d.py).scale(k));
    if (show && !REDUCED_MOTION && playMs() - dur() > 300) {
      // Ken Burns: drift in slowly around the focused person until the next slide.
      move.transition().duration(playMs() - dur()).ease(d3.easeSinInOut).call(zoom.scaleBy, 1.07, [x, y]);
    }
  }

  function centerOn(d, minScale = 1) {
    if (layout === "story") { if (d.depth > 0) storyCamera(d); else fit(); return; }
    const cur = d3.zoomTransform(svg.node());
    const k = Math.max(cur.k, minScale);
    const cx = canvas.clientWidth / 2;
    const sheet = !detailsEl.hidden && detailsEl.offsetLeft === 0 ? detailsEl.offsetHeight : 0; // mobile bottom sheet
    const cy = sheet
      ? OVERLAY.top + (canvas.clientHeight - sheet - OVERLAY.top) / 2
      : OVERLAY.top + (canvas.clientHeight - OVERLAY.top - OVERLAY.bottom) / 2;
    svg.transition().duration(dur() + 200)
      .call(zoom.transform, d3.zoomIdentity.translate(cx - k * d.px, cy - k * d.py).scale(k));
  }

  // ---------------------------------------------------------------------------
  // Selection & highlighting
  // ---------------------------------------------------------------------------
  function onNodeClick(d) {
    stopPlay();
    if (layout === "story") { select(d); return; }
    if (d === selected) {
      if (d.kids) { setOpen(d, !d.children); render(d); }
      return;
    }
    select(d);
  }

  function select(d, { center = false, focus = false } = {}) {
    if (layout === "story") {
      const prev = selected || root;
      selected = d;
      // Show only this person's story: their lineage (with each generation's
      // fellow students) and their own students.
      allNodes.forEach((n) => setOpen(n, false));
      d.ancestors().forEach((a) => setOpen(a, true));
      render(prev, { anchor: false });
      if (slideshow()) showSlide(d); else renderDetails(d);
      if (d.depth > 0) storyCamera(d); else fit();
      updateUrl(d);
      return;
    }
    if (focus) {
      // Keyboard navigation: show just the path to this person and their
      // students, so stepping around doesn't keep opening more branches.
      allNodes.forEach((n) => setOpen(n, n.depth === 0));
      d.ancestors().forEach((a) => setOpen(a, true));
      selected = d;
      render(root, { anchor: false });
      renderDetails(d);
      centerOn(d);
      updateUrl(d);
      return;
    }
    selected = d;
    const needsReveal = d.ancestors().slice(1).some((a) => !a.children);
    reveal(d);
    if (d.kids && !d.children) setOpen(d, true);
    render(needsReveal ? root : d, { anchor: !needsReveal && !center });
    renderDetails(d);
    if (center || needsReveal) centerOn(d);
    updateUrl(d);
  }

  function updateUrl(d) {
    const url = new URL(location.href);
    url.searchParams.delete("q");
    url.searchParams.set("id", d.data.id);
    history.replaceState(null, "", url);
    const pos = document.getElementById("storyPos");
    if (pos) {
      const yr = d.data.year_num !== 9999 ? `${d.data.year_num} · ` : "";
      pos.textContent = `${yr}${storyOrder.indexOf(d) + 1} / ${storyOrder.length}`;
    }
  }

  function clearSelection() {
    if (!selected) return;
    selected = null;
    detailsEl.hidden = true;
    applyHighlight();
    const url = new URL(location.href);
    url.searchParams.delete("id");
    history.replaceState(null, "", url);
  }

  function applyHighlight() {
    const path = new Set(selected ? selected.ancestors() : []);
    const related = new Set(selected ? selected.descendants() : []);
    gZoom.classed("dimmed", !!selected);
    gNodes.selectAll("g.node")
      .classed("selected", (d) => d === selected)
      .classed("on-path", (d) => path.has(d))
      .classed("related", (d) => related.has(d));
    gLinks.selectAll("path.link")
      .classed("on-path", (d) => path.has(d.target))
      .filter((d) => path.has(d.target)).raise();
  }

  // ---------------------------------------------------------------------------
  // Tooltip (radial labels are short, so hovering reveals the rest)
  // ---------------------------------------------------------------------------
  function showTooltip(e, d) {
    if (layout === "tree") return;
    tooltip.replaceChildren(
      el("strong", {}, d.data.name),
      el("span", {}, [d.data.institution, d.data.year].filter(Boolean).join(" · ") || "—")
    );
    const rect = canvas.getBoundingClientRect();
    let x = e.clientX - rect.left + 14;
    let y = e.clientY - rect.top + 14;
    if (x + 280 > rect.width) x -= 300;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
    tooltip.style.opacity = 1;
  }
  function hideTooltip() { tooltip.style.opacity = 0; }

  // ---------------------------------------------------------------------------
  // Details drawer
  // ---------------------------------------------------------------------------
  function renderDetails(d) {
    const p = d.data;
    const gen = Math.min(d.depth, 4);
    const items = [];

    items.push(el("div", { class: "details-top" },
      el("span", { class: "gen-chip" },
        el("i", { style: `background:${genColor(d)}` }),
        d.depth === 0 ? "Root of the tree" : `Generation ${d.depth} · ${GEN_NAMES[gen]}`),
      el("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: clearSelection },
        svgIcon("M6 6l12 12M18 6 6 18"))
    ));

    items.push(el("div", { class: "person-head" },
      photoEl(p, "avatar"),
      el("div", {}, el("h2", {}, p.name), p.position ? el("div", { class: "position" }, p.position) : null)));
    items.push(el("p", { class: "story-text" }, storyText(d)));

    const meta = el("div", { class: "meta" });
    if (p.institution) meta.append(el("div", {}, svgIcon("M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"), p.institution));
    if (p.year) {
      const future = p.year_num !== 9999 && p.year_num > NOW_YEAR && /^\d{4}$/.test(p.year.trim());
      meta.append(el("div", {}, svgIcon("M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"), future ? `Expected ${p.year}` : p.year));
    }
    items.push(meta);

    const actions = el("div", { class: "details-actions" });
    if (/^https?:\/\//i.test(p.url)) {
      actions.append(el("a", { class: "btn primary", href: p.url, target: "_blank", rel: "noopener noreferrer" },
        svgIcon("M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"), "Website"));
    }
    const copyBtn = el("button", { class: "btn", type: "button" }, svgIcon("M9 15l6-6M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1"), "Copy link");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard?.writeText(location.href).then(() => {
        copyBtn.lastChild.textContent = "Copied!";
        setTimeout(() => { copyBtn.lastChild.textContent = "Copy link"; }, 1500);
      });
    });
    actions.append(copyBtn);
    if (authed && p.id) {
      actions.append(el("a", { class: "btn", href: editUrl + p.id }, "Edit"));
      actions.append(el("a", { class: "btn", href: `${addUrl}?advisor=${p.id}` }, "Add student"));
    }
    items.push(actions);

    items.push(el("div", { class: "metric-row" },
      el("div", { class: "metric" }, el("b", {}, String((d.kids || []).length)), el("span", {}, "direct students")),
      el("div", { class: "metric" }, el("b", {}, String(d.desc)), el("span", {}, "academic descendants"))
    ));

    if (p.bio) items.push(...bioSection(p.bio));

    if (d.depth > 0) {
      items.push(el("h3", {}, "Lineage"));
      items.push(el("ol", { class: "lineage" },
        ...d.ancestors().reverse().map((a) =>
          el("li", {}, a === d ? a.data.name : personButton(a)))
      ));
    }

    items.push(el("h3", {}, d.kids ? `Students (${d.kids.length})` : "Students"));
    if (d.kids) {
      items.push(el("ul", { class: "advisee-list" },
        ...d.kids.map((c) => el("li", {},
          el("div", {},
            personButton(c),
            c.data.institution ? el("span", { class: "sub" }, c.data.institution) : null,
            c.desc ? el("span", { class: "sub" }, `${c.desc} descendant${c.desc === 1 ? "" : "s"}`) : null),
          el("span", { class: "yr" }, c.data.year || "")
        ))
      ));
    } else {
      items.push(el("p", { class: "empty-note" }, "No students recorded yet."));
    }

    detailsEl.replaceChildren(...items);
    detailsEl.hidden = false;
    detailsEl.scrollTop = 0;
  }

  // ---------------------------------------------------------------------------
  // Slideshow (Storybook + Play)
  // ---------------------------------------------------------------------------
  function showSlide(d) {
    const year = d.data.year_num !== 9999 ? String(d.data.year_num) : "";
    slideHost.replaceChildren(el("div", { class: "slide-card", style: `--play-ms:${playMs()}ms` },
      el("div", { class: "slide-chapter" },
        el("i", { style: `background:${genColor(d)}` }),
        [year || "Undated", d.depth === 0 ? "Where it begins" : `Generation ${d.depth}`].join(" · ")),
      el("div", { class: "slide-head" },
        photoEl(d.data, "slide-photo"),
        el("div", {},
          el("h2", {}, d.data.name),
          el("div", { class: "slide-inst" }, d.data.position || d.data.institution || ""))),
      el("p", {}, storyText(d)),
      el("div", { class: "slide-progress" }, el("i"))));
    if (slideYear.textContent !== year) slideYear.replaceChildren(el("span", {}, year));
  }

  function enterSlideshow() {
    const k = d3.zoomTransform(svg.node()).k;
    playK = k >= 0.6 && k <= 2 ? k : 1;
    stage.classList.add("slideshow");
    detailsEl.hidden = true; // give the stage the whole width
    select(selected || root);
  }

  function exitSlideshow() {
    stage.classList.remove("slideshow");
    slideHost.replaceChildren();
    slideYear.replaceChildren();
    if (selected) { renderDetails(selected); if (selected.depth > 0) storyCamera(selected); }
  }

  // A short, pronoun-free summary of where this person sits in the family.
  function storyText(d) {
    const n = (d.kids || []).length;
    const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    if (!d.parent) {
      return `The root of this family: ${plural(n, "student")} and ${d.desc} academic descendants across ${root.height} generations.`;
    }
    const sibs = d.parent.kids.length;
    const p = d.data;
    const future = p.year_num !== 9999 && p.year_num > NOW_YEAR;
    const parts = [];
    parts.push(sibs > 1
      ? `One of ${sibs} students of ${d.parent.data.name}${p.year ? (future ? `, expected to finish in ${p.year}` : ` (${p.year})`) : ""}.`
      : `The only recorded student of ${d.parent.data.name}${p.year ? ` (${p.year})` : ""}.`);
    if (p.institution) parts.push(`${future ? "At" : "Now at"} ${p.institution}.`);
    if (n) parts.push(d.desc > n ? `Has advised ${plural(n, "student")}, with ${d.desc} academic descendants in all.` : `Has advised ${plural(n, "student")}.`);
    return parts.join(" ");
  }

  // Photos are hot-linked from the person's own/official page; hide them if they fail to load.
  function photoEl(p, cls) {
    if (!/^https?:\/\//i.test(p.photo_url || "")) return null;
    const img = el("img", { class: cls, src: p.photo_url, alt: `Photo of ${p.name}`, loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    if (p.photo_source) img.title = `Photo: ${p.photo_source}`;
    return img;
  }

  function bioSection(bio) {
    const out = [el("h3", {}, "About")];
    if (bio.summary) out.push(el("p", { class: "bio-summary" }, bio.summary));
    if (bio.research_areas && bio.research_areas.length) {
      out.push(el("div", { class: "chips" }, ...bio.research_areas.map((a) => el("span", { class: "chip" }, a))));
    }
    const facts = el("dl", { class: "facts" });
    if (bio.thesis_title) facts.append(el("dt", {}, "PhD thesis"), el("dd", {}, bio.thesis_title + (bio.phd_year ? ` (${bio.phd_year})` : "")));
    if (bio.notable && bio.notable.length) facts.append(el("dt", {}, "Highlights"), el("dd", {}, el("ul", {}, ...bio.notable.map((n) => el("li", {}, n)))));
    if (facts.childNodes.length) out.push(facts);
    const links = (bio.sources || []).filter((u) => /^https?:\/\//i.test(u));
    if (links.length) {
      out.push(el("p", { class: "sources" }, "Sources: ",
        ...links.flatMap((u, i) => [i ? ", " : "", el("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, hostOf(u))])));
    }
    return out;
  }

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } }

  function personButton(d) {
    return el("button", { class: "person-link", type: "button", onclick: () => select(d, { center: true }) }, d.data.name);
  }

  // ---------------------------------------------------------------------------
  // Stats & legend
  // ---------------------------------------------------------------------------
  function renderStats() {
    const people = allNodes.filter((d) => d.data.id !== 0);
    const insts = new Set(people.map((d) => (d.data.institution || "").trim().toLowerCase()).filter(Boolean));
    const years = people.map((d) => d.data.year_num).filter((y) => y && y !== 9999 && y <= NOW_YEAR);
    document.getElementById("statPeople").textContent = people.length;
    document.getElementById("statGens").textContent = root.height + 1;
    document.getElementById("statInst").textContent = insts.size;
    document.getElementById("statSpan").textContent = years.length ? `${d3.min(years)}–${NOW_YEAR}` : "–";
    const legend = document.getElementById("legend");
    for (let g = 0; g <= Math.min(root.height, 4); g++) {
      legend.append(el("span", {}, el("i", { style: `background:var(--gen-${g})` }), g === 0 ? root.data.name : GEN_NAMES[g]));
    }
    document.getElementById("stats").hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  let results = [];
  let active = 0;

  function searchPeople(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const d of allNodes) {
      const name = d.data.name.toLowerCase();
      const inst = (d.data.institution || "").toLowerCase();
      let score = -1;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.split(/[\s().-]+/).some((w) => w.startsWith(q))) score = 2;
      else if (name.includes(q)) score = 3;
      else if (inst.includes(q)) score = 4;
      if (score >= 0) scored.push([score, d]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].data.name.localeCompare(b[1].data.name));
    return scored.map((s) => s[1]);
  }

  function highlightText(text, q) {
    const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
    if (!q.trim() || i < 0) return [text];
    return [text.slice(0, i), el("mark", {}, text.slice(i, i + q.trim().length)), text.slice(i + q.trim().length)];
  }

  function renderResults() {
    const q = searchInput.value;
    const matches = searchPeople(q);
    results = matches.slice(0, 8);
    active = 0;
    gNodes.selectAll("g.node").classed("match", (d) => q.trim() && matches.includes(d));
    if (!q.trim()) { closeResults(); return; }
    if (!results.length) {
      resultsEl.replaceChildren(el("li", { class: "empty" }, "No one matches that search."));
    } else {
      resultsEl.replaceChildren(...results.map((d, i) => {
        const li = el("li", { role: "option", id: `res-${i}`, "aria-selected": String(i === 0) },
          el("i", { class: "gen-dot", style: `background:${genColor(d)}` }),
          el("span", { class: "r-name" }, ...highlightText(d.data.name, q)),
          el("span", { class: "r-meta" }, [d.data.institution, d.data.year].filter(Boolean).join(" · ") || GEN_NAMES[Math.min(d.depth, 4)]));
        li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(d); });
        li.addEventListener("mousemove", () => setActive(i));
        return li;
      }));
      if (matches.length > results.length) {
        resultsEl.append(el("li", { class: "empty" }, `+${matches.length - results.length} more — keep typing`));
      }
    }
    resultsEl.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  function setActive(i) {
    active = i;
    [...resultsEl.querySelectorAll('[role="option"]')].forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
    searchInput.setAttribute("aria-activedescendant", `res-${i}`);
  }

  function closeResults() {
    resultsEl.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
  }

  function pick(d) {
    closeResults();
    searchInput.value = "";
    gNodes.selectAll("g.node").classed("match", false);
    searchInput.blur();
    select(d, { center: true });
  }

  searchInput.addEventListener("input", renderResults);
  searchInput.addEventListener("focus", () => { if (searchInput.value) renderResults(); });
  searchInput.addEventListener("blur", closeResults);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && results.length) { e.preventDefault(); setActive((active + 1) % results.length); }
    else if (e.key === "ArrowUp" && results.length) { e.preventDefault(); setActive((active - 1 + results.length) % results.length); }
    else if (e.key === "Enter" && results[active]) { e.preventDefault(); pick(results[active]); }
    else if (e.key === "Escape") { searchInput.value = ""; renderResults(); searchInput.blur(); }
  });

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function setLayoutButtons() {
    document.querySelectorAll("[data-layout]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.layout === layout)));
    document.getElementById("foldTools").hidden = layout === "story";
  }

  document.querySelectorAll("[data-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!root || btn.dataset.layout === layout) return;
      stopPlay();
      const leavingStory = layout === "story";
      layout = btn.dataset.layout;
      writePref("layout", layout);
      setLayoutButtons();
      hideTooltip();
      if (layout === "story") { select(selected || root); return; }
      if (leavingStory) collapseTo(root, 1);
      render(root, { anchor: false });
      if (selected) centerOn(selected, 0.6); else fit();
    });
  });

  document.getElementById("expandAllBtn").addEventListener("click", () => {
    if (!root) return;
    allNodes.forEach((d) => setOpen(d, true));
    render(root, { anchor: false });
    fit();
  });

  document.getElementById("collapseAllBtn").addEventListener("click", () => {
    if (!root) return;
    collapseTo(root, 1);
    render(root, { anchor: false });
    fit();
  });

  document.getElementById("zoomIn").addEventListener("click", () => svg.transition().duration(250).call(zoom.scaleBy, 1.4));
  document.getElementById("zoomOut").addEventListener("click", () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.4));
  document.getElementById("fitBtn").addEventListener("click", () => fit());

  // ----- story navigation (keyboard, buttons, autoplay)
  function go(d) { if (d && d !== selected) select(d, { center: true, focus: true }); }

  // On the butterfly's left fan the picture is mirrored: students sit further
  // left and the next sibling is drawn above. Flip the keys there.
  function mirrored(d) { return layout === "radial" && d.px < -1; }

  // →/←: toward students or back toward the advisor, whichever lies that way on screen.
  function horizontal(dir) {
    const d = selected;
    if (!d) { go(root); return; }
    if (d.depth === 0) {
      if (layout === "radial" && d.children) {
        // Butterfly root: enter the fan on that side, at the student nearest the middle.
        const side = d.children.filter((c) => (dir > 0 ? c.px >= 0 : c.px < 0));
        go(d3.least(side, (c) => Math.abs(c.py)));
      } else if (dir > 0 && d.kids) go(d.kids[0]);
      return;
    }
    const towardStudents = mirrored(d) ? dir < 0 : dir > 0;
    if (towardStudents) { if (d.kids) go(d.kids[0]); } else go(d.parent);
  }

  function step(dir) {
    if (!root) return;
    if (!selected) { go(root); return; }
    const i = storyOrder.indexOf(selected);
    go(storyOrder[(i + dir + storyOrder.length) % storyOrder.length]);
  }

  function sibling(dir) {
    if (!selected) { go(root); return; }
    if (!selected.parent) return;
    const sibs = selected.parent.kids;
    const next = sibs[(sibs.indexOf(selected) + dir + sibs.length) % sibs.length];
    // Butterfly: stop at the edge of a fan rather than jumping to the other side.
    if (layout === "radial" && (next.px < 0) !== (selected.px < 0)) return;
    go(next);
  }

  const playBtn = document.getElementById("playBtn");
  function stopPlay() {
    if (!playTimer) return;
    const wasSlideshow = slideshow();
    clearInterval(playTimer);
    playTimer = null;
    if (wasSlideshow) exitSlideshow();
    playBtn.textContent = "▶ Play";
    playBtn.setAttribute("aria-pressed", "false");
  }
  function startTimer() {
    clearInterval(playTimer);
    playTimer = setInterval(() => {
      if (storyOrder.indexOf(selected) === storyOrder.length - 1) { stopPlay(); return; }
      step(1);
    }, playMs());
  }

  function togglePlay() {
    if (playTimer) { stopPlay(); return; }
    startTimer();
    if (layout === "story") enterSlideshow();
    else if (!selected) go(root);
    playBtn.textContent = "❚❚ Pause";
    playBtn.setAttribute("aria-pressed", "true");
  }

  playBtn.addEventListener("click", togglePlay);

  // ----- playback speed
  const speedBtns = document.querySelectorAll("[data-speed]");
  function setSpeed(s) {
    speed = s;
    writePref("speed", String(s));
    stage.style.setProperty("--speed", s); // CSS slideshow animations scale with this
    speedBtns.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === s)));
    if (playTimer) startTimer(); // keep playing, at the new pace
  }
  speedBtns.forEach((b) => b.addEventListener("click", () => setSpeed(Number(b.dataset.speed))));
  setSpeed(speed);
  document.getElementById("prevBtn").addEventListener("click", () => { stopPlay(); step(-1); });
  document.getElementById("nextBtn").addEventListener("click", () => { stopPlay(); step(1); });

  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    // Tab drives the story unless focus is in the header or the details panel.
    const inChrome = active && (active.closest(".site-header") || active.closest("#details"));
    const nav = {
      Tab: () => step(e.shiftKey ? -1 : 1),
      ArrowDown: () => sibling(selected && mirrored(selected) ? -1 : 1),
      ArrowUp: () => sibling(selected && mirrored(selected) ? 1 : -1),
      ArrowRight: () => horizontal(1),
      ArrowLeft: () => horizontal(-1),
    };
    if (nav[e.key] && !(e.key === "Tab" && inChrome)) {
      e.preventDefault();
      stopPlay();
      nav[e.key]();
    } else if (e.key === " " && !(active && active.closest("button, a"))) {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "/") { e.preventDefault(); searchInput.focus(); }
    else if (e.key === "Escape") { stopPlay(); clearSelection(); }
    else if (e.key === "f") fit();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  function svgIcon(d) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    s.append(path);
    return s;
  }

  function readPref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
}
