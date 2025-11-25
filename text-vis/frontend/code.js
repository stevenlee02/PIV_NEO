import { ForceGraph } from "./forceGraph.js";

const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const svg = document.getElementById("graph");
const detailsEl = document.getElementById("details");

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
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("http://127.0.0.1:8000/analyze", {
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
      nodes: data.nodes.map((d, i) => ({ ...d, id: d.id || `node-${i}`, value: d.value ?? 0,   // ⬅ 防止没 value 的时候出问题 
      })), 
      links: data.links 
    },
    {
      nodeId: d => d.id,
      nodeTitle: d => `${d.id}\nCount: ${d.value}`,
      nodeRadius: d => 3 + Math.log2((d.value ?? 0) + 1), // 🔹 节点更小
      linkStrokeWidth: d => 0.3 + Math.sqrt(d.value) * 0.3, // 🔹 线更细
      nodeStrength: -300,   // 🔹 增加斥力
      linkStrength: 0.05,   // 🔹 减弱连线拉力
      width,
      height,
    }
  );

  // 点击节点显示人物详情
  const nodes = fg.querySelectorAll("circle");
  nodes.forEach(n => {
    n.addEventListener("click", () => {
      const d = n.__data__;
      console.log("clicked node:", d);  // ⬅ 这里应该能看到 { id, value, ... }
      detailsEl.innerHTML = `
        <h3>🧍 ${d.id}</h3>
        <p>Appears <b>${d.value}</b> times in text.</p>
        <p>Click a connection line to see shared scenes.</p>
      `;
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
    l.setAttribute("stroke-opacity", "0.6");
    l.setAttribute("stroke-width", "1.5");     // 和 ForceGraph 里差不多
  });

  // ② 再把当前这条线高亮
  line.setAttribute("stroke", "#ff5733");      // 高亮橙红
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

    // 按出现次数从大到小排序
    const sorted = nodesWithValue.sort((a, b) => b.value - a.value);

    // 把完整列表挂到全局，方便调试/复用（可选）
    window.allCharacters = sorted;

    // 渲染列表的函数
    function renderCharList(list) {
      listEl.innerHTML = list
        .map(d => `<li>${d.id} (${d.value})</li>`)
        .join("");
    }

    // 先渲染完整列表
    renderCharList(sorted);

    // 搜索功能：输入时按名字过滤
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = q
          ? sorted.filter(d => d.id.toLowerCase().includes(q))
          : sorted;
        renderCharList(filtered);
      };
    }
  }
}
