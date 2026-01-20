import { ForceGraph } from "./forceGraph.js";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// ---------------- 全局状态 ----------------
let currentGraphData = null; // {nodes, links, contexts, timeline, chapters_meta, mentions...}
let selectedEdgeKey = null; // "A|B"
let selectedNodeId = null; // "A"
let activePanel = "timeline"; // timeline | neighbors | contexts | allchars

// ✅ timeline 新增状态
let activeChapter = null; // number | null

let graphInnerSvg = null; // ForceGraph 返回的 <svg>
let graphNodes = []; // circles
let graphLinks = []; // lines（真实边，不含 hit 线）
let nodeById = new Map(); // id -> circle
let graphWidth = 0;
let graphHeight = 0;

let labelLayer = null; // <g> 用于 labels
let rafLabelLoop = null; // requestAnimationFrame id
let labelItems = []; // {textEl, nodeDataRef, dx, dy}

// ---------------- DOM 引用 ----------------
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");

const svgOuter = document.getElementById("graph"); // 外层 <svg id="graph">

// Contexts（右侧 contexts panel 内）
const infoEl = document.getElementById("info");
const linkContextEditor = document.getElementById("linkContextEditor");
const saveContextBtn = document.getElementById("saveContextBtn");
const edgeStatusEl = document.getElementById("edge-status");

// Enter Text to Analyze（左侧）
const articleInput = document.getElementById("articleInput");
const articleAnalyzeBtn = document.getElementById("articleAnalyzeBtn");

// 右侧容器
const rightScroll = document.getElementById("rightScroll");
const toggleBar = document.getElementById("panelToggles");

// panels
const detailsEl = document.getElementById("details");
const resetViewBtn = document.getElementById("resetViewBtn");

// timeline 卡片容器
const chapterCardEl = document.getElementById("chapterCard");

//charthelp问号按钮
let __chartHelpDocBound = false;

function attachChartHelp(container, text) {
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
    document.addEventListener(
      "click",
      () => {
        document.querySelectorAll(".chart-help-pop").forEach((el) => {
          el.style.display = "none";
        });
      },
      { passive: true }
    );
  }

  container.appendChild(btn);
  container.appendChild(pop);
}

// ---------------- 工具函数 ----------------
function normalizeId(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && x.id) return x.id;
  return String(x);
}
function makeEdgeKey(a, b) {
  return [a, b].sort().join("|");
}

function ensureArrayContexts(entryArr) {
  const arr = Array.isArray(entryArr) ? entryArr : [];
  return arr.map((e) => {
    if (typeof e === "string") return { text: e, chapters: [] };
    if (e && typeof e.text === "string")
      return { text: e.text, chapters: Array.isArray(e.chapters) ? e.chapters : [] };
    return { text: String(e ?? ""), chapters: [] };
  });
}

function computeAdjacencyFromLinks(data) {
  const adj = new Map(); // id -> Map(neighbor -> weight)
  function ensure(id) {
    if (!adj.has(id)) adj.set(id, new Map());
    return adj.get(id);
  }
  (data?.links || []).forEach((l) => {
    const s = normalizeId(l.source);
    const t = normalizeId(l.target);
    const w = Number(l.value ?? 0);
    if (!s || !t) return;
    ensure(s).set(t, (ensure(s).get(t) || 0) + w);
    ensure(t).set(s, (ensure(t).get(s) || 0) + w);
  });
  return adj;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------------- 外层 svg 尺寸自适应 ----------------
function resizeSVG() {
  if (!svgOuter) return;
  graphWidth = svgOuter.clientWidth || Math.floor(window.innerWidth * 0.6);
  graphHeight = svgOuter.clientHeight || Math.floor(window.innerHeight * 0.7);
  svgOuter.setAttribute("width", graphWidth);
  svgOuter.setAttribute("height", graphHeight);
}
resizeSVG();
window.addEventListener("resize", resizeSVG);

// ---------------- setPanel ----------------
function setPanel(panelId) {
  activePanel = panelId;

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
    ctxEditorCard && (ctxEditorCard.style.display = "none");
    ctxInfoCard && (ctxInfoCard.style.display = "none");
  } else {
    ctxEditorCard && (ctxEditorCard.style.display = "");
    ctxInfoCard && (ctxInfoCard.style.display = "");
  }
}

if (toggleBar) {
  toggleBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-panel]");
    if (!btn) return;
    setPanel(btn.getAttribute("data-panel"));
  });
}

// 初始显示 Timeline
setPanel(activePanel);

// ---------------- API 请求 ----------------
async function postFileAnalyze(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("http://127.0.0.1:8000/analyze", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function postTextAnalyze(text) {
  const res = await fetch("http://127.0.0.1:8000/analyze-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

if (uploadBtn) {
  uploadBtn.addEventListener("click", async () => {
    const file = fileInput?.files?.[0];
    if (!file) return alert("Please select a file first.");

    statusEl && (statusEl.textContent = "Analyzing... (this may take a minute)");
    try {
      const data = await postFileAnalyze(file);
      statusEl && (statusEl.textContent = "Done!");
      drawGraph(data);
    } catch (err) {
      console.error("❌ Backend error:", err);
      statusEl && (statusEl.textContent = "Error occurred.");
    }
  });
}

if (articleAnalyzeBtn && articleInput) {
  articleAnalyzeBtn.addEventListener("click", async () => {
    const text = articleInput.value.trim();
    if (!text) return alert("Please paste or write text to analyze.");

    statusEl && (statusEl.textContent = "Analyzing... (this may take a minute)");
    try {
      const data = await postTextAnalyze(text);
      statusEl && (statusEl.textContent = "Done!");
      drawGraph(data);
    } catch (err) {
      console.error("❌ Backend error:", err);
      statusEl && (statusEl.textContent = "Error occurred.");
    }
  });
}

// ---------------- timeline 卡片渲染（4） ----------------
function renderChapterCard(chapter1Based) {
  if (!chapterCardEl || !currentGraphData) return;

  const meta = (currentGraphData.chapters_meta || []).find((x) => x.index === chapter1Based);
  const title = meta?.title || `Chapter ${chapter1Based}`;
  const snippet = meta?.snippet || "";

  const canon = selectedNodeId;
  const ev = currentGraphData.mentions?.[canon]?.[chapter1Based] || [];

  chapterCardEl.innerHTML = `
    <h3 style="margin:0 0 8px;">${escapeHtml(title)}</h3>
    ${
      snippet
        ? `<p style="margin:0 0 10px;color:rgba(232,238,255,.85);">${escapeHtml(snippet)}…</p>`
        : `<p style="margin:0 0 10px;color:rgba(232,238,255,.85);">Chapter ${chapter1Based}</p>`
    }
    ${
      ev.length
        ? `<div style="display:flex;flex-direction:column;gap:10px;">
            ${ev
              .map(
                (s) => `<blockquote style="margin:0;padding:10px;border-left:3px solid rgba(255,204,0,.8);background:rgba(255,255,255,.06);">
                  ${escapeHtml(s)}
                </blockquote>`
              )
              .join("")}
          </div>`
        : `<p style="margin:0;opacity:.75;">No evidence sentences for this character in this chapter.</p>`
    }
  `;
}

// ---------------- timeline 章节高亮（1） ----------------
function applyChapterEmphasis(chapterIdx1Based) {
  if (!currentGraphData || !graphNodes || !graphInnerSvg) return;
  const idx = chapterIdx1Based - 1;

  const t = currentGraphData.timeline || {};
  let maxC = 0;
  (currentGraphData.nodes || []).forEach((n) => {
    const arr = t[n.id] || [];
    const c = Number(arr[idx] || 0);
    if (c > maxC) maxC = c;
  });
  if (maxC <= 0) maxC = 1;

  graphNodes.forEach((circle) => {
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

  const lines = Array.from(graphInnerSvg.querySelectorAll("line")).filter(
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

// ---------------- 核心：选中节点 ----------------
function selectNode(id) {
  if (!currentGraphData || !id) return;
  selectedNodeId = id;

  // 默认强调模式：节点中心
  applyGraphEmphasis(id);

  showCharacterDetails(id);

  const counts = (currentGraphData.timeline && currentGraphData.timeline[id]) || [];
  const timelineData = counts.map((c, idx) => ({ chapter: idx + 1, count: c }));
  renderCharacterTimeline(timelineData);

  renderFlower(id, 16);

  // ✅ 如果当前处于章节模式：切角色后卡片要更新，并保持章节高亮
  if (activeChapter != null) {
    applyChapterEmphasis(activeChapter);
    renderChapterCard(activeChapter);
  } else {
    // 没选章节时，卡片清空或显示默认
    if (chapterCardEl) chapterCardEl.innerHTML = "";
  }
}

// ---------------- 渲染图 ----------------
function drawGraph(raw) {
  const keepPanel = activePanel;
  const keepNode = selectedNodeId;
  const keepEdge = selectedEdgeKey;
  const keepChapter = activeChapter;

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
  };

  currentGraphData = data;

  while (svgOuter.firstChild) svgOuter.removeChild(svgOuter.firstChild);

  const width = svgOuter.clientWidth || graphWidth;
  const height = svgOuter.clientHeight || graphHeight;

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

  graphInnerSvg = fg;
  graphWidth = width;
  graphHeight = height;

  fg.dataset.baseViewBox = fg.getAttribute("viewBox") || "";
    // 挂到外层
  svgOuter.appendChild(fg);

  // 收集 nodes/links
  graphNodes = Array.from(fg.querySelectorAll("circle"));
  graphLinks = Array.from(fg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );

  nodeById.clear();
  graphNodes.forEach((n) => {
    const d = n.__data__;
    if (d && d.id) nodeById.set(d.id, n);
  });

  labelLayer = fg.querySelector("g.__labels__");
  if (!labelLayer) {
    labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    labelLayer.setAttribute("class", "__labels__");
    fg.appendChild(labelLayer);
  }

  graphNodes.forEach((n) => {
    n.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const d = n.__data__;
      if (!d?.id) return;
      selectNode(d.id);
      setPanel(activePanel);
    });
  });

  wireEdgeClick(fg, data);
  wireCharacterList(data);

  let pick = null;
  if (keepNode && nodeById.has(keepNode)) pick = keepNode;
  if (!pick && data.nodes.length) {
    pick = [...data.nodes].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.id;
  }
  if (pick) selectNode(pick);

  if (keepEdge && edgeStatusEl) edgeStatusEl.textContent = `Editing: ${keepEdge}`;
  setPanel(keepPanel);

  // ✅ 恢复章节状态
  activeChapter = keepChapter ?? null;
  if (activeChapter != null) {
    applyChapterEmphasis(activeChapter);
    renderChapterCard(activeChapter);
  }
}

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

    hit.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const a = normalizeId(d.source);
      const b = normalizeId(d.target);
      const key = makeEdgeKey(a, b);
      selectedEdgeKey = key;

      visibleLinks.forEach((l) => {
        l.setAttribute("stroke", "#999");
        l.setAttribute("stroke-opacity", "0.35");
        l.setAttribute("stroke-width", "1.5");
      });
      line.setAttribute("stroke", "#ff5733");
      line.setAttribute("stroke-opacity", "0.95");
      line.setAttribute("stroke-width", "3");

      setPanel("contexts");

      const ctxRaw = data.contexts?.[key];
      const ctx = ensureArrayContexts(ctxRaw);

      if (edgeStatusEl) edgeStatusEl.textContent = `Editing: ${key}`;

      if (!ctx.length) {
        if (linkContextEditor) linkContextEditor.value = "";
        if (infoEl) {
          infoEl.innerHTML = `
            <p><b>${escapeHtml(a)}</b> & <b>${escapeHtml(b)}</b>: No context found.</p>
            <button class="btn" onclick="addContextManually('${escapeHtml(a)}', '${escapeHtml(b)}')">Add Context Manually</button>
          `;
        }
        return;
      }

      if (linkContextEditor) {
        linkContextEditor.value = ctx.map((x) => (x.text || "").trim()).join("\n\n");
      }

      // ✅ 3: snippets 下方显示 chapter chips，点击跳到 timeline + 高亮章节 + 卡片
      if (infoEl) {
        const snippets = ctx
          .map((s, idx) => {
            const text = (s.text || "").trim();
            const chips = (s.chapters || [])
              .map(
                (ch) =>
                  `<button class="chip" onclick="openChapterFromContext(${Number(ch)})">Chapter ${Number(
                    ch
                  )}</button>`
              )
              .join("");

            return `
            <div style="margin-bottom: 1rem;">
              <blockquote>${escapeHtml(text)}</blockquote>
              ${chips ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">${chips}</div>` : ""}
              <div style="margin-top: 0.5rem;display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn" onclick="editContextWithData('${escapeHtml(a)}', '${escapeHtml(b)}', ${idx})">Edit</button>
                <button class="btn" onclick="deleteContext('${escapeHtml(a)}', '${escapeHtml(b)}', ${idx})">Delete</button>
              </div>
            </div>
          `;
          })
          .join("");

        infoEl.innerHTML = `
          <h3 style="text-align:left;margin:0 0 8px;">📖 ${escapeHtml(a)} & ${escapeHtml(b)}</h3>
          ${snippets}
          <button class="btn primary" onclick="addContextManually('${escapeHtml(a)}', '${escapeHtml(b)}')" style="margin-top: 10px;">Add More Context</button>
        `;
      }
    });
  });
}

// ✅ chip 点击：跳到 timeline 章节（3）
window.openChapterFromContext = function (ch) {
  const c = Number(ch);
  if (!c || !currentGraphData) return;
  activeChapter = c;
  setPanel("timeline");
  applyChapterEmphasis(c);
  renderChapterCard(c);

  // timeline 仍显示当前角色的 timeline，如果没有选角色就不强行选
  if (selectedNodeId) {
    const counts = (currentGraphData.timeline && currentGraphData.timeline[selectedNodeId]) || [];
    const timelineData = counts.map((x, idx) => ({ chapter: idx + 1, count: x }));
    renderCharacterTimeline(timelineData);
  }
};

// ---------------- 图强调：淡化无关 + 邻居颜色/大小 + labels ----------------
function applyGraphEmphasis(centerId) {
  if (!graphInnerSvg || !currentGraphData || !nodeById.has(centerId)) return;

  const adj = computeAdjacencyFromLinks(currentGraphData);
  const m = adj.get(centerId) || new Map();
  const neighbors = Array.from(m.entries())
    .map(([id, w]) => ({ id, w: Number(w) }))
    .sort((a, b) => b.w - a.w);

  const maxW = neighbors.length ? neighbors[0].w : 1;
  const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxW]);

  graphNodes.forEach((n) => {
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

  const allLines = Array.from(graphInnerSvg.querySelectorAll("line")).filter(
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
  if (!labelLayer) return;
  while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
  labelItems = [];

  const centerCircle = nodeById.get(centerId);
  if (centerCircle?.__data__) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.textContent = centerId;
    t.setAttribute("font-size", "12");
    t.setAttribute("font-weight", "800");
    t.setAttribute("fill", "rgba(232,238,255,.95)");
    t.setAttribute("paint-order", "stroke");
    t.setAttribute("stroke", "rgba(0,0,0,.45)");
    t.setAttribute("stroke-width", "3");
    labelLayer.appendChild(t);
    labelItems.push({ textEl: t, nodeDataRef: centerCircle.__data__, dx: 10, dy: -10 });
  }

  neighborArr.forEach(({ id, w }) => {
    const circle = nodeById.get(id);
    if (!circle?.__data__) return;

    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.textContent = String(w);
    t.setAttribute("font-size", "11");
    t.setAttribute("font-weight", "900");
    t.setAttribute("fill", "rgba(232,238,255,.95)");
    t.setAttribute("paint-order", "stroke");
    t.setAttribute("stroke", "rgba(0,0,0,.45)");
    t.setAttribute("stroke-width", "3");
    labelLayer.appendChild(t);

    labelItems.push({ textEl: t, nodeDataRef: circle.__data__, dx: 10, dy: 4 });
  });

  startLabelLoop();
}

function startLabelLoop() {
  if (rafLabelLoop != null) cancelAnimationFrame(rafLabelLoop);

  const tick = () => {
    labelItems.forEach((it) => {
      const d = it.nodeDataRef;
      if (!d) return;
      const x = Number(d.x ?? 0) + (it.dx ?? 0);
      const y = Number(d.y ?? 0) + (it.dy ?? 0);
      it.textEl.setAttribute("x", String(x));
      it.textEl.setAttribute("y", String(y));
    });
    rafLabelLoop = requestAnimationFrame(tick);
  };

  rafLabelLoop = requestAnimationFrame(tick);
}

// ---------------- Character 详情（邻居表 + 点击选中） ----------------
function showCharacterDetails(centerId) {
  if (!detailsEl || !currentGraphData) return;

  const data = currentGraphData;

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

  const neighbors = Array.from(neighborMap.values()).sort(
    (x, y) => y.cooccurrence - x.cooccurrence
  );

  const flowerHostId = "__flower_host__";
  let flowerHost = detailsEl.querySelector(`#${flowerHostId}`);
  if (!flowerHost) {
    flowerHost = document.createElement("div");
    flowerHost.id = flowerHostId;
  }

  let html = `
    <h3 style="text-align:left;margin:0 0 6px;">🧍 ${escapeHtml(centerId)}</h3>
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
            <thead>
              <tr>
                <th>Character</th>
                <th>Appearances</th>
                <th>Co-occurrences</th>
              </tr>
            </thead>
            <tbody>
              ${neighbors
                .map(
                  (n) => `
                <tr class="__neighbor_row__" data-id="${escapeHtml(n.id)}" style="cursor:pointer;">
                  <td>${escapeHtml(n.id)}</td>
                  <td>${n.count}</td>
                  <td>${n.cooccurrence}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  detailsEl.innerHTML = html;

  detailsEl.querySelectorAll(".__neighbor_row__").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-id");
      if (!id) return;
      activeChapter = null; // 切人默认退出章节模式
      selectNode(id);
      setPanel(activePanel);
    });
  });

  renderFlower(centerId, 16);
}

// ---------------- Timeline ----------------
function renderCharacterTimeline(timelineData) {
  const timelineBox = document.getElementById("timeline-box");
  if (timelineBox) {
    attachChartHelp(
      timelineBox,
      "This timeline shows how often the selected character appears across chapters.\n\n" +
        "• Each point represents a chapter.\n" +
        "• The height indicates number of mentions.\n" +
        "• Click a point to highlight that chapter."
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

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(Math.min(20, maxChapter)).tickFormat(d3.format("d")));

  g.append("g").call(d3.axisLeft(y).ticks(4));

  const line = d3.line().x((d) => x(d.chapter)).y((d) => y(d.count));

  g.append("path")
    .datum(timelineData)
    .attr("fill", "none")
    .attr("stroke", "rgba(110,168,255,.95)")
    .attr("stroke-width", 2.2)
    .attr("d", line);

  const dots = g
    .selectAll("circle")
    .data(timelineData)
    .enter()
    .append("circle")
    .attr("cx", (d) => x(d.chapter))
    .attr("cy", (d) => y(d.count))
    .attr("r", 3)
    .attr("fill", "rgba(255,204,0,.95)")
    .style("cursor", "pointer");

  dots.append("title").text((d) => `Chapter ${d.chapter}: ${d.count} time(s)`);

  // ✅ 1 + 4：点击 dot -> 章节高亮 + 章节卡片
  dots.on("click", (event, d) => {
    activeChapter = d.chapter;
    applyChapterEmphasis(d.chapter);
    renderChapterCard(d.chapter);
  });
}

// ---------------- Flower ----------------
function renderFlower(centerId, topK = 16) {
  const host = detailsEl?.querySelector("#__flower_host__");
  if (!host || !currentGraphData || !centerId) return;

  host.innerHTML = "";

  const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEl.id = "flower-svg";
  svgEl.setAttribute("height", "240");
  svgEl.style.width = "100%";
  host.appendChild(svgEl);

  const flowerBox = host.parentElement; // .chart-box#flower-box
  if (flowerBox) {
    attachChartHelp(
      flowerBox,
      "This flower diagram shows the characters most strongly connected to the selected character.\n\n" +
        "• Each petal represents a co-occurring character.\n" +
        "• Petal size and color indicate relationship strength.\n" +
        "• Click a petal to switch focus to that character."
    );
  }

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const width = svgEl.clientWidth || 420;
  const height = 240;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const cx = width / 2;
  const cy = height / 2 + 6;

  const adj = computeAdjacencyFromLinks(currentGraphData);
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

  g.append("circle")
    .attr("r", r0)
    .attr("fill", "rgba(255,255,255,.08)")
    .attr("stroke", "rgba(255,255,255,.18)")
    .attr("stroke-width", 1.2);

  g.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .attr("font-weight", 900)
    .attr("font-size", 12)
    .attr("fill", "rgba(232,238,255,.95)")
    .text(centerId.length > 18 ? centerId.slice(0, 18) + "…" : centerId);

  const n = neighbors.length;
  const pad = Math.min(0.06, ((Math.PI * 2) / n) * 0.18);
  const arc = d3.arc();

  const petals = g
    .selectAll("path")
    .data(neighbors)
    .enter()
    .append("path")
    .attr("d", (d, i) => {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      return arc({
        innerRadius: r0 + 6,
        outerRadius: rScale(d.w),
        startAngle: a0 + pad,
        endAngle: a1 - pad,
      });
    })
    .attr("fill", (d) => color(d.w))
    .attr("opacity", 0.95)
    .style("cursor", "pointer")
    .on("mouseenter", (event, d) => {
      activeChapter = null;
      applyGraphEmphasis(centerId);
      emphasizeSingleNeighbor(centerId, d.id);
    })
    .on("mouseleave", () => {
      applyGraphEmphasis(centerId);
    })
    .on("click", (event, d) => {
      activeChapter = null;
      selectNode(d.id);
      setPanel(activePanel);
    });

  petals.append("title").text((d) => `${centerId} ↔ ${d.id}: ${d.w}`);

  g.selectAll("text.__petal_label__")
  .data(neighbors)
  .enter()
  .append("text")
  .attr("class", "__petal_label__")
  .attr("font-size", 10)
  .attr("font-weight", 800)
  .attr("fill", "rgba(232,238,255,.92)")
  .attr("paint-order", "stroke")
  .attr("stroke", "rgba(0,0,0,.55)")
  .attr("stroke-width", 3)
  .attr("dominant-baseline", "middle")
  .attr("text-anchor", (d, i) => {
    const mid = ((i + 0.5) / n) * Math.PI * 2;
    // 上半/下半都无所谓，关键是左右半区：左边靠右对齐，右边靠左对齐
    const ang = mid - Math.PI / 2;
    const cos = Math.cos(ang);
    return cos < 0 ? "end" : "start";
  })
  .attr("transform", (d, i) => {
    const mid = ((i + 0.5) / n) * Math.PI * 2;
    const rr = rScale(d.w) + 10;
    const ang = mid - Math.PI / 2;
    const x = Math.cos(ang) * rr;
    const y = Math.sin(ang) * rr;
    return `translate(${x},${y})`; // 不再 rotate
  })
  .text((d) => (d.id.length > 14 ? d.id.slice(0, 14) + "…" : d.id));
}

// ---------------- 强高亮单个邻居边 ----------------
function emphasizeSingleNeighbor(centerId, neighborId) {
  if (!graphInnerSvg) return;

  const key = makeEdgeKey(centerId, neighborId);

  const allLines = Array.from(graphInnerSvg.querySelectorAll("line")).filter(
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

  const c = nodeById.get(neighborId);
  if (c) {
    c.setAttribute("stroke", "#ff5733");
    c.setAttribute("stroke-width", "3");
    c.setAttribute("opacity", "1");
  }
}

// ---------------- All Characters 列表（panel） ----------------
function wireCharacterList(data) {
  const listEl = document.getElementById("charList");
  const searchInput = document.getElementById("charSearch");
  const sortMode = document.getElementById("sortMode");
  if (!listEl) return;

  const nodesWithValue = (data.nodes || []).map((d, i) => ({
    ...d,
    id: d.id || `node-${i}`,
    value: Number(d.value ?? 0),
  }));

  function surnameKey(name) {
    const parts = String(name).trim().split(/\s+/);
    return (parts.length >= 2 ? parts[parts.length - 1] : parts[0]).toLowerCase();
  }

  function sortList(list) {
    const mode = sortMode ? sortMode.value : "freq";
    if (mode === "name") {
      return [...list].sort((a, b) => surnameKey(a.id).localeCompare(surnameKey(b.id)));
    }
    return [...list].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }

  function renderCharList(list) {
    const sorted = sortList(list);
    listEl.innerHTML = sorted
      .map((d) => `<li data-id="${escapeHtml(d.id)}">${escapeHtml(d.id)} (${d.value})</li>`)
      .join("");
  }

  function applyFilterAndRender() {
    const q = (searchInput?.value || "").trim().toLowerCase();
    const filtered = q ? nodesWithValue.filter((d) => d.id.toLowerCase().includes(q)) : nodesWithValue;
    renderCharList(filtered);
  }

  applyFilterAndRender();

  listEl.onclick = (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const name = li.getAttribute("data-id");
    if (!name) return;
    activeChapter = null;
    selectNode(name);
    setPanel(activePanel);
  };

  if (searchInput) searchInput.oninput = applyFilterAndRender;
  if (sortMode) sortMode.onchange = applyFilterAndRender;
}

// ---------------- Reset view ----------------
function resetGraphView() {
  if (!graphInnerSvg) return;

  const vb = graphInnerSvg.dataset.baseViewBox;
  if (vb) graphInnerSvg.setAttribute("viewBox", vb);

  selectedNodeId = null;
  selectedEdgeKey = null;
  activeChapter = null;

  graphNodes.forEach((n) => {
    const d = n.__data__;
    const baseR = 3 + Math.log2((d?.value ?? 0) + 1);
    n.setAttribute("opacity", "1");
    n.setAttribute("r", baseR);
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");

    const hue = (Math.log2((d?.value ?? 0) + 1) * 40) % 360;
    n.setAttribute("fill", `hsl(${hue}, 70%, 65%)`);
  });

  const allLines = Array.from(graphInnerSvg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );
  allLines.forEach((l) => {
    l.setAttribute("opacity", "1");
    l.setAttribute("stroke", "#999");
    l.setAttribute("stroke-opacity", "0.6");
    l.setAttribute("stroke-width", "1.5");
  });

  if (labelLayer) {
    while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
  }
  labelItems = [];
  if (rafLabelLoop != null) {
    cancelAnimationFrame(rafLabelLoop);
    rafLabelLoop = null;
  }

  if (edgeStatusEl) edgeStatusEl.textContent = "No edge selected";
  if (chapterCardEl) chapterCardEl.innerHTML = "";

  setPanel("timeline");
}
if (resetViewBtn) resetViewBtn.addEventListener("click", resetGraphView);

// ---------------- Save context ----------------
if (saveContextBtn && linkContextEditor) {
  saveContextBtn.addEventListener("click", () => {
    if (!selectedEdgeKey) {
      alert("Please click an edge first to select it.");
      return;
    }
    if (!currentGraphData) {
      alert("No graph data loaded.");
      return;
    }

    const rawText = linkContextEditor.value || "";
    const items = rawText
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (!currentGraphData.contexts) currentGraphData.contexts = {};
    currentGraphData.contexts[selectedEdgeKey] = items.map((text) => ({ text, chapters: [] }));

    const keepPanel = activePanel;
    const keepNode = selectedNodeId;
    const keepChapter = activeChapter;

    drawGraph(currentGraphData);

    if (edgeStatusEl) edgeStatusEl.textContent = `Saved contexts for ${selectedEdgeKey}`;
    setPanel("contexts");
    if (keepNode) selectNode(keepNode);

    activeChapter = keepChapter ?? null;
    if (activeChapter != null) {
      applyChapterEmphasis(activeChapter);
      renderChapterCard(activeChapter);
    }

    activePanel = keepPanel;
    setPanel("contexts");

    alert("Context saved successfully!");
  });
}

// ---------------- Context 管理（window API，保留） ----------------
window.deleteContext = function (a, b, i) {
  if (!currentGraphData) return;
  const key = makeEdgeKey(a, b);
  const arr = ensureArrayContexts(currentGraphData.contexts?.[key]);

  if (!arr[i]) return;
  arr.splice(i, 1);

  if (!currentGraphData.contexts) currentGraphData.contexts = {};
  if (arr.length === 0) {
    delete currentGraphData.contexts[key];

    const idx = (currentGraphData.links || []).findIndex(
      (l) => makeEdgeKey(normalizeId(l.source), normalizeId(l.target)) === key
    );
    if (idx > -1) currentGraphData.links.splice(idx, 1);
  } else {
    currentGraphData.contexts[key] = arr.map((x) => ({ text: x.text, chapters: x.chapters || [] }));
  }

  drawGraph(currentGraphData);
  setPanel("contexts");
};

window.addContextManually = function (a, b) {
  if (!currentGraphData) return;
  const txt = prompt(`Context for ${a}&${b}:`);
  if (!txt) return;

  const canonical = txt.trim();
  const key = makeEdgeKey(a, b);

  currentGraphData.contexts = currentGraphData.contexts || {};
  currentGraphData.contexts[key] = ensureArrayContexts(currentGraphData.contexts[key]);
  currentGraphData.contexts[key].push({ text: canonical, chapters: [] });

  if (!currentGraphData.nodes.find((n) => n.id === a)) currentGraphData.nodes.push({ id: a, value: 0 });
  if (!currentGraphData.nodes.find((n) => n.id === b)) currentGraphData.nodes.push({ id: b, value: 0 });

  const exists = currentGraphData.links.some(
    (l) => makeEdgeKey(normalizeId(l.source), normalizeId(l.target)) === key
  );
  if (!exists) currentGraphData.links.push({ source: a, target: b, value: 1 });

  drawGraph(currentGraphData);
  setPanel("contexts");
};

window.editContextWithData = function (a, b, idx) {
  if (!currentGraphData) return;
  const key = makeEdgeKey(a, b);
  const arr = ensureArrayContexts(currentGraphData.contexts?.[key]);
  if (!arr[idx]) return;

  const old = arr[idx].text || "";
  const txt = prompt(`Edit context for ${a}&${b}:`, old);
  if (txt == null) return;

  arr[idx] = { text: txt.trim(), chapters: [] };
  currentGraphData.contexts[key] = arr;

  drawGraph(currentGraphData);
  setPanel("contexts");
};
