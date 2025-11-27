import { ForceGraph } from "./forceGraph.js";
import * as d3 from "https://cdn.skypack.dev/d3@7";


// === 角色时间线：全局章节数据 ===
let globalChapters = [];

// 智能章节拆分：优先按 "Chapter 1 / CHAPTER I" 等拆；
// 如果识别不到章节，就按段落均匀切成 ~50 段。
function splitIntoChapters(text) {
  if (!text) return [];

  // 统一换行符
  const normalized = text.replace(/\r\n/g, "\n");

  // 几种常见章节格式的正则（前瞻，不丢掉章节标题）
  const chapterPatterns = [
    /(?=^Chapter\s+\d+)/gim,             // Chapter 1
    /(?=^CHAPTER\s+\d+)/gm,              // CHAPTER 1
    /(?=^CHAPTER\s+[IVXLCDM]+\.?)/gm,    // CHAPTER I, CHAPTER II ...
  ];

  for (const pattern of chapterPatterns) {
    const parts = normalized.split(pattern)
      .map(t => t.trim())
      .filter(t => t.length > 0);

    // 认为章节数至少得有 5 个才算真的章节结构
    if (parts.length >= 5) {
      console.log("Use chapter pattern split, chapters:", parts.length);
      return parts;
    }
  }

  // 如果上面的几种格式都没识别出来，就按“段落”切
  let paragraphs = normalized
    .split(/\n\s*\n+/)            // 空行分段
    .map(t => t.trim())
    .filter(t => t.length > 0);

  // 段落数本来就不多（<= 50），那就直接当“章节”用
  if (paragraphs.length <= 50) {
    console.log("Use paragraphs as chapters:", paragraphs.length);
    return paragraphs;
  }

  // 段落太多了：把它们均匀合并成 ~50 段
  const targetParts = 50;
  const size = Math.ceil(paragraphs.length / targetParts);
  const merged = [];
  for (let i = 0; i < paragraphs.length; i += size) {
    merged.push(paragraphs.slice(i, i + size).join("\n\n"));
  }
  console.log("Use merged paragraphs as chapters:", merged.length);
  return merged;
}


const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const svg = document.getElementById("graph");
const detailsEl = document.getElementById("details");
const sortSelect = document.getElementById("sortMode");
const resetViewBtn = document.getElementById("resetViewBtn");

// ====== 图的全局引用：用于搜索时高亮 & 居中 ======
let graphInnerSvg = null;         // ForceGraph 返回的那个 <svg>
let graphNodes = [];              // 所有 <circle> 节点 DOM
let nodeById = new Map();         // id -> circle
let graphWidth = 0;
let graphHeight = 0;


function resizeSVG() {
  const width = window.innerWidth - 100;
  const height = window.innerHeight - 200;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
}
resizeSVG();
window.addEventListener("resize", resizeSVG);

uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) return alert("Please select a file first.");

  statusEl.textContent = "Analyzing... (this may take a minute)";

  // ✅ 在前端读取原始文本，拆成章节，给 timeline 用
  const rawText = await file.text();
  globalChapters = splitIntoChapters(rawText);
  console.log("Chapters from file:", globalChapters.length);

  const formData = new FormData();
  formData.append("file", file);

  //csy此处为8000，lzc改为8001才能运行
  try {
    const res = await fetch("http://127.0.0.1:8001/analyze", {
      method: "POST",
      body: formData
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    statusEl.textContent = "Done!";
    drawGraph(data);
  } catch (err) {
    console.error("❌ Backend error:", err);
    statusEl.textContent = "Error occurred.";
  }
});


function drawGraph(data) {
  // 清空 SVG
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const width = svg.clientWidth;
  const height = svg.clientHeight;


   // 节点半径、力参数都做轻微调整，避免重叠太严重
  const fg = ForceGraph(
    { 
      nodes: data.nodes.map((d, i) => ({ 
        ...d, 
        id: d.id || `node-${i}`, 
        value: d.value ?? 0,   // ⬅ 防止没 value 的时候出问题 
      })), 
      links: data.links 
    },
    {
      nodeId: d => d.id,
      nodeTitle: d => `${d.id}\nCount: ${d.value}`,
      nodeRadius: d => 3 + Math.log2((d.value ?? 0) + 1), // 🔹 节点更小
      linkStrokeWidth: d => 0.6 + Math.sqrt(d.value) * 0.5, // 🔹 线更细
      nodeStrength: -300,   // 🔹 增加斥力
      linkStrength: 0.05,   // 🔹 减弱连线拉力
      width,
      height,
    }
  );

  // 保存图的全局引用，用于搜索高亮 & 视图定位
  graphInnerSvg = fg;
  graphWidth = width;
  graphHeight = height;
  graphNodes = Array.from(fg.querySelectorAll("circle"));
  nodeById = new Map();
  graphNodes.forEach((n) => {
    const d = n.__data__;
    if (d && d.id) {
      nodeById.set(d.id, n);
    }
  });

  // 点击节点显示人物详情 + 更新时间线
  graphNodes.forEach(n => {
    n.addEventListener("click", () => {
      const d = n.__data__;
      console.log("clicked node:", d);

      detailsEl.innerHTML = `
        <h3>🧍 ${d.id}</h3>
        <p>Appears <b>${d.value}</b> times in text.</p>
        <p>Click a connection line to see shared scenes.</p>
      `;

      // 计算并渲染该角色的时间线
      const timelineData = buildCharacterTimeline(d.id, globalChapters);
      renderCharacterTimeline(timelineData);

      // 也顺便在图里高亮一下（点击节点时也居中）
      focusCharacterOnGraph(d.id);
    });
  });

 // 点击连线显示上下文片段（与后端 sorted key 对齐）
const visibleLinks = fg.querySelectorAll("line");

visibleLinks.forEach(line => {
  const d = line.__data__;

  // 1. 为每条线创建一个“透明粗线”作为点击区域（hitbox）
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");

  // 把原线的坐标复制给 hit 线（初始值）
  hit.setAttribute("x1", line.getAttribute("x1"));
  hit.setAttribute("y1", line.getAttribute("y1"));
  hit.setAttribute("x2", line.getAttribute("x2"));
  hit.setAttribute("y2", line.getAttribute("y2"));

  // 粗线 + 透明 + 鼠标样式
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", 15);     // 点击区域宽 15 像素
  hit.style.cursor = "pointer";

  // 把 hit 线插到原线的后面（同一个 <g> 里）
  line.parentNode.insertBefore(hit, line.nextSibling);

  // 2. 点击 hit 线时，展示上下文
 hit.addEventListener("click", () => {
  const key = [d.source.id, d.target.id].sort().join("|");
  const ctx = data.contexts[key];

  // ① 先把所有可见线复原成“默认样式”
  visibleLinks.forEach(l => {
    l.setAttribute("stroke", "#999");          // 默认灰
    l.setAttribute("stroke-opacity", "0.4");
    l.setAttribute("stroke-width", "1.5");     // 和 ForceGraph 里差不多
  });

  // ② 再把当前这条线高亮
  line.setAttribute("stroke", "#f00");      // 高亮红
  line.setAttribute("stroke-opacity", "0.95");
  line.setAttribute("stroke-width", "3");      // 比其它线粗一点

  // ③ Console 打印，方便调试
  console.log("clicked link:", key, "contexts:", ctx ? ctx.length : 0);
  if (ctx && ctx.length) {
    console.log("sample context:", ctx[0]);
  }

  // ④ 更新右侧文本
  if (!ctx || ctx.length === 0) {
    infoEl.innerHTML = `<p><b>${d.source.id}</b> & <b>${d.target.id}</b>: No context found.</p>`;
  } else {
    const snippets = ctx
      .slice(0, 3)
      .map(s => `<blockquote>${s.trim()}...</blockquote>`)
      .join("");
    infoEl.innerHTML = `<h3>📖 ${d.source.id} & ${d.target.id}</h3>${snippets}`;
  }
});

  // 3. 让 hit 线跟着原线移动
  const observer = new MutationObserver(() => {
    hit.setAttribute("x1", line.getAttribute("x1"));
    hit.setAttribute("y1", line.getAttribute("y1"));
    hit.setAttribute("x2", line.getAttribute("x2"));
    hit.setAttribute("y2", line.getAttribute("y2"));
  });
  observer.observe(line, { attributes: true });
});

  svg.appendChild(fg);

    // ===== 人物列表 + 搜索 + 排序 =====
  const listEl = document.getElementById("charList");
  const searchInput = document.getElementById("charSearch");

  if (listEl) {
    // 统一整理数据
    const nodesWithValue = data.nodes.map((d, i) => ({
      ...d,
      id: d.id || `node-${i}`,
      value: d.value ?? 0,
    }));

    // 当前排序方式：freq / name
    let currentSortMode = (sortSelect && sortSelect.value) || "freq";

    // 按当前排序方式对列表排序
    function sortCharacters(list) {
      const arr = [...list]; // 拷贝一份，不改原数组
      if (currentSortMode === "name") {
        // 按姓名首字母
        arr.sort((a, b) => a.id.localeCompare(b.id));
      } else {
        // 按出现次数
        arr.sort((a, b) => b.value - a.value);
      }
      return arr;
    }

    // 渲染列表（带 data-id，方便点击高亮）
    function renderCharList(list) {
      const sortedList = sortCharacters(list);
      listEl.innerHTML = sortedList
        .map(d => `<li data-id="${d.id}">${d.id} (${d.value})</li>`)
        .join("");
    }

    // 初始渲染全部人物
    renderCharList(nodesWithValue);

    // 点击列表中的人物，在图中高亮并居中
    listEl.onclick = (e) => {
    const li = e.target.closest("li");
    if (!li) return;

    const name = li.getAttribute("data-id");
    if (!name) return;

    // 找到图中对应节点
    const node = nodeById.get(name);
    if (!node) return;

    const d = node.__data__;

    //
    // 1️⃣ 更新 Character Details
    //
    detailsEl.innerHTML = `
      <h3>🧍 ${d.id}</h3>
      <p>Appears <b>${d.value}</b> times in text.</p>
      <p>Click a connection line to see shared scenes.</p>
    `;

    //
    // 2️⃣ 更新时间线
    //
    const timelineData = buildCharacterTimeline(d.id, globalChapters);
    renderCharacterTimeline(timelineData);

    //
    // 3️⃣ 在图中高亮并居中
    //
    focusCharacterOnGraph(name);
  };


        // 搜索：过滤 + 自动高亮第一个匹配
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = q
          ? nodesWithValue.filter(d => d.id.toLowerCase().includes(q))
          : nodesWithValue;
        renderCharList(filtered);

        // 清空搜索时恢复视图
        if (!q) {
          resetGraphView();
          return;
        }

        // 有搜索词且有匹配时，高亮第一个匹配的角色
        if (filtered.length > 0) {
          focusCharacterOnGraph(filtered[0].id);
        }
      };
    }


    // 排序方式切换
    if (sortSelect) {
      sortSelect.onchange = () => {
        currentSortMode = sortSelect.value;

        const q = searchInput ? searchInput.value.trim().toLowerCase() : "";
        const filtered = q
          ? nodesWithValue.filter(d => {
            const name = d.id.toLowerCase();
            const parts = name.split(/\s+/);      // 拆成 ["charlotte", "lucas"]
            return name.includes(q)               // 全名包含
              || parts.some(p => p.includes(q)); // 任意单词包含
          })
  : nodesWithValue;


        renderCharList(filtered);
      };
    }
  }
}

// === 构建某个角色在各章节的出现次数 ===
function buildCharacterTimeline(characterName, chapters) {
  if (!characterName || !chapters || chapters.length === 0) return [];

  // 转义正则特殊字符
  const escaped = characterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "gi");

  return chapters.map((chapterText, i) => {
    const matches = chapterText.match(pattern);
    return {
      chapter: i + 1,
      count: matches ? matches.length : 0,
    };
  });
}

// === 用 d3 把 timelineData 画成折线图 ===
// timelineData: [{ chapter: 1, count: 3 }, ...]
function renderCharacterTimeline(timelineData) {
  const svgEl = document.getElementById("timeline-svg");
  if (!svgEl) return;

  const svg = d3.select(svgEl);

  // 清空旧图
  svg.selectAll("*").remove();

  const width = svgEl.clientWidth || 400;
  const height = svgEl.clientHeight || 180;

  // 设置 viewBox，自适应
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // 没数据 或 所有章节出现次数都为 0
  if (!timelineData || timelineData.length === 0 ||
      d3.max(timelineData, d => d.count) === 0) {
    svg.append("text")
      .attr("x", 10)
      .attr("y", 20)
      .attr("font-size", 12)
      .text("No timeline data.");
    return;
  }

  const margin = { top: 20, right: 20, bottom: 30, left: 45 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const maxChapter = d3.max(timelineData, d => d.chapter);
  const maxCount = d3.max(timelineData, d => d.count);

  // X 轴：章节
  const x = d3.scaleLinear()
    .domain([1, maxChapter])
    .range([0, innerWidth]);

  // Y 轴：出现次数
  const y = d3.scaleLinear()
    .domain([0, maxCount])
    .nice()
    .range([innerHeight, 0]);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // X 轴（最多 20 个刻度，避免全挤在一起）
  const tickCount = Math.min(20, maxChapter);
  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(
      d3.axisBottom(x)
        .ticks(tickCount)
        .tickFormat(d3.format("d"))
    );

  // Y 轴
  g.append("g")
    .call(d3.axisLeft(y).ticks(4));

  // Y 轴标签
  g.append("text")
    .attr("x", 0)
    .attr("y", -8)
    .attr("font-size", 11)
    .text("Occurrences per chapter");

  // X 轴标签
  g.append("text")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 25)
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .text("Chapters");

  // 折线生成器
  const line = d3.line()
    .x(d => x(d.chapter))
    .y(d => y(d.count));

  // 画折线
  g.append("path")
    .datum(timelineData)
    .attr("fill", "none")
    .attr("stroke", "steelblue")
    .attr("stroke-width", 2)
    .attr("d", line);

  // 圆点 + 原生 tooltip
  const dots = g.selectAll("circle")
    .data(timelineData)
    .enter()
    .append("circle")
    .attr("cx", d => x(d.chapter))
    .attr("cy", d => y(d.count))
    .attr("r", 3)
    .attr("fill", "steelblue");

  // 浏览器自带 tooltip：悬停显示“第 N 章：出现 X 次”
  dots.append("title")
    .text(d => `Chapter ${d.chapter}: ${d.count} time(s)`);
}



// ===== 搜索人物时：高亮图中节点并放大居中 =====
function focusCharacterOnGraph(name) {
  if (!name || !graphInnerSvg || !graphNodes.length) return;

  const targetNode = nodeById.get(name);
  if (!targetNode) {
    console.warn("No node found for name:", name);
    return;
  }

  // 1. 先恢复所有节点为默认样式
  graphNodes.forEach((n) => {
    const d = n.__data__;
    const baseR = 3 + Math.log2(((d?.value) ?? 0) + 1);
    n.setAttribute("r", baseR);
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");
    n.setAttribute("fill", "black");
  });

  // 2. 高亮目标节点：放大 + 改颜色
  const d = targetNode.__data__;
  const baseR = 3 + Math.log2(((d?.value) ?? 0) + 1);
  targetNode.setAttribute("r", baseR * 1.25);          // 放大一倍
  targetNode.setAttribute("stroke", "#f00");
  targetNode.setAttribute("stroke-width", "3");
  targetNode.setAttribute("fill", "#ffcc00");

  // 3. 通过修改 viewBox 来实现“放大居中”
  // ForceGraph 的初始 viewBox 是 [-width/2, -height/2, width, height]
  const zoom = 1.25; // 越大越“放大”
  const vbWidth = graphWidth / zoom;
  const vbHeight = graphHeight / zoom;

  const centerX = d.x - vbWidth / 2;
  const centerY = d.y - vbHeight / 2;

  graphInnerSvg.setAttribute("viewBox", `${centerX} ${centerY} ${vbWidth} ${vbHeight}`);
}

// ===== 重置整张图的视图和节点样式 =====
function resetGraphView() {
  if (!graphInnerSvg) return;

  // 视图恢复：完整 viewBox
  graphInnerSvg.setAttribute(
    "viewBox",
    `${-graphWidth / 2} ${-graphHeight / 2} ${graphWidth} ${graphHeight}`
  );

  // 节点样式恢复默认
  graphNodes.forEach((n) => {
    const d = n.__data__;
    const baseR = 3 + Math.log2(((d?.value) ?? 0) + 1);
    n.setAttribute("r", baseR);
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");
    n.setAttribute("fill", "black");
  });
  // 线条样式恢复默认
  if (graphInnerSvg) {
    const visibleLinks = graphInnerSvg.querySelectorAll("line");  
    visibleLinks.forEach(l => {
      l.setAttribute("stroke", "#999");
      l.setAttribute("stroke-opacity", "0.4");
      l.setAttribute("stroke-width", "1.5");
    });
  }
}

if (resetViewBtn) {
  resetViewBtn.addEventListener("click", resetGraphView);
}
