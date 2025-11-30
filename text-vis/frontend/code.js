import { ForceGraph } from "./forceGraph.js";
import * as d3 from "https://cdn.skypack.dev/d3@7"; // 🔹 新增：用于画 timeline 折线图

// ---------------- 全局状态 ----------------
let currentGraphData = null; // 用于保存当前图形数据
let selectedEdgeKey = null;  // 当前选中的边
let graphInnerSvg = null;    // 添加这个全局引用
let graphNodes = [];         // 添加节点引用
let nodeById = new Map();    // 添加节点映射
let graphWidth = 0;
let graphHeight = 0;

// ---------------- DOM refs ----------------
const uploadBtn = document.getElementById("uploadBtn"); // 在不影响这些代码的基础上把 timeline 和 neighbor 搬到这个版本上
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const svg = document.getElementById("graph");
const detailsEl = document.getElementById("details");
const resetViewBtn = document.getElementById("resetViewBtn"); // 添加reset按钮引用

// ---------------- 新增：文本编辑器相关元素 ----------------
const linkContextEditor = document.getElementById("linkContextEditor");
const saveContextBtn = document.getElementById("saveContextBtn");
const edgeStatusEl = document.getElementById("edge-status");

// ---------------- 新增：文本输入分析相关元素 ----------------
const articleInput = document.getElementById("articleInput");
const articleAnalyzeBtn = document.getElementById("articleAnalyzeBtn");

function resizeSVG() {
  graphWidth = window.innerWidth - 100;
  graphHeight = window.innerHeight - 200;
  svg.setAttribute("width", graphWidth);
  svg.setAttribute("height", graphHeight);
}
resizeSVG();
window.addEventListener("resize", resizeSVG);

// ---------------- 文件上传分析 ----------------
uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) return alert("Please select a file first.");

  statusEl.textContent = "Analyzing... (this may take a minute)";
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("http://127.0.0.1:8001/analyze", {//lzc此处只能用8001
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

// ---------------- 新增：文本输入分析 ----------------
if (articleAnalyzeBtn && articleInput) {
  articleAnalyzeBtn.addEventListener("click", async () => {
    const text = articleInput.value.trim();
    if (!text) return alert("Please paste or write text to analyze.");

    statusEl.textContent = "Analyzing... (this may take a minute)";
    
    try {
      const res = await fetch("http://127.0.0.1:8001/analyze-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
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
}

function drawGraph(data) {
  // 保存数据到全局状态
  currentGraphData = data;
  
  // 清空 SVG
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const width = svg.clientWidth;
  const height = svg.clientHeight;

  // 节点半径、力参数
  const fg = ForceGraph(
    { 
      nodes: data.nodes.map((d, i) => ({
        ...d,
        id: d.id || `node-${i}`,
        value: d.value ?? 0,
      })), 
      links: data.links 
    },
    {
      nodeId: d => d.id,
      nodeTitle: d => `${d.id}\nCount: ${d.value}`,
      nodeRadius: d => 3 + Math.log2((d.value ?? 0) + 1),
      linkStrokeWidth: d => 0.3 + Math.sqrt(d.value) * 0.3,
      nodeStrength: -300,
      linkStrength: 0.05,
      width,
      height,
    }
  );

  // 保存图的全局引用
  graphInnerSvg = fg;
  graphWidth = width;
  graphHeight = height;
  
  // 收集所有节点
  graphNodes = Array.from(fg.querySelectorAll("circle"));
  nodeById.clear();
  graphNodes.forEach(n => {
    const d = n.__data__;
    if (d && d.id) {
      nodeById.set(d.id, n);
    }
  });

  // 点击节点显示人物详情（带邻居）并高亮 + 更新时间线
  graphNodes.forEach(n => {
    n.addEventListener("click", () => {
      const d = n.__data__;
      console.log("clicked node:", d);

      // 🔹 使用“邻居表”版本的详情面板
      showCharacterDetails(d.id, data);

      // 🔹 用后端返回的 timeline 更新折线图（如果有）
      const counts = (data.timeline && data.timeline[d.id]) || [];
      const timelineData = counts.map((c, idx) => ({
        chapter: idx + 1,
        count: c,
      }));
      // 渲染时间线
      renderCharacterTimeline(timelineData);

      // 高亮节点 & 相连边 & 居中视图
      highlightNodeAndConnections(d.id);
    });
  });


  // 点击连线显示上下文片段
  const visibleLinks = fg.querySelectorAll("line");

  visibleLinks.forEach(line => {
    const d = line.__data__;

    // 1. 为每条线创建一个"透明粗线"作为点击区域
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hit.setAttribute("x1", line.getAttribute("x1"));
    hit.setAttribute("y1", line.getAttribute("y1"));
    hit.setAttribute("x2", line.getAttribute("x2"));
    hit.setAttribute("y2", line.getAttribute("y2"));
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", 15);
    hit.style.cursor = "pointer";

    line.parentNode.insertBefore(hit, line.nextSibling);

    //点击画面空白处取消所有选中状态
    svg.addEventListener("click", (e) => {
      if (e.target === svg) {
        selectedEdgeKey = null;
        // 重置所有连线样式
        visibleLinks.forEach(l => {
          l.setAttribute("stroke", "#999");
          l.setAttribute("stroke-opacity", "0.6");
          l.setAttribute("stroke-width", "1.5");
        });
        //重置所有节点样式
        graphNodes.forEach(n => {
          const nd = n.__data__;
          const baseR = 3 + Math.log2(((nd?.value) ?? 0) + 1);
          n.setAttribute("r", baseR);
          n.setAttribute("stroke", "#fff");
          n.setAttribute("stroke-width", "1.5");
          n.setAttribute("fill", "black");
        });
      }
    });

    //悬停在线上时改变线的颜色
    hit.addEventListener("mouseover", () => {
      line.setAttribute("stroke", "#fa0");
      line.setAttribute("stroke-opacity", "0.8");
      line.setAttribute("stroke-width", "3");
    });
    hit.addEventListener("mouseout", () => {
      // 如果当前不是选中状态，恢复原样
      const key = [d.source.id, d.target.id].sort().join("|");
      if (selectedEdgeKey !== key) {
        line.setAttribute("stroke", "#999");
        line.setAttribute("stroke-opacity", "0.6");
        line.setAttribute("stroke-width", "1.5");
      }
    });
    
    //点击节点时调用highlightNodeAndConnections函数
    hit.addEventListener("click", (e) => {
      e.stopPropagation(); // 阻止事件冒泡，避免触发 SVG 的点击事件
      highlightNodeAndConnections(d.source.id);
    });

    // 点击 hit 线时，展示上下文
    hit.addEventListener("click", () => {
      const key = [d.source.id, d.target.id].sort().join("|");
      const ctx = data.contexts[key];

      selectedEdgeKey = key;

      // 高亮当前连线
      visibleLinks.forEach(l => {
        l.setAttribute("stroke", "#999");
        l.setAttribute("stroke-opacity", "0.6");
        l.setAttribute("stroke-width", "1.5");
      });
      line.setAttribute("stroke", "#ff5733");
      line.setAttribute("stroke-opacity", "0.95");
      line.setAttribute("stroke-width", "3");

      // 更新右侧文本编辑器和信息面板
      if (!ctx || ctx.length === 0) {
        if (linkContextEditor) linkContextEditor.value = "";
        if (edgeStatusEl) edgeStatusEl.textContent = `Selected: ${key}`;
        infoEl.innerHTML = `
          <p><b>${d.source.id}</b> & <b>${d.target.id}</b>: No context found.</p>
          <button onclick="addContextManually('${d.source.id}', '${d.target.id}')">Add Context Manually</button>
        `;
      } else {
        const textJoined = ctx.map(text => typeof text === 'string' ? text : text.text || '').join("\n\n");
        if (linkContextEditor) linkContextEditor.value = textJoined;
        if (edgeStatusEl) edgeStatusEl.textContent = `Editing: ${key}`;
        
        const snippets = ctx
          .map((s, idx) => {
            const text = typeof s === 'string' ? s : s.text || '';
            return `
              <div style="margin-bottom: 1rem;">
                <blockquote>${text.trim()}</blockquote>
                <div style="margin-top: 0.5rem;">
                  <button onclick="editContextWithData('${d.source.id}', '${d.target.id}', ${idx})">Edit</button>
                  <button onclick="deleteContext('${d.source.id}', '${d.target.id}', ${idx})" style="margin-left: 0.5rem;">Delete</button>
                </div>
              </div>
            `;
          })
          .join("");
        
        infoEl.innerHTML = `
          <h3>📖 ${d.source.id} & ${d.target.id}</h3>
          ${snippets}
          <button onclick="addContextManually('${d.source.id}', '${d.target.id}')" style="margin-top: 1rem;">Add More Context</button>
        `;
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

  // 监听鼠标滚轮实现缩放
  let scale = 1;
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = -event.deltaY * 0.001;
    scale += delta;
    scale = Math.min(Math.max(0.1, scale), 5);
    graphInnerSvg.setAttribute("transform", `scale(${scale})`);
  });
  // 监听鼠标拖拽实现平移
  let isDragging = false;
  let startX, startY;
  let translateX = 0, translateY = 0;
  svg.addEventListener("mousedown", (event) => {
    isDragging = true;
    startX = event.clientX - translateX;
    startY = event.clientY - translateY;
  });
  svg.addEventListener("mousemove", (event) => {
    if (isDragging) {
      translateX = event.clientX - startX;
      translateY = event.clientY - startY;
      graphInnerSvg.setAttribute("transform", `translate(${translateX},${translateY}) scale(${scale})`);
    }
  });
  svg.addEventListener("mouseup", () => {
    isDragging = false;
  });
  svg.addEventListener("mouseleave", () => {
    isDragging = false;
  }); 

  svg.appendChild(fg);

  // ===== 人物列表 + 搜索 =====
  const listEl = document.getElementById("charList");
  const searchInput = document.getElementById("charSearch");

  if (listEl) {
    // 统一整理数据
    const nodesWithValue = data.nodes.map((d, i) => ({
      ...d,
      id: d.id || `node-${i}`,
      value: d.value ?? 0,
    }));

    // 渲染列表的函数 - 添加 data-id 属性
    function renderCharList(list) {
      listEl.innerHTML = list
        .map(d => `<li data-id="${d.id}">${d.id} (${d.value})</li>`)
        .join("");
    }

    // 先渲染完整列表
    renderCharList(nodesWithValue);

    // 点击列表中的人物，高亮图中节点 + 邻居 + timeline
    listEl.onclick = (e) => {
      const li = e.target.closest("li");
      if (!li) return;

      const name = li.getAttribute("data-id");
      if (!name) return;

      // 高亮节点和连接
      highlightNodeAndConnections(name);
      
      // 使用邻居表版本的详情
      showCharacterDetails(name, data);

      // 更新时间线
      const counts = (data.timeline && data.timeline[name]) || [];
      const timelineData = counts.map((c, idx) => ({
        chapter: idx + 1,
        count: c,
      }));
      renderCharacterTimeline(timelineData);
    };

    // 搜索功能：输入时按名字过滤
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = q
          ? nodesWithValue.filter(d => d.id.toLowerCase().includes(q))
          : nodesWithValue;
        renderCharList(filtered);
      };
    }
  }

  // ==== 邻居表版本的 Character Details ====
  function showCharacterDetails(centerId, dataForChar) {
    if (!centerId || !dataForChar) return;

    // 1. 找到中心角色本身
    const centerNode = dataForChar.nodes.find(n => n.id === centerId);
    const centerCount = centerNode ? (centerNode.value ?? 0) : 0;

    // 2. 从所有边中找出与它相连的邻居
    //    注意：source/target 可能是字符串，也可能已经被 d3/force 改成对象
    const neighborMap = new Map(); // id -> { id, count, cooccurrence }

    dataForChar.links.forEach(l => {
      const srcId = typeof l.source === "string" ? l.source : l.source.id;
      const tgtId = typeof l.target === "string" ? l.target : l.target.id;
      const val = l.value ?? 0;

      if (srcId === centerId || tgtId === centerId) {
        const otherId = srcId === centerId ? tgtId : srcId;

        // 邻居自身出现次数
        const neighborNode = dataForChar.nodes.find(n => n.id === otherId);
        const neighborCount = neighborNode ? (neighborNode.value ?? 0) : 0;

        if (!neighborMap.has(otherId)) {
          neighborMap.set(otherId, {
            id: otherId,
            count: neighborCount,
            cooccurrence: 0,
          });
        }
        const entry = neighborMap.get(otherId);
        entry.cooccurrence += val;   // 多条边时累加共现次数
      }
    });

    // 3. 排序：按与中心角色的共现次数从大到小
    const neighbors = Array.from(neighborMap.values())
      .sort((a, b) => b.cooccurrence - a.cooccurrence);

    // 4. 生成 HTML
    let html = `
      <h3>🧍 ${centerId}</h3>
      <p>Appears <b>${centerCount}</b> times in text.</p>
    `;

    if (neighbors.length === 0) {
      html += `<p>No neighbor characters.</p>`;
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
                  <th>Co-occurrences<br>with ${centerId}</th>
                </tr>
              </thead>
              <tbody>
                ${
                  neighbors.map(n => `
                    <tr>
                      <td>${n.id}</td>
                      <td>${n.count}</td>
                      <td>${n.cooccurrence}</td>
                    </tr>
                  `).join("")
                }
              </tbody>
            </table>
          </div>
        </details>
      `;
    }

    detailsEl.innerHTML = html;
  }
}

// ---------------- 用 d3 渲染人物 timeline 折线图 ----------------
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

// ---------------- 高亮节点和连接的函数 ----------------
function highlightNodeAndConnections(nodeName) {
  if (!nodeById.has(nodeName) || !graphInnerSvg) return;

  // 重置所有节点样式
  graphNodes.forEach(n => {
    const d = n.__data__;
    const baseR = 3 + Math.log2(((d?.value) ?? 0) + 1);
    n.setAttribute("r", baseR);
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");
    n.setAttribute("fill", "black");
  });

  // 重置所有连线样式
  const allLinks = graphInnerSvg.querySelectorAll("line");
  allLinks.forEach(l => {
    l.setAttribute("stroke", "#999");
    l.setAttribute("stroke-opacity", "0.6");
    l.setAttribute("stroke-width", "1.5");
  });

  // 高亮选中节点，直到点击其他地方重置
  const selectedNode = nodeById.get(nodeName);
  selectedNode.setAttribute("fill", "red");
  selectedNode.setAttribute("stroke", "black");
  selectedNode.setAttribute("stroke-width", "2");

  // 高亮与该节点相连的边和邻居节点，直到点击其他地方重置
  allLinks.forEach(l => {
    const d = l.__data__;
    const srcId = typeof d.source === "string" ? d.source : d.source.id;
    const tgtId = typeof d.target === "string" ? d.target : d.target.id;
    if (srcId === nodeName || tgtId === nodeName) {
      // 高亮边
      l.setAttribute("stroke", "red");
      l.setAttribute("stroke-opacity", "0.9");
      l.setAttribute("stroke-width", "3");
      // 高亮邻居节点
      const neighborId = srcId === nodeName ? tgtId : srcId;
      const neighborNode = nodeById.get(neighborId);
      if (neighborNode) {
        neighborNode.setAttribute("fill", "orange");
        neighborNode.setAttribute("stroke", "black");
        neighborNode.setAttribute("stroke-width", "2");
      }
    }
  });
}

// ---------------- 重置视图函数 ----------------
function resetGraphView() {
  if (!graphInnerSvg) return;
  
  // 重置视图框
  graphInnerSvg.setAttribute("viewBox", `${-graphWidth/2} ${-graphHeight/2} ${graphWidth} ${graphHeight}`);
  
  // 重置所有节点样式
  graphNodes.forEach(n => {
    const d = n.__data__;
    const baseR = 3 + Math.log2(((d?.value) ?? 0) + 1);
    n.setAttribute("r", baseR);
    n.setAttribute("stroke", "#fff");
    n.setAttribute("stroke-width", "1.5");
    n.setAttribute("fill", "black");
  });

  // 重置所有连线样式
  const allLinks = graphInnerSvg.querySelectorAll("line");
  allLinks.forEach(l => {
    l.setAttribute("stroke", "#999");
    l.setAttribute("stroke-opacity", "0.6");
    l.setAttribute("stroke-width", "1.5");
  });
}

// ---------------- 绑定reset按钮 ----------------
if (resetViewBtn) {
  resetViewBtn.addEventListener("click", resetGraphView);
}

// ---------------- 保存上下文功能 ----------------
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
    const items = rawText.split(/\n{2,}/).map(s => s.trim()).filter(s => s.length > 0);
    
    if (!currentGraphData.contexts) currentGraphData.contexts = {};
    currentGraphData.contexts[selectedEdgeKey] = items.map(text => ({ text, chapters: [] }));
    
    drawGraph(currentGraphData);
    
    if (edgeStatusEl) edgeStatusEl.textContent = `Saved contexts for ${selectedEdgeKey}`;
    alert("Context saved successfully!");
  });
}

// ---------------- 上下文管理函数 ----------------
function makeEdgeKey(a, b) {
  return [a, b].sort().join("|");
}

function normalizeContextEntry(entry) {
  if (!entry) return { text: "", chapters: [] };
  if (typeof entry === "string") return { text: entry, chapters: [] };
  return {
    text: typeof entry.text === "string" ? entry.text : entry.toString(),
    chapters: Array.isArray(entry.chapters) ? entry.chapters : []
  };
}

window.deleteContext = function(a, b, i) {
  const key = makeEdgeKey(a, b);
  const old = normalizeContextEntry(currentGraphData.contexts[key][i]);
  currentGraphData.contexts[key].splice(i, 1);
  
  // 如果删除后这个边没有context了，就删除这条边
  if (currentGraphData.contexts[key].length === 0) {
    delete currentGraphData.contexts[key];
    
    // 找到对应的link并删除
    const linkIndex = currentGraphData.links.findIndex(link => {
      const src = typeof link.source === 'object' ? link.source.id : link.source;
      const tgt = typeof link.target === 'object' ? link.target.id : link.target;
      return makeEdgeKey(src, tgt) === key;
    });
    
    if (linkIndex > -1) {
      currentGraphData.links.splice(linkIndex, 1);
    }
    
    // 检查并删除孤立的节点（更保守的判断）
    [a, b].forEach(character => {
      // 检查节点是否还有其他连接
      const hasOtherLinks = currentGraphData.links.some(link => {
        const src = typeof link.source === 'object' ? link.source.id : link.source;
        const tgt = typeof link.target === 'object' ? link.target.id : link.target;
        return src === character || tgt === character;
      });
      
      // 找到节点数据
      const node = currentGraphData.nodes.find(n => n.id === character);
      
      // 只有当节点满足以下所有条件时才删除：
      // 1. 没有其他连接
      // 2. 这个节点很可能是通过手动添加上下文创建的
      //    - 没有明确的value值（undefined）
      //    - 或者value为0（可能是手动添加的）
      // 我们保守一点，尽量不删除节点
      if (!hasOtherLinks && node && (node.value === undefined || node.value === 0)) {
        const nodeIndex = currentGraphData.nodes.findIndex(n => n.id === character);
        if (nodeIndex > -1) {
          currentGraphData.nodes.splice(nodeIndex, 1);
          console.log(`Deleted isolated node: ${character}`);
        }
      } else if (!hasOtherLinks && node) {
        console.log(`Keeping node ${character} because it has value: ${node.value}`);
      }
    });
  }
  
  drawGraph(currentGraphData);
};

window.addContextManually = function(a, b) {
  const txt = prompt(`Context for ${a}&${b}:`);
  if (!txt) return;
  const canonical = txt.trim();
  const key = makeEdgeKey(a, b);
  currentGraphData.contexts[key] = currentGraphData.contexts[key] || [];
  currentGraphData.contexts[key].push({text: canonical, chapters: []});
  currentGraphData.nodes.find(n => n.id === a) || currentGraphData.nodes.push({id: a, value: 0});
  currentGraphData.nodes.find(n => n.id === b) || currentGraphData.nodes.push({id: b, value: 0});
  currentGraphData.links.find(l => makeEdgeKey(
    typeof l.source === "object" ? l.source.id : l.source,
    typeof l.target === "object" ? l.target.id : l.target
  ) === key) || currentGraphData.links.push({source: a, target: b, value: 1});
  drawGraph(currentGraphData);
};
