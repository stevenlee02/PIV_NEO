// Graph rendering & interaction — drawGraph, node/edge events, emphasis.
console.log("[graph.js] loading...");
import { ForceGraph } from "./forceGraph.js";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { S } from "./state.js";
import {
  normalizeId, makeEdgeKey, ensureArrayContexts,
  computeAdjacencyFromLinks, escapeHtml, highlightSelected,
} from "./utils.js";

// Lazy load panels.js to avoid circular dependency
let _panels = null;
function _loadPanels() {
  if (!_panels) _panels = import("./panels.js");
  return _panels;
}

console.log("[graph.js] ready");

const svgOuter = document.getElementById("graph");

// ---- resize ----
export function resizeSVG() {
  if (!svgOuter) return;
  S.graphWidth = svgOuter.clientWidth || Math.floor(window.innerWidth * 0.6);
  S.graphHeight = svgOuter.clientHeight || Math.floor(window.innerHeight * 0.7);
  svgOuter.setAttribute("width", S.graphWidth);
  svgOuter.setAttribute("height", S.graphHeight);
}

// ---- select node ----
export async function selectNode(id) {
  if (!S.currentGraphData || !id) return;
  S.selectedNodeId = id;

  applyGraphEmphasis(id);

  const p = await _loadPanels();
  p.showCharacterDetails(id);

  const counts = (S.currentGraphData.timeline && S.currentGraphData.timeline[id]) || [];
  const timelineData = counts.map((c, idx) => ({ chapter: idx + 1, count: c }));
  p.renderCharacterTimeline(timelineData);
  p.renderFlower(id, 16);

  if (S.activeChapter != null) {
    p.applyChapterEmphasis(S.activeChapter);
    p.renderChapterCard(S.activeChapter);
  } else {
    const chapterCardEl = document.getElementById("chapterCard");
    if (chapterCardEl) chapterCardEl.innerHTML = "";
  }
}

// ---- draw graph ----
export async function drawGraph(raw) {
  const p = await _loadPanels();
  const keepPanel = S.activePanel;
  const keepNode = S.selectedNodeId;
  const keepEdge = S.selectedEdgeKey;
  const keepChapter = S.activeChapter;

  const data = {
    ...raw,
    nodes: (raw?.nodes || []).map((d, i) => ({
      ...d,
      id: d.id || `node-${i}`,
      value: Number(d.value ?? 0),
    })),
    links: (raw?.links || []).map((l) => ({
      ...l,
      source: normalizeId(l.source),
      target: normalizeId(l.target),
      value: Number(l.value ?? 0),
    })),
    contexts: raw?.contexts || {},
    timeline: raw?.timeline || {},
    chapters_meta: raw?.chapters_meta || [],
    mentions: raw?.mentions || {},
    variants: raw?.variants || {},
  };

  S.currentGraphData = data;

  while (svgOuter.firstChild) svgOuter.removeChild(svgOuter.firstChild);

  const width = svgOuter.clientWidth || S.graphWidth;
  const height = svgOuter.clientHeight || S.graphHeight;

  const fg = ForceGraph(
    { nodes: data.nodes, links: data.links },
    {
      nodeId: (d) => d.id,
      nodeTitle: (d) => `${d.id}\nCount: ${d.value}`,
      nodeRadius: (d) => 3 + Math.log2((d.value ?? 0) + 1),
      linkStrokeWidth: (d) => 0.3 + Math.sqrt(d.value ?? 0) * 0.3,
      nodeStrength: -300,
      linkStrength: 0.05,
      width,
      height,
    }
  );

  S.graphInnerSvg = fg;
  S.graphWidth = width;
  S.graphHeight = height;

  fg.dataset.baseViewBox = fg.getAttribute("viewBox") || "";
  svgOuter.appendChild(fg);

  S.graphNodes = Array.from(fg.querySelectorAll("circle"));
  S.graphLinks = Array.from(fg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );

  S.nodeById.clear();
  S.graphNodes.forEach((n) => {
    const d = n.__data__;
    if (d && d.id) S.nodeById.set(d.id, n);
  });

  S.labelLayer = fg.querySelector("g.__labels__");
  if (!S.labelLayer) {
    S.labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    S.labelLayer.setAttribute("class", "__labels__");
    fg.appendChild(S.labelLayer);
  }

  S.graphNodes.forEach((n) => {
    n.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const d = n.__data__;
      if (!d?.id) return;
      selectNode(d.id);
      p.setPanel(S.activePanel);
    });
  });

  wireEdgeClick(fg, data);
  p.wireCharacterList(data);

  let pick = null;
  if (keepNode && S.nodeById.has(keepNode)) pick = keepNode;
  if (!pick && data.nodes.length) {
    pick = [...data.nodes].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.id;
  }
  if (pick) selectNode(pick);

  if (keepEdge) {
    const edgeStatusEl = document.getElementById("edge-status");
    if (edgeStatusEl) edgeStatusEl.textContent = `Editing: ${keepEdge}`;
  }
  p.setPanel(keepPanel);

  S.activeChapter = keepChapter ?? null;
  if (S.activeChapter != null) {
    p.applyChapterEmphasis(S.activeChapter);
    p.renderChapterCard(S.activeChapter);
  }
}

// ---- edge click (contexts) ----
function wireEdgeClick(fg, data) {
  const visibleLinks = Array.from(fg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );

  visibleLinks.forEach((line) => {
    const d = line.__data__;
    if (!d) return;

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hit.classList.add("__hit__");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", 15);
    hit.style.cursor = "pointer";
    line.parentNode.insertBefore(hit, line.nextSibling);

    const sync = () => {
      const x1 = line.getAttribute("x1");
      const y1 = line.getAttribute("y1");
      const x2 = line.getAttribute("x2");
      const y2 = line.getAttribute("y2");
      if (x1 == null || y1 == null || x2 == null || y2 == null) return;
      hit.setAttribute("x1", x1);
      hit.setAttribute("y1", y1);
      hit.setAttribute("x2", x2);
      hit.setAttribute("y2", y2);
    };

    requestAnimationFrame(sync);
    const observer = new MutationObserver(sync);
    observer.observe(line, { attributes: true });

    hit.addEventListener("click", async (ev) => {
      ev.stopPropagation();

      const a = normalizeId(d.source);
      const b = normalizeId(d.target);
      const key = makeEdgeKey(a, b);
      S.selectedEdgeKey = key;

      visibleLinks.forEach((l) => {
        l.setAttribute("stroke", "#999");
        l.setAttribute("stroke-opacity", "0.35");
        l.setAttribute("stroke-width", "1.5");
      });
      line.setAttribute("stroke", "#ff5733");
      line.setAttribute("stroke-opacity", "0.95");
      line.setAttribute("stroke-width", "3");

      const p = await _loadPanels();
      p.setPanel("contexts");

      const ctxRaw = data.contexts?.[key];
      const ctx = ensureArrayContexts(ctxRaw);

      const edgeStatusEl = document.getElementById("edge-status");
      const linkContextEditor = document.getElementById("linkContextEditor");
      const infoEl = document.getElementById("info");

      if (edgeStatusEl) edgeStatusEl.textContent = `Editing: ${key}`;

      if (!ctx.length) {
        if (linkContextEditor) linkContextEditor.value = "";
        if (infoEl) {
          infoEl.innerHTML = `
            <p><b>${escapeHtml(a)}</b> & <b>${escapeHtml(b)}</b>: No context found.</p>
            <button class="btn" onclick="window.addContextManually('${escapeHtml(a)}', '${escapeHtml(b)}')">Add Context Manually</button>
          `;
        }
        return;
      }

      if (linkContextEditor) {
        linkContextEditor.value = ctx.map((x) => (x.text || "").trim()).join("\n\n");
      }

      if (infoEl) {
        const snippets = ctx
          .map((s, idx) => {
            const text = (s.text || "").trim();
            const chips = (s.chapters || [])
              .map(
                (ch) =>
                  `<button class="chip" onclick="window.openChapterFromContext(${Number(ch)})">Chapter ${Number(ch)}</button>`
              )
              .join("");
            const shown = S.selectedNodeId ? highlightSelected(text) : escapeHtml(text);
            return `
            <div style="margin-bottom: 1rem;">
              <blockquote>${shown}</blockquote>
              ${chips ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${chips}</div>` : ""}
              <div style="margin-top: 0.5rem;display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn" onclick="window.editContextWithData('${escapeHtml(a)}', '${escapeHtml(b)}', ${idx})">Edit</button>
                <button class="btn" onclick="window.deleteContext('${escapeHtml(a)}', '${escapeHtml(b)}', ${idx})">Delete</button>
              </div>
            </div>
          `;
          })
          .join("");
        infoEl.innerHTML = `
          <h3 style="text-align:left;margin:0 0 8px;">${escapeHtml(a)} & ${escapeHtml(b)}</h3>
          ${snippets}
          <button class="btn primary" onclick="window.addContextManually('${escapeHtml(a)}', '${escapeHtml(b)}')" style="margin-top: 10px;">Add More Context</button>
        `;
      }
    });
  });
}

// ---- graph emphasis ----
export function applyGraphEmphasis(centerId) {
  if (!S.graphInnerSvg || !S.currentGraphData || !S.nodeById.has(centerId)) return;

  const adj = computeAdjacencyFromLinks(S.currentGraphData);
  const m = adj.get(centerId) || new Map();
  const neighbors = Array.from(m.entries())
    .map(([id, w]) => ({ id, w: Number(w) }))
    .sort((a, b) => b.w - a.w);

  const maxW = neighbors.length ? neighbors[0].w : 1;
  const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxW]);

  S.graphNodes.forEach((n) => {
    const d = n.__data__;
    const id = d?.id;
    const baseR = 3 + Math.log2((d?.value ?? 0) + 1);

    n.setAttribute("opacity", "0.15");
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");

    const hue = (Math.log2((d?.value ?? 0) + 1) * 40) % 360;
    n.setAttribute("fill", `hsl(${hue}, 70%, 65%)`);
    n.setAttribute("r", baseR);

    if (id === centerId) {
      n.setAttribute("opacity", "1");
      n.setAttribute("fill", "#ffcc00");
      n.setAttribute("stroke", "#ff5733");
      n.setAttribute("stroke-width", "3");
      n.setAttribute("r", baseR * 1.25);
      return;
    }

    const w = m.get(id);
    if (w != null) {
      const ww = Number(w);
      const scale = Math.max(0, Math.min(1, ww / (maxW || 1)));
      n.setAttribute("opacity", "0.95");
      n.setAttribute("fill", color(ww));
      n.setAttribute("r", baseR * (1.0 + 0.35 * scale));
    }
  });

  const allLines = Array.from(S.graphInnerSvg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );
  allLines.forEach((line) => {
    const d = line.__data__;
    const a = normalizeId(d?.source);
    const b = normalizeId(d?.target);
    const w = Number(d?.value ?? 0);

    line.setAttribute("opacity", "0.12");
    line.setAttribute("stroke", "#999");
    line.setAttribute("stroke-opacity", "0.35");
    line.setAttribute("stroke-width", "1.2");

    if (a === centerId || b === centerId) {
      line.setAttribute("opacity", "1");
      line.setAttribute("stroke", color(w));
      line.setAttribute("stroke-opacity", "0.95");
      line.setAttribute("stroke-width", String(1.5 + Math.sqrt(w) * 1.0));
    }
  });

  renderNeighborLabels(centerId, neighbors.slice(0, 20));
}

function renderNeighborLabels(centerId, neighborArr) {
  if (!S.labelLayer) return;
  while (S.labelLayer.firstChild) S.labelLayer.removeChild(S.labelLayer.firstChild);
  S.labelItems = [];

  const centerCircle = S.nodeById.get(centerId);
  if (centerCircle?.__data__) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.textContent = centerId;
    t.setAttribute("font-size", "12");
    t.setAttribute("font-weight", "800");
    t.setAttribute("fill", "rgba(232,238,255,.95)");
    t.setAttribute("paint-order", "stroke");
    t.setAttribute("stroke", "rgba(0,0,0,.45)");
    t.setAttribute("stroke-width", "3");
    S.labelLayer.appendChild(t);
    S.labelItems.push({ textEl: t, nodeDataRef: centerCircle.__data__, dx: 10, dy: -10 });
  }

  neighborArr.forEach(({ id, w }) => {
    const circle = S.nodeById.get(id);
    if (!circle?.__data__) return;
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.textContent = String(w);
    t.setAttribute("font-size", "11");
    t.setAttribute("font-weight", "900");
    t.setAttribute("fill", "rgba(232,238,255,.95)");
    t.setAttribute("paint-order", "stroke");
    t.setAttribute("stroke", "rgba(0,0,0,.45)");
    t.setAttribute("stroke-width", "3");
    S.labelLayer.appendChild(t);
    S.labelItems.push({ textEl: t, nodeDataRef: circle.__data__, dx: 10, dy: 4 });
  });

  startLabelLoop();
}

function startLabelLoop() {
  if (S.rafLabelLoop != null) cancelAnimationFrame(S.rafLabelLoop);
  const tick = () => {
    S.labelItems.forEach((it) => {
      const d = it.nodeDataRef;
      if (!d) return;
      const x = Number(d.x ?? 0) + (it.dx ?? 0);
      const y = Number(d.y ?? 0) + (it.dy ?? 0);
      it.textEl.setAttribute("x", String(x));
      it.textEl.setAttribute("y", String(y));
    });
    S.rafLabelLoop = requestAnimationFrame(tick);
  };
  S.rafLabelLoop = requestAnimationFrame(tick);
}

export function emphasizeSingleNeighbor(centerId, neighborId) {
  if (!S.graphInnerSvg) return;
  const key = makeEdgeKey(centerId, neighborId);
  const allLines = Array.from(S.graphInnerSvg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );
  allLines.forEach((line) => {
    const d = line.__data__;
    const a = normalizeId(d?.source);
    const b = normalizeId(d?.target);
    const k = makeEdgeKey(a, b);
    if (k === key) {
      line.setAttribute("stroke", "#ff5733");
      line.setAttribute("stroke-opacity", "0.98");
      line.setAttribute("stroke-width", "4");
      line.setAttribute("opacity", "1");
    }
  });
  const c = S.nodeById.get(neighborId);
  if (c) {
    c.setAttribute("stroke", "#ff5733");
    c.setAttribute("stroke-width", "3");
    c.setAttribute("opacity", "1");
  }
}

export async function resetGraphView() {
  if (!S.graphInnerSvg) return;
  const vb = S.graphInnerSvg.dataset.baseViewBox;
  if (vb) S.graphInnerSvg.setAttribute("viewBox", vb);

  S.selectedNodeId = null;
  S.selectedEdgeKey = null;
  S.activeChapter = null;

  S.graphNodes.forEach((n) => {
    const d = n.__data__;
    const baseR = 3 + Math.log2((d?.value ?? 0) + 1);
    n.setAttribute("opacity", "1");
    n.setAttribute("r", baseR);
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");
    const hue = (Math.log2((d?.value ?? 0) + 1) * 40) % 360;
    n.setAttribute("fill", `hsl(${hue}, 70%, 65%)`);
  });

  const allLines = Array.from(S.graphInnerSvg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );
  allLines.forEach((l) => {
    l.setAttribute("opacity", "1");
    l.setAttribute("stroke", "#999");
    l.setAttribute("stroke-opacity", "0.6");
    l.setAttribute("stroke-width", "1.5");
  });

  if (S.labelLayer) {
    while (S.labelLayer.firstChild) S.labelLayer.removeChild(S.labelLayer.firstChild);
  }
  S.labelItems = [];
  if (S.rafLabelLoop != null) {
    cancelAnimationFrame(S.rafLabelLoop);
    S.rafLabelLoop = null;
  }

  const edgeStatusEl = document.getElementById("edge-status");
  const chapterCardEl = document.getElementById("chapterCard");
  if (edgeStatusEl) edgeStatusEl.textContent = "No edge selected";
  if (chapterCardEl) chapterCardEl.innerHTML = "";

  const p = await _loadPanels();
  p.setPanel("timeline");
}
