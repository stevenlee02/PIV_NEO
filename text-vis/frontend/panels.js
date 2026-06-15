// Right-side panels: Timeline, Flower, Character list, Contexts, Chapter card.
console.log("[panels.js] loading...");
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { S } from "./state.js";
import {
  normalizeId, makeEdgeKey, ensureArrayContexts,
  computeAdjacencyFromLinks, escapeHtml, highlightSelected,
} from "./utils.js";

// Lazy load graph.js to avoid circular dependency
let _graphMod = null;
function _loadGraph() {
  if (!_graphMod) _graphMod = import("./graph.js");
  return _graphMod;
}

console.log("[panels.js] ready");

// ---- chart help (question mark button) ----
let __chartHelpDocBound = false;

export function attachChartHelp(container, text) {
  if (!container) return;
  const oldBtn = container.querySelector(".chart-help-btn");
  const oldPop = container.querySelector(".chart-help-pop");
  if (oldBtn) oldBtn.remove();
  if (oldPop) oldPop.remove();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chart-help-btn";
  btn.textContent = "?";

  const pop = document.createElement("div");
  pop.className = "chart-help-pop";
  pop.textContent = text;
  pop.style.display = "none";

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.style.display = pop.style.display === "none" ? "block" : "none";
  });
  pop.addEventListener("click", (e) => e.stopPropagation());

  if (!__chartHelpDocBound) {
    __chartHelpDocBound = true;
    document.addEventListener("click", () => {
      document.querySelectorAll(".chart-help-pop").forEach((el) => { el.style.display = "none"; });
    }, { passive: true });
  }
  container.appendChild(btn);
  container.appendChild(pop);
}

// ---- panel switching ----
export function setPanel(panelId) {
  S.activePanel = panelId;

  const toggleBar = document.getElementById("panelToggles");
  const rightScroll = document.getElementById("rightScroll");

  toggleBar?.querySelectorAll("button[data-panel]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-panel") === panelId);
  });
  rightScroll?.querySelectorAll(".panel").forEach((p) => {
    const id = p.getAttribute("data-panel");
    p.classList.toggle("hidden", id !== panelId);
  });

  const ctxEditorCard = document.getElementById("context-editor");
  const ctxInfoCard = document.getElementById("info");
  if (panelId !== "contexts") {
    if (ctxEditorCard) ctxEditorCard.style.display = "none";
    if (ctxInfoCard) ctxInfoCard.style.display = "none";
  } else {
    if (ctxEditorCard) ctxEditorCard.style.display = "";
    if (ctxInfoCard) ctxInfoCard.style.display = "";
  }
}

// ---- chapter card ----
export function renderChapterCard(chapter1Based) {
  const chapterCardEl = document.getElementById("chapterCard");
  if (!chapterCardEl || !S.currentGraphData) return;

  const meta = (S.currentGraphData.chapters_meta || []).find((x) => x.index === chapter1Based);
  const title = meta?.title || `Chapter ${chapter1Based}`;
  const snippet = meta?.snippet || "";
  const canon = S.selectedNodeId;
  const ev = S.currentGraphData.mentions?.[canon]?.[chapter1Based] || [];

  chapterCardEl.innerHTML = `
    <h3 style="margin:0 0 8px;">${escapeHtml(title)}</h3>
    ${snippet
      ? `<p style="margin:0 0 10px;color:rgba(232,238,255,.85);">${highlightSelected(snippet)}…</p>`
      : `<p style="margin:0 0 10px;color:rgba(232,238,255,.85);">Chapter ${chapter1Based}</p>`}
    ${ev.length
      ? `<div style="display:flex;flex-direction:column;gap:10px;">
          ${ev.map((s) => `<blockquote style="margin:0;padding:10px;border-left:3px solid rgba(255,204,0,.8);background:rgba(255,255,255,.06);">
            ${highlightSelected(s)}
          </blockquote>`).join("")}
        </div>`
      : `<p style="margin:0;opacity:.75;">No evidence sentences for this character in this chapter.</p>`}
  `;
}

// ---- chapter emphasis on graph ----
export function applyChapterEmphasis(chapterIdx1Based) {
  if (!S.currentGraphData || !S.graphNodes.length || !S.graphInnerSvg) return;
  const idx = chapterIdx1Based - 1;

  const t = S.currentGraphData.timeline || {};
  let maxC = 0;
  (S.currentGraphData.nodes || []).forEach((n) => {
    const arr = t[n.id] || [];
    const c = Number(arr[idx] || 0);
    if (c > maxC) maxC = c;
  });
  if (maxC <= 0) maxC = 1;

  S.graphNodes.forEach((circle) => {
    const d = circle.__data__;
    const id = d?.id;
    const baseR = 3 + Math.log2((d?.value ?? 0) + 1);
    const arr = t[id] || [];
    const c = Number(arr[idx] || 0);
    const p = Math.min(1, c / maxC);
    circle.setAttribute("opacity", c > 0 ? String(0.25 + 0.75 * p) : "0.08");
    circle.setAttribute("r", String(baseR * (1 + 0.6 * p)));
    circle.setAttribute("stroke", c > 0 ? "#ffcc00" : "#fff");
    circle.setAttribute("stroke-width", c > 0 ? "2.2" : "1.2");
  });

  const lines = Array.from(S.graphInnerSvg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );
  lines.forEach((line) => {
    const d = line.__data__;
    const a = normalizeId(d?.source);
    const b = normalizeId(d?.target);
    const ca = Number((t[a] || [])[idx] || 0);
    const cb = Number((t[b] || [])[idx] || 0);
    const w = ca + cb;
    const p = Math.min(1, w / (maxC * 2 || 1));
    line.setAttribute("opacity", w > 0 ? String(0.15 + 0.85 * p) : "0.05");
    line.setAttribute("stroke-opacity", w > 0 ? String(0.2 + 0.8 * p) : "0.15");
    line.setAttribute("stroke-width", String(1.1 + 2.5 * p));
  });
}

// ---- character details ----
export function showCharacterDetails(centerId) {
  const detailsEl = document.getElementById("details");
  if (!detailsEl || !S.currentGraphData) return;

  const data = S.currentGraphData;
  const centerNode = data.nodes.find((n) => n.id === centerId);
  const centerCount = centerNode ? centerNode.value ?? 0 : 0;

  const neighborMap = new Map();
  data.links.forEach((l) => {
    const a = normalizeId(l.source);
    const b = normalizeId(l.target);
    const w = Number(l.value ?? 0);
    if (a === centerId || b === centerId) {
      const other = a === centerId ? b : a;
      const neighborNode = data.nodes.find((n) => n.id === other);
      const neighborCount = neighborNode ? neighborNode.value ?? 0 : 0;
      if (!neighborMap.has(other)) {
        neighborMap.set(other, { id: other, count: neighborCount, cooccurrence: 0 });
      }
      neighborMap.get(other).cooccurrence += w;
    }
  });

  const neighbors = Array.from(neighborMap.values()).sort((x, y) => y.cooccurrence - x.cooccurrence);
  const flowerHostId = "__flower_host__";

  let html = `
    <h3 style="text-align:left;margin:0 0 6px;">${escapeHtml(centerId)}</h3>
    <p style="margin:0 0 10px;color:rgba(232,238,255,.85);">Appears <b>${centerCount}</b> times in text.</p>
    <div class="chart-box" id="flower-box" style="margin:8px 0 12px;">
      <div id="${flowerHostId}"></div>
    </div>
  `;

  if (!neighbors.length) {
    html += `<p style="opacity:.8;">No neighbor characters.</p>`;
  } else {
    html += `
      <details class="neighbors-block" open>
        <summary>Neighbors (${neighbors.length})</summary>
        <div class="neighbors-table-wrapper">
          <table class="neighbors-table">
            <thead><tr><th>Character</th><th>Appearances</th><th>Co-occurrences</th></tr></thead>
            <tbody>
              ${neighbors.map((n) => `
                <tr class="__neighbor_row__" data-id="${escapeHtml(n.id)}" style="cursor:pointer;">
                  <td>${escapeHtml(n.id)}</td><td>${n.count}</td><td>${n.cooccurrence}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  detailsEl.innerHTML = html;

  detailsEl.querySelectorAll(".__neighbor_row__").forEach((row) => {
    row.addEventListener("click", async () => {
      const id = row.getAttribute("data-id");
      if (!id) return;
      S.activeChapter = null;
      const g = await _loadGraph();
      g.selectNode(id);
      setPanel(S.activePanel);
    });
  });

  renderFlower(centerId, 16);
}

// ---- timeline ----
export function renderCharacterTimeline(timelineData) {
  const timelineBox = document.getElementById("timeline-box");
  if (timelineBox) {
    attachChartHelp(timelineBox,
      "This timeline shows how often the selected character appears across chapters.\n\n" +
      "Each point represents a chapter.\n" +
      "The height indicates number of mentions.\n" +
      "Click a point to highlight that chapter."
    );
  }

  const svgEl = document.getElementById("timeline-svg");
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const width = svgEl.clientWidth || 400;
  const height = svgEl.clientHeight || 180;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  if (!timelineData || !timelineData.length || d3.max(timelineData, (d) => d.count) === 0) {
    svg.append("text").attr("x", 10).attr("y", 20).attr("font-size", 12).text("No timeline data.");
    return;
  }

  const margin = { top: 20, right: 18, bottom: 30, left: 45 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const maxChapter = d3.max(timelineData, (d) => d.chapter);
  const maxCount = d3.max(timelineData, (d) => d.count);

  const x = d3.scaleLinear().domain([1, maxChapter]).range([0, innerW]);
  const y = d3.scaleLinear().domain([0, maxCount]).nice().range([innerH, 0]);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g").attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(Math.min(20, maxChapter)).tickFormat(d3.format("d")));
  g.append("g").call(d3.axisLeft(y).ticks(4));

  const line = d3.line().x((d) => x(d.chapter)).y((d) => y(d.count));
  g.append("path").datum(timelineData).attr("fill", "none")
    .attr("stroke", "rgba(110,168,255,.95)").attr("stroke-width", 2.2).attr("d", line);

  const dots = g.selectAll("circle").data(timelineData).enter()
    .append("circle")
    .attr("cx", (d) => x(d.chapter))
    .attr("cy", (d) => y(d.count))
    .attr("r", 3)
    .attr("fill", "rgba(255,204,0,.95)")
    .style("cursor", "pointer");

  dots.append("title").text((d) => `Chapter ${d.chapter}: ${d.count} time(s)`);
  dots.on("click", (event, d) => {
    S.activeChapter = d.chapter;
    applyChapterEmphasis(d.chapter);
    renderChapterCard(d.chapter);
  });
}

// ---- flower diagram ----
export function renderFlower(centerId, topK = 16) {
  const detailsEl = document.getElementById("details");
  const host = detailsEl?.querySelector("#__flower_host__");
  if (!host || !S.currentGraphData || !centerId) return;

  host.innerHTML = "";

  const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEl.id = "flower-svg";
  svgEl.setAttribute("height", "240");
  svgEl.style.width = "100%";
  host.appendChild(svgEl);

  const flowerBox = host.parentElement;
  if (flowerBox) {
    attachChartHelp(flowerBox,
      "This flower diagram shows the characters most strongly connected to the selected character.\n\n" +
      "Each petal represents a co-occurring character.\n" +
      "Petal size and color indicate relationship strength.\n" +
      "Click a petal to switch focus to that character."
    );
  }

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const width = svgEl.clientWidth || 420;
  const height = 240;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const cx = width / 2;
  const cy = height / 2 + 6;
  const adj = computeAdjacencyFromLinks(S.currentGraphData);
  const m = adj.get(centerId) || new Map();

  let neighbors = Array.from(m.entries())
    .map(([id, w]) => ({ id, w: Number(w) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, topK);

  if (!neighbors.length) {
    svg.append("text").attr("x", 10).attr("y", 20).attr("font-size", 12).text("No relationship data for flower.");
    return;
  }

  const maxW = d3.max(neighbors, (d) => d.w) || 1;
  const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxW]);
  const r0 = 26;
  const rMax = Math.min(width, height) * 0.42;
  const rScale = d3.scaleSqrt().domain([0, maxW]).range([r0 + 18, rMax]);
  const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

  g.append("circle").attr("r", r0).attr("fill", "rgba(255,255,255,.08)")
    .attr("stroke", "rgba(255,255,255,.18)").attr("stroke-width", 1.2);
  g.append("text").attr("text-anchor", "middle").attr("dy", "0.35em")
    .attr("font-weight", 900).attr("font-size", 12)
    .attr("fill", "rgba(232,238,255,.95)")
    .text(centerId.length > 18 ? centerId.slice(0, 18) + "…" : centerId);

  const n = neighbors.length;
  const pad = Math.min(0.06, ((Math.PI * 2) / n) * 0.18);
  const arc = d3.arc();

  const petals = g.selectAll("path").data(neighbors).enter()
    .append("path")
    .attr("d", (d, i) => {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      return arc({ innerRadius: r0 + 6, outerRadius: rScale(d.w), startAngle: a0 + pad, endAngle: a1 - pad });
    })
    .attr("fill", (d) => color(d.w))
    .attr("opacity", 0.95)
    .style("cursor", "pointer")
    .on("mouseenter", async (event, d) => {
      S.activeChapter = null;
      const gmod = await _loadGraph();
      gmod.applyGraphEmphasis(centerId);
      gmod.emphasizeSingleNeighbor(centerId, d.id);
    })
    .on("mouseleave", async () => {
      const gmod = await _loadGraph();
      gmod.applyGraphEmphasis(centerId);
    })
    .on("click", async (event, d) => {
      S.activeChapter = null;
      const gmod = await _loadGraph();
      gmod.selectNode(d.id);
      setPanel(S.activePanel);
    });

  petals.append("title").text((d) => `${centerId} - ${d.id}: ${d.w}`);

  g.selectAll("text.__petal_label__").data(neighbors).enter()
    .append("text")
    .attr("class", "__petal_label__")
    .attr("font-size", 10).attr("font-weight", 800)
    .attr("fill", "rgba(232,238,255,.92)")
    .attr("paint-order", "stroke").attr("stroke", "rgba(0,0,0,.55)").attr("stroke-width", 3)
    .attr("dominant-baseline", "middle")
    .attr("text-anchor", (d, i) => {
      const mid = ((i + 0.5) / n) * Math.PI * 2;
      return Math.cos(mid - Math.PI / 2) < 0 ? "end" : "start";
    })
    .attr("transform", (d, i) => {
      const mid = ((i + 0.5) / n) * Math.PI * 2;
      const rr = rScale(d.w) + 10;
      return `translate(${Math.cos(mid - Math.PI / 2) * rr},${Math.sin(mid - Math.PI / 2) * rr})`;
    })
    .text((d) => (d.id.length > 14 ? d.id.slice(0, 14) + "…" : d.id));
}

// ---- character list panel ----
export function wireCharacterList(data) {
  const listEl = document.getElementById("charList");
  const searchInput = document.getElementById("charSearch");
  const sortMode = document.getElementById("sortMode");
  if (!listEl) return;

  const nodesWithValue = (data.nodes || []).map((d, i) => ({
    ...d, id: d.id || `node-${i}`, value: Number(d.value ?? 0),
  }));

  function surnameKey(name) {
    const parts = String(name).trim().split(/\s+/);
    return (parts.length >= 2 ? parts[parts.length - 1] : parts[0]).toLowerCase();
  }

  function sortList(list) {
    const mode = sortMode ? sortMode.value : "freq";
    if (mode === "name") return [...list].sort((a, b) => surnameKey(a.id).localeCompare(surnameKey(b.id)));
    return [...list].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }

  function renderCharList(list) {
    listEl.innerHTML = sortList(list)
      .map((d) => `<li data-id="${escapeHtml(d.id)}">${escapeHtml(d.id)} (${d.value})</li>`)
      .join("");
  }

  function applyFilterAndRender() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    renderCharList(q ? nodesWithValue.filter((d) => d.id.toLowerCase().includes(q)) : nodesWithValue);
  }

  applyFilterAndRender();

  listEl.onclick = async (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const name = li.getAttribute("data-id");
    if (!name) return;
    S.activeChapter = null;
    const g = await _loadGraph();
    g.selectNode(name);
    setPanel(S.activePanel);
  };

  if (searchInput) searchInput.oninput = applyFilterAndRender;
  if (sortMode) sortMode.onchange = applyFilterAndRender;
}

// ---- save context handler ----
export function wireSaveContext() {
  const saveBtn = document.getElementById("saveContextBtn");
  const editor = document.getElementById("linkContextEditor");
  if (!saveBtn || !editor) return;

  saveBtn.addEventListener("click", async () => {
    if (!S.selectedEdgeKey) { alert("Please click an edge first to select it."); return; }
    if (!S.currentGraphData) { alert("No graph data loaded."); return; }

    const rawText = editor.value || "";
    const items = rawText.split(/\n{2,}/).map((x) => x.trim()).filter((x) => x.length > 0);
    if (!S.currentGraphData.contexts) S.currentGraphData.contexts = {};
    S.currentGraphData.contexts[S.selectedEdgeKey] = items.map((text) => ({ text, chapters: [] }));

    const g = await _loadGraph();
    g.drawGraph(S.currentGraphData);

    const edgeStatusEl = document.getElementById("edge-status");
    if (edgeStatusEl) edgeStatusEl.textContent = `Saved contexts for ${S.selectedEdgeKey}`;
    setPanel("contexts");
    alert("Context saved successfully!");
  });
}

// ---- window-level context management (called from inline onclick) ----
window.openChapterFromContext = function (ch) {
  const c = Number(ch);
  if (!c || !S.currentGraphData) return;
  S.activeChapter = c;
  setPanel("timeline");
  applyChapterEmphasis(c);
  renderChapterCard(c);
  if (S.selectedNodeId) {
    const counts = (S.currentGraphData.timeline && S.currentGraphData.timeline[S.selectedNodeId]) || [];
    renderCharacterTimeline(counts.map((x, idx) => ({ chapter: idx + 1, count: x })));
  }
};

window.deleteContext = async function (a, b, i) {
  if (!S.currentGraphData) return;
  const key = makeEdgeKey(a, b);
  const arr = ensureArrayContexts(S.currentGraphData.contexts?.[key]);
  if (!arr[i]) return;
  arr.splice(i, 1);
  if (!S.currentGraphData.contexts) S.currentGraphData.contexts = {};
  if (arr.length === 0) {
    delete S.currentGraphData.contexts[key];
    const idx = (S.currentGraphData.links || []).findIndex(
      (l) => makeEdgeKey(normalizeId(l.source), normalizeId(l.target)) === key);
    if (idx > -1) S.currentGraphData.links.splice(idx, 1);
  } else {
    S.currentGraphData.contexts[key] = arr.map((x) => ({ text: x.text, chapters: x.chapters || [] }));
  }
  const g = await _loadGraph();
  g.drawGraph(S.currentGraphData);
  setPanel("contexts");
};

window.addContextManually = async function (a, b) {
  if (!S.currentGraphData) return;
  const txt = prompt(`Context for ${a}&${b}:`);
  if (!txt) return;
  const key = makeEdgeKey(a, b);
  S.currentGraphData.contexts = S.currentGraphData.contexts || {};
  S.currentGraphData.contexts[key] = ensureArrayContexts(S.currentGraphData.contexts[key]);
  S.currentGraphData.contexts[key].push({ text: txt.trim(), chapters: [] });
  if (!S.currentGraphData.nodes.find((n) => n.id === a)) S.currentGraphData.nodes.push({ id: a, value: 0 });
  if (!S.currentGraphData.nodes.find((n) => n.id === b)) S.currentGraphData.nodes.push({ id: b, value: 0 });
  const exists = S.currentGraphData.links.some(
    (l) => makeEdgeKey(normalizeId(l.source), normalizeId(l.target)) === key);
  if (!exists) S.currentGraphData.links.push({ source: a, target: b, value: 1 });
  const g = await _loadGraph();
  g.drawGraph(S.currentGraphData);
  setPanel("contexts");
};

window.editContextWithData = async function (a, b, idx) {
  if (!S.currentGraphData) return;
  const key = makeEdgeKey(a, b);
  const arr = ensureArrayContexts(S.currentGraphData.contexts?.[key]);
  if (!arr[idx]) return;
  const old = arr[idx].text || "";
  const txt = prompt(`Edit context for ${a}&${b}:`, old);
  if (txt == null) return;
  arr[idx] = { text: txt.trim(), chapters: [] };
  S.currentGraphData.contexts[key] = arr;
  const g = await _loadGraph();
  g.drawGraph(S.currentGraphData);
  setPanel("contexts");
};
