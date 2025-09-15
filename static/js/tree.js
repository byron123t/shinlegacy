function initGenealogy(opts) {
  const {
    dataUrl,
    containerSelector,
    searchInputSelector,
    resetBtnSelector,
    expandAllBtnSelector,
    collapseAllBtnSelector
  } = opts;

  const container = document.querySelector(containerSelector);
  const searchInput = document.querySelector(searchInputSelector);
  const resetBtn = document.querySelector(resetBtnSelector);
  const expandAllBtn = document.querySelector(expandAllBtnSelector);
  const collapseAllBtn = document.querySelector(collapseAllBtnSelector);

  const margin = { top: 24, right: 8, bottom: 24, left: 60 };
  const nodeSize = { w: 500, h: 56 };   // <- wider and taller for 2-line labels
  const TOOLTIP_OFFSET = 12;
  const DUR = 300;

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.style.opacity = 0;
  container.appendChild(tooltip);

  // --- PIN STATE ---
  let pinned = false;
  let pinnedNode = null;

  function tooltipHTML(d) {
    const inst = d.data.institution ? ` · ${d.data.institution}` : "";
    const year = d.data.year ? ` (${d.data.year})` : "";
    const website = d.data.url
      ? `<br><a href="${d.data.url}" target="_blank" rel="noopener noreferrer">Website</a>`
      : "";
    return `<strong>${d.data.name}</strong>${inst}${year}${website}`;
  }

  function setTooltip(d, x, y) {
    tooltip.style.opacity = 1;
    tooltip.style.left = (x + TOOLTIP_OFFSET) + "px";
    tooltip.style.top  = (y + TOOLTIP_OFFSET) + "px";
    tooltip.innerHTML = tooltipHTML(d);
  }

  function pinTo(d, x, y) {
    pinned = true;
    pinnedNode = d;
    tooltip.classList.add("pinned");
    setTooltip(d, x, y);
  }

  function unpin() {
    pinned = false;
    pinnedNode = null;
    tooltip.classList.remove("pinned");
    tooltip.style.opacity = 0;
  }

  // Keep tooltip visible if mouse enters it; only hide when not pinned
  tooltip.addEventListener("mouseenter", () => { tooltip.style.opacity = 1; });
  tooltip.addEventListener("mouseleave", () => { if (!pinned) tooltip.style.opacity = 0; });

  const svg = d3.select(container).append("svg")
    .attr("width", container.clientWidth)
    .attr("height", container.clientHeight)
    .attr("role", "img")
    .attr("aria-label", "Academic genealogy tree");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const zoom = d3.zoom()
    .scaleExtent([0.3, 2.5])
    .on("zoom", (event) => g.attr("transform", event.transform));

  svg.call(zoom);

  let root, treeLayout, allNodesByName = new Map();

  window.addEventListener("resize", () => {
    svg.attr("width", container.clientWidth).attr("height", container.clientHeight);
    update(root);
  });

  fetch(dataUrl)
    .then(r => r.json())
    .then(data => {
      // Convert to hierarchy
      root = d3.hierarchy(data);
      root.x0 = 0;
      root.y0 = 0;

      // Start collapsed (except top two levels)
      root.children?.forEach(collapseDeep);
      expandDepth(root, 1);

      indexNames(root);

      treeLayout = d3.tree().nodeSize([nodeSize.h, nodeSize.w]);
      update(root);
    });

  function indexNames(hnode) {
    allNodesByName.clear();
    hnode.each(d => {
      const key = d.data.name.toLowerCase();
      if (!allNodesByName.has(key)) allNodesByName.set(key, []);
      allNodesByName.get(key).push(d);
    });
  }

  function collapseDeep(node) {
    if (node.children) {
      node._children = node.children;
      node._children.forEach(collapseDeep);
      node.children = null;
    }
  }

  function expand(node) {
    if (node._children) {
      node.children = node._children;
      node._children = null;
    }
  }

  function expandDepth(node, depth) {
    if (depth <= 0) return;
    expand(node);
    (node.children || []).forEach(c => expandDepth(c, depth - 1));
  }

  function expandAll(node) {
    expand(node);
    (node.children || node._children || []).forEach(expandAll);
  }

  function collapseAll(node) {
    if (node.children) {
      node.children.forEach(collapseAll);
      node._children = node.children;
      node.children = null;
    }
  }

  function update(source) {
    if (!root) return;

    // Compute layout size dynamically based on number of nodes
    const nodes = root.descendants();
    const links = root.links();

    const height = Math.max(container.clientHeight - margin.top - margin.bottom, nodes.length * 14);
    const width = container.clientWidth - margin.left - margin.right;

    treeLayout.size([height, width]);
    treeLayout(root);

    // Normalize for fixed-depth
    nodes.forEach(d => d.y = d.depth * nodeSize.w);

    // ----- Links
    const link = g.selectAll("path.link").data(links, d => d.target.data.id);

    link.enter()
      .append("path")
      .attr("class", "link")
      .attr("d", d => elbow({ source: source, target: source }))
      .transition()
      .duration(300)
      .attr("d", elbow);

    link.transition().duration(300).attr("d", elbow);

    link.exit()
      .transition().duration(200)
      .attr("d", d => elbow({ source: source, target: source }))
      .remove();

    // ----- Nodes
    const node = g.selectAll("g.node").data(nodes, d => d.data.id);

  const nodeEnter = node.enter().append("g")
    .attr("class", "node")
    .attr("transform", d => `translate(${source.y0 || 0},${source.x0 || 0})`)
    .on("click", (_, d) => {
      if (d.children) { d._children = d.children; d.children = null; }
      else if (d._children) { d.children = d._children; d._children = null; }
      update(d);
    })
    .on("mousemove", (event, d) => {
      if (pinned) return;  // don't move a pinned tooltip
      setTooltip(d, event.offsetX, event.offsetY);
    })
    .on("mouseleave", (event) => {
      if (pinned) return;  // pinned stays visible
      const toEl = event.relatedTarget;
      if (!toEl || !tooltip.contains(toEl)) tooltip.style.opacity = 0;
    })
    // NEW: right-click to pin/unpin
    .on("contextmenu", (event, d) => {
      event.preventDefault();
      event.stopPropagation(); // don't bubble to the svg's contextmenu
      // toggle: if already pinned on this node -> unpin, else pin to this node
      if (pinned && pinnedNode === d) {
        unpin();
      } else {
        pinTo(d, event.offsetX, event.offsetY);
      }
    })
    // (optional UX nicety you may already have)
    .on("dblclick", (_, d) => {
      if (d.data.url) window.open(d.data.url, "_blank", "noopener");
    });

    nodeEnter.append("circle").attr("r", 1e-6);

    nodeEnter.append("text")
      .attr("dy", "0.32em")
      .attr("x", d => d.children || d._children ? -12 : 12)
      .attr("text-anchor", d => d.children || d._children ? "end" : "start")
      .text(d => label(d));

    nodeEnter.on("dblclick", (_, d) => {
      if (d.data.url) window.open(d.data.url, "_blank", "noopener");
    });

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.transition().duration(300)
      .attr("transform", d => `translate(${d.y},${d.x})`);

    nodeUpdate.select("circle").transition().duration(300).attr("r", 6);

    nodeUpdate.select("text")
      .attr("x", d => d.children || d._children ? -12 : 12)
      .attr("text-anchor", d => d.children || d._children ? "end" : "start")
      .text(d => label(d));

    const nodeExit = node.exit().transition().duration(200)
      .attr("transform", d => `translate(${source.y},${source.x})`)
      .remove();

    nodeExit.select("circle").attr("r", 1e-6);

    // Stash positions for transitions
    nodes.forEach(d => { d.x0 = d.x; d.y0 = d.y; });
  }

  function label(d) {
    const parts = [d.data.name];
    if (d.data.institution) parts.push(d.data.institution);
    if (d.data.year) parts.push(d.data.year);
    return parts.join(" · ");
  }

  function elbow(d) {
    // Smooth elbow link
    const sx = d.source.x, sy = d.source.y;
    const tx = d.target.x, ty = d.target.y;
    const mx = (sy + ty) / 2;
    return `M${sy},${sx}C${mx},${sx} ${mx},${tx} ${ty},${tx}`;
  }

  // ---- Controls
  resetBtn?.addEventListener("click", () => {
    svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
  });

  expandAllBtn?.addEventListener("click", () => {
    expandAll(root);
    update(root);
  });

  collapseAllBtn?.addEventListener("click", () => {
    root.children?.forEach(collapseAll);
    update(root);
  });

  searchInput?.addEventListener("input", () => {
    const q = (searchInput.value || "").trim().toLowerCase();
    g.selectAll(".node").classed("highlight", false);
    if (!q) return;

    // Find first match
    const candidates = allNodesByName.get(q) ||
      Array.from(allNodesByName.keys())
        .filter(k => k.includes(q))
        .flatMap(k => allNodesByName.get(k) || []);

    if (candidates && candidates.length) {
      const target = candidates[0];
      // expand path to root
      let p = target;
      while (p) {
        if (p._children) { p.children = p._children; p._children = null; }
        p = p.parent;
      }
      update(target);
      // center the node
      const t = d3.zoomTransform(svg.node());
      const cx = target.y, cy = target.x;
      const k = t.k;
      const tx = (container.clientWidth / 2) - (cx * k);
      const ty = (container.clientHeight / 2) - (cy * k);
      svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
      // highlight
      g.selectAll("g.node").filter(d => d === target).classed("highlight", true);
    }
  });

  svg.on("contextmenu", (event) => {
    if (pinned) {
      event.preventDefault();
      unpin();
    }
  });
}