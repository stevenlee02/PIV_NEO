import { ForceGraph } from "./forceGraph.js";
import * as d3 from "https://cdn.skypack.dev/d3@7";

// ---------------- 全局状态 ----------------
let currentGraphData = null; // {nodes, links, contexts, timeline, ...}
let selectedEdgeKey = null; // "A|B"
let selectedNodeId = null; // "A"
let activePanel = "timeline"; // timeline | neighbors | contexts | allchars

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

// ---------------- setPanel（额外强制隐藏 contexts 的两块） ----------------
function setPanel(panelId) {
  activePanel = panelId;

  // toggle 按钮高亮
  toggleBar?.querySelectorAll("button[data-panel]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-panel") === panelId);
  });

  // panel 显示/隐藏（只管 .panel）
  rightScroll?.querySelectorAll(".panel").forEach((p) => {
    const id = p.getAttribute("data-panel");
    p.classList.toggle("hidden", id !== panelId);
  });

  // 强制：contexts 的两块在非 contexts 时一律隐藏（防止被错误留在别的面板里）
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

// ---------------- 核心：选中节点（更新 Timeline + Character + Flower + 图强调） ----------------
function selectNode(id) {
  if (!currentGraphData || !id) return;
  selectedNodeId = id;

  // 图强调（邻居大小/颜色 + 淡化无关 + labels）
  applyGraphEmphasis(id);

  // Character panel
  showCharacterDetails(id);

  // Timeline panel
  const counts = (currentGraphData.timeline && currentGraphData.timeline[id]) || [];
  const timelineData = counts.map((c, idx) => ({ chapter: idx + 1, count: c }));
  renderCharacterTimeline(timelineData);

  // Flower（在 Character panel 内）
  renderFlower(id, 16);
}

// ---------------- 渲染图 ----------------
function drawGraph(raw) {
  // 重绘时保持 panel + 选择
  const keepPanel = activePanel;
  const keepNode = selectedNodeId;
  const keepEdge = selectedEdgeKey;

  // 规范化数据
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
  };

  currentGraphData = data;

  // 清空外层 svg
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

  // 保存初始 viewBox（用于 reset）
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

  // label layer
  labelLayer = fg.querySelector("g.__labels__");
  if (!labelLayer) {
    labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    labelLayer.setAttribute("class", "__labels__");
    fg.appendChild(labelLayer);
  }

  // 点击节点 -> selectNode（不强制切 panel）
  graphNodes.forEach((n) => {
    n.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const d = n.__data__;
      if (!d?.id) return;
      selectNode(d.id);
      setPanel(activePanel);
    });
  });

  // 点击边 -> contexts
  wireEdgeClick(fg, data);

  // All Characters 列表 -> selectNode
  wireCharacterList(data);

  // 默认选择
  let pick = null;
  if (keepNode && nodeById.has(keepNode)) pick = keepNode;
  if (!pick && data.nodes.length) {
    pick = [...data.nodes].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.id;
  }
  if (pick) selectNode(pick);

  // 恢复 edge 状态文本
  if (keepEdge && edgeStatusEl) edgeStatusEl.textContent = `Editing: ${keepEdge}`;

  // 恢复 active panel
  setPanel(keepPanel);
}

function wireEdgeClick(fg, data) {
  const visibleLinks = Array.from(fg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );

  visibleLinks.forEach((line) => {
    const d = line.__data__;
    if (!d) return;

    // 创建 hit area
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hit.classList.add("__hit__");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", 15);
    hit.style.cursor = "pointer";
    line.parentNode.insertBefore(hit, line.nextSibling);

    // hit 跟随真实线位置
    const sync = () => {
      hit.setAttribute("x1", line.getAttribute("x1"));
      hit.setAttribute("y1", line.getAttribute("y1"));
      hit.setAttribute("x2", line.getAttribute("x2"));
      hit.setAttribute("y2", line.getAttribute("y2"));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(line, { attributes: true });

    hit.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const a = normalizeId(d.source);
      const b = normalizeId(d.target);
      const key = makeEdgeKey(a, b);
      selectedEdgeKey = key;

      // 高亮该边
      visibleLinks.forEach((l) => {
        l.setAttribute("stroke", "#999");
        l.setAttribute("stroke-opacity", "0.35");
        l.setAttribute("stroke-width", "1.5");
      });
      line.setAttribute("stroke", "#ff5733");
      line.setAttribute("stroke-opacity", "0.95");
      line.setAttribute("stroke-width", "3");

      // 切换到 contexts panel
      setPanel("contexts");

      // 载入 contexts
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

      // 编辑器 textarea
      if (linkContextEditor) {
        linkContextEditor.value = ctx.map((x) => (x.text || "").trim()).join("\n\n");
      }

      // snippets 列表
      if (infoEl) {
        const snippets = ctx
          .map((s, idx) => {
            const text = (s.text || "").trim();
            return `
            <div style="margin-bottom: 1rem;">
              <blockquote>${escapeHtml(text)}</blockquote>
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

  // node 样式
  graphNodes.forEach((n) => {
    const d = n.__data__;
    const id = d?.id;
    const baseR = 3 + Math.log2((d?.value ?? 0) + 1);

    // 默认淡化
    n.setAttribute("opacity", "0.15");
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");

    // 默认色
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

  // link 样式
  const allLines = Array.from(graphInnerSvg.querySelectorAll("line")).filter(
    (l) => l.getAttribute("stroke") !== "transparent"
  );
  allLines.forEach((line) => {
    const d = line.__data__;
    const a = normalizeId(d?.source);
    const b = normalizeId(d?.target);
    const w = Number(d?.value ?? 0);

    // 默认淡化
    line.setAttribute("opacity", "0.12");
    line.setAttribute("stroke", "#999");
    line.setAttribute("stroke-opacity", "0.35");
    line.setAttribute("stroke-width", "1.2");

    // 与中心相连的边
    if (a === centerId || b === centerId) {
      line.setAttribute("opacity", "1");
      line.setAttribute("stroke", color(w));
      line.setAttribute("stroke-opacity", "0.95");
      line.setAttribute("stroke-width", String(1.5 + Math.sqrt(w) * 1.0));
    }
  });

  // 邻居节点 label：显示共现数（前 20）
  renderNeighborLabels(centerId, neighbors.slice(0, 20));
}

function renderNeighborLabels(centerId, neighborArr) {
  if (!labelLayer) return;

  // 清空
  while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
  labelItems = [];

  // 中心 label
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

  const neighborMap = new Map(); // id -> {id, count, cooccurrence}

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

  // 确保 flower 容器存在
  const flowerHostId = "__flower_host__";
  let flowerHost = detailsEl.querySelector(`#${flowerHostId}`);
  if (!flowerHost) {
    flowerHost = document.createElement("div");
    flowerHost.id = flowerHostId;
  }

  let html = `
    <h3 style="text-align:left;margin:0 0 6px;">🧍 ${escapeHtml(centerId)}</h3>
    <p style="margin:0 0 10px;color:rgba(232,238,255,.85);">Appears <b>${centerCount}</b> times in text.</p>
    <div id="${flowerHostId}" style="margin:8px 0 12px;"></div>
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

  // 点击邻居行 -> selectNode
  detailsEl.querySelectorAll(".__neighbor_row__").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-id");
      if (!id) return;
      selectNode(id);
      setPanel(activePanel);
    });
  });

  // flower 渲染
  renderFlower(centerId, 16);
}

// ---------------- Timeline ----------------
function renderCharacterTimeline(timelineData) {
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
    .attr("fill", "rgba(255,204,0,.95)");

  dots.append("title").text((d) => `Chapter ${d.chapter}: ${d.count} time(s)`);
}

// ---------------- Flower（D3 径向花瓣） ----------------
function renderFlower(centerId, topK = 16) {
  const host = detailsEl?.querySelector("#__flower_host__");
  if (!host || !currentGraphData || !centerId) return;

  host.innerHTML = "";

  const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEl.id = "flower-svg";
  svgEl.setAttribute("height", "240");
  svgEl.style.width = "100%";
  host.appendChild(svgEl);

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

  // 中心圆
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

  // 花瓣
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
      applyGraphEmphasis(centerId);
      emphasizeSingleNeighbor(centerId, d.id);
    })
    .on("mouseleave", () => {
      applyGraphEmphasis(centerId);
    })
    .on("click", (event, d) => {
      selectNode(d.id);
      setPanel(activePanel);
    });

  petals.append("title").text((d) => `${centerId} ↔ ${d.id}: ${d.w}`);

  // 花瓣标签
  g.selectAll("text.__petal_label__")
    .data(neighbors)
    .enter()
    .append("text")
    .attr("class", "__petal_label__")
    .attr("font-size", 10)
    .attr("font-weight", 800)
    .attr("fill", "rgba(232,238,255,.92)")
    .attr("text-anchor", "middle")
    .attr("transform", (d, i) => {
      const mid = ((i + 0.5) / n) * Math.PI * 2;
      const rr = rScale(d.w) + 10;
      const x = Math.cos(mid - Math.PI / 2) * rr;
      const y = Math.sin(mid - Math.PI / 2) * rr;
      const rot = (mid * 180) / Math.PI - 90;
      return `translate(${x},${y}) rotate(${rot})`;
    })
    .text((d) => (d.id.length > 12 ? d.id.slice(0, 12) + "…" : d.id));
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
    selectNode(name);
    setPanel(activePanel);
  };

  if (searchInput) searchInput.oninput = applyFilterAndRender;
  if (sortMode) sortMode.onchange = applyFilterAndRender;
}

// ---------------- Reset view ----------------
function resetGraphView() {
  if (!graphInnerSvg) return;

  // 恢复 base viewBox
  const vb = graphInnerSvg.dataset.baseViewBox;
  if (vb) graphInnerSvg.setAttribute("viewBox", vb);

  selectedNodeId = null;
  selectedEdgeKey = null;

  // 清理边高亮 + 节点淡化
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

  // 清空 labels
  if (labelLayer) {
    while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
  }
  labelItems = [];
  if (rafLabelLoop != null) {
    cancelAnimationFrame(rafLabelLoop);
    rafLabelLoop = null;
  }

  // 重置 contexts 状态
  if (edgeStatusEl) edgeStatusEl.textContent = "No edge selected";

  // 默认 panel
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

    // 保存后保持状态
    const keepPanel = activePanel;
    const keepNode = selectedNodeId;

    drawGraph(currentGraphData);

    if (edgeStatusEl) edgeStatusEl.textContent = `Saved contexts for ${selectedEdgeKey}`;
    setPanel("contexts");
    if (keepNode) selectNode(keepNode);

    // 保持用户 panel（这里强制回 contexts）
    activePanel = keepPanel;
    setPanel("contexts");

    alert("Context saved successfully!");
  });
}

// ---------------- Context 管理（window API） ----------------
window.deleteContext = function (a, b, i) {
  if (!currentGraphData) return;
  const key = makeEdgeKey(a, b);
  const arr = ensureArrayContexts(currentGraphData.contexts?.[key]);

  if (!arr[i]) return;
  arr.splice(i, 1);

  if (!currentGraphData.contexts) currentGraphData.contexts = {};
  if (arr.length === 0) {
    delete currentGraphData.contexts[key];

    // 同步删除 link（可选）
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

  // 确保节点存在
  if (!currentGraphData.nodes.find((n) => n.id === a)) currentGraphData.nodes.push({ id: a, value: 0 });
  if (!currentGraphData.nodes.find((n) => n.id === b)) currentGraphData.nodes.push({ id: b, value: 0 });

  // 确保边存在
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
