# 文学角色关系网络 — 个人开发笔记

> 本文档供自己参考，记录项目架构、重构过程、通信机制。对外展示请阅读 [README.md](README.md)。

文学文本角色关系可视化工具。上传小说/短篇故事 `.txt` 文件，自动提取角色、合并同一人物的不同称呼、构建共现网络、生成逐章时间线，在浏览器中交互式探索人物关系。

---

## 项目结构

```
piv_neo/
├── README.md
├── start.ps1                    # 一键启动脚本（前后端）
├── text-vis/
│   ├── backend/                 # FastAPI 后端
│   │   ├── app.py               # 入口（48行，仅路由）
│   │   ├── orchestrator.py      # 分析管线编排
│   │   ├── config.py            # 所有常量配置
│   │   ├── text_utils.py        # 文本清洗 + NLP 分词断句
│   │   ├── normalizer.py        # 名字清洗 + GPT 归一化 + 变体映射
│   │   ├── network.py           # 共现网络构建（原嵌套函数）
│   │   ├── analysis.py          # 章节拆分 / 时间线 / 证据句 / 章节索引
│   │   └── requirements.txt
│   └── frontend/                # Vite + D3.js 前端
│       ├── index.html           # 页面结构（98行，纯 HTML）
│       ├── style.css            # 深色主题（从 index.html 提取）
│       ├── code.js              # 入口（92行，仅 DOM 事件绑定）
│       ├── state.js             # 全局可变状态对象 S
│       ├── utils.js             # 工具函数（转义、高亮、邻接表等）
│       ├── api.js               # HTTP 请求层（统一指向 :8000）
│       ├── graph.js             # 图渲染 & 节点/边交互（drawGraph 等）
│       ├── panels.js            # 右侧面板（Timeline / Flower / 列表 / Contexts）
│       ├── forceGraph.js        # D3 力导向图封装（独立 ESM）
```

---

## 功能

### 分析管线（后端）

```
上传 .txt → 清洗插图标记 → 按句拆分 → spaCy NER 提取人名
    → GPT-4o-mini 合并同一角色的不同称呼（如 "Darcy" + "Mr. Darcy" → "Mr. Darcy"）
    → 建立 variant→canonical 映射 + 增强（部分匹配回填）
    → 章节拆分（自动识别 CHAPTER N 或按段落）
    → 构建共现网络（节点=角色，边=共同出现在的句子数）
    → 逐章时间线 + 证据句 + 变体表
    → 返回 JSON
```

### 交互界面（前端）

| 面板 | 功能 |
|---|---|
| **Character** | 点击角色节点 → 显示出现次数、邻居表格、Flower 图（花瓣=关联角色，大小=关系强度） |
| **Timeline** | 选中角色的逐章出现频率折线图，点击数据点高亮该章节并显示证据句卡片 |
| **Contexts** | 点击边（连线）→ 显示两角色共现的所有句子原文，带 Chapter 跳转按钮 |
| **All Characters** | 全部角色列表，支持搜索和按频率/姓氏排序，点击跳转 |

### 额外交互

- **节点高亮**：选中角色后，邻居节点按关系强度染色放大，无关节点淡化
- **悬停邻居**：Flower 花瓣悬停 → 图中该边高亮
- **名称高亮**：所有句子中的角色名自动高亮（基于后端返回的 variants 表）
- **Reset View**：一键恢复默认视图
- **Enter Text**：可直接粘贴文本分析，无需上传文件
- **问号帮助**：Timeline 和 Flower 图右上角 `?` 按钮

---

## 快速启动

### 首次使用 — 安装依赖

```powershell
# 后端
conda activate piv_env
cd text-vis/backend
pip install -r requirements.txt
python -m spacy download en_core_web_sm

# 前端
cd text-vis/frontend
npm install
```

### 日常启动 — 一键

```powershell
.\start.ps1
```

自动弹出两个窗口：后端 `:8000` + 前端 `:3000`。浏览器打开 `http://localhost:3000`。

> 需要 `OPENAI_API_KEY`：在 `text-vis/backend/` 下创建 `.env`，写入 `OPENAI_API_KEY=sk-xxx`。

### 手动启动（分步调试）

```powershell
# 终端 1
conda activate piv_env
cd text-vis/backend
uvicorn app:app --reload --port 8000

# 终端 2
cd text-vis/frontend
npm run dev
```

验证后端：`curl http://localhost:8000/ping` → `{"message":"pong","key_loaded":true}`

---

## 接口文档

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/analyze` | 上传 `.txt` 文件，返回 nodes / links / timeline / mentions / variants |
| `POST` | `/analyze-text` | 提交 `{"text": "..."}`，同上 |
| `GET` | `/ping` | 健康检查 + API key 状态 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端框架 | FastAPI |
| NER + 断句 | spaCy (`en_core_web_sm`) |
| 图分析 | NetworkX |
| 名字归一化 | OpenAI GPT-4o-mini |
| 前端 | Vite + D3.js (ESM) |
| 环境 | Conda (`piv_env`) |

---

## 架构详解

### 前后端通信

```
浏览器 (localhost:3000)                       FastAPI (localhost:8000)
═══════════════════════                       ═══════════════════════

code.js
├─ 用户点 Analyze
└─→ api.postFileAnalyze(file) ──── POST /analyze ────→ app.py
                                    (multipart)         └─ process_text()
                                                       
graph.drawGraph(data)  ←────── JSON ────────────  {nodes, links, timeline,
│   {nodes, links,                                 chapters_meta, mentions,
│    contexts, timeline,                            variants}
│    chapters_meta,
│    mentions, variants}
│
├─ ForceGraph(nodes, links)  → D3 力导向图
├─ wireEdgeClick()           → 边点击 → Contexts 面板
├─ selectNode(first)         → 默认选中
└─ S.currentGraphData = data → 写入全局状态

panels.js  所有面板从 S.currentGraphData 读取
├─ showCharacterDetails()    → 邻居表格 + Flower 花瓣图
├─ renderCharacterTimeline() → d3 折线图
├─ wireCharacterList()       → 可搜索排序的角色列表
└─ renderChapterCard()       → 章节证据句卡片
```

**数据流向：** `api.js` 发请求 → `graph.js` 收 JSON 写入 `S.currentGraphData` → `panels.js` 各面板读取渲染。`S`（`state.js` 导出的可变对象）是前端数据中枢，graph 往里写，panels 从里读，无需 prop drilling。

### code.js（92 行入口）里面有什么

```
import  4 个模块（state, panels, graph, api）
抓取   8 个 DOM 元素（uploadBtn, fileInput, statusEl...）
绑定   5 个事件监听器
       ├─ uploadBtn.click     → api.postFileAnalyze → graph.drawGraph
       ├─ articleAnalyzeBtn   → api.postTextAnalyze  → graph.drawGraph
       ├─ toggleBar.click     → panels.setPanel
       ├─ resetViewBtn.click  → graph.resetGraphView
       └─ saveContextBtn      → panels.wireSaveContext
初始化 resizeSVG() + setPanel("timeline")
```

零业务逻辑，所有工作委托给模块。

### graph.js（458 行）— 图渲染 & 交互

| 函数 | 行 | 职责 |
|---|---|---|
| `resizeSVG` | 8 | 自适应窗口尺寸 |
| `selectNode` | 23 | 节点选中协调器：调 panels 的详情/时间线/Flower |
| `drawGraph` | 106 | **核心**：构建 D3 力导向图、绑定节点/边事件、恢复面板状态 |
| `wireEdgeClick` | 108 | 边点击 → 渲染 Contexts 面板（含大量 HTML 模板） |
| `applyGraphEmphasis` | 69 | 节点强调：淡化无关节点、邻居按关系强度染色放大 |
| `renderNeighborLabels` | 37 | SVG label 生成 + RAF 动画循环 |
| `emphasizeSingleNeighbor` | 26 | Flower 悬停时单边/单节点高亮 |
| `resetGraphView` | 37 | 恢复默认视图（清选中、复位 opacity/颜色） |

**长的主要原因：** d3 的 imperative API 需要逐节点/边设属性（~100 行），`wireEdgeClick` 含大量内联 HTML 模板字符串（~100 行），不是逻辑耦合。

### panels.js（538 行）— 右侧面板 + Contexts

| 函数 | 行 | 职责 |
|---|---|---|
| `attachChartHelp` | 33 | Timeline/Flower 右上角 `?` 按钮 + 弹出说明 |
| `setPanel` | 25 | 面板切换（Character / Timeline / Contexts / All Characters） |
| `renderChapterCard` | 25 | Timeline 点击章节后显示的卡片（标题 + snippet + 证据句） |
| `applyChapterEmphasis` | 43 | Timeline 章节高亮：按章节数据改节点/边 opacity 和大小 |
| `showCharacterDetails` | 72 | 角色详情：名字、出现次数、邻居表格 HTML |
| `renderCharacterTimeline` | 60 | d3 折线图：坐标轴 + 折线 + 可点击数据点 |
| `renderFlower` | 111 | **最复杂可视化**：d3 arc 花瓣图（几何计算 + 标签定位） |
| `wireCharacterList` | 49 | All Characters 面板：搜索框 + 频率/姓氏排序 |
| `wireSaveContext` | 24 | Save 按钮：将编辑内容写入 `S.currentGraphData.contexts` |
| `window.openChapter*` | 13 | Chapter chip 点击 → 跳到 timeline 对应章节 |
| `window.delete/add/editContext*` | 52 | Context 增删改（通过 `window.*` 暴露给内联 onclick） |

**长的主要原因：** `renderFlower` 的几何计算（~80 行 d3 arc）、`showCharacterDetails` 的 HTML 模板（~50 行）、Timeline d3 图表（~60 行）。

### CSS 整理

| 文件 | 重构前 | 重构后 |
|---|---|---|
| `index.html` | 492 行（含 ~390 行内嵌 `<style>`） | **98 行**（纯 HTML） |
| `style.css` | 433 行（废弃的浅色主题，未被引用） | **450 行**（深色主题，按 Layout / Typography / Buttons / Graph / Panels / Chart Help 分段，补了缺失的 `.name-hl`） |

---

# 重构记录（2026-06-15）

## 问题

- **后端** `app.py` 735 行单体：HTTP 路由、NER、GPT 调用、共现网络（嵌套函数）、时间线、证据句、章节拆分、硬编码常量全部耦合在一起
- **前端** `code.js` 1326 行单体：DOM 事件、API 请求、D3 图渲染、面板渲染、Flower 图、角色列表、Context 编辑全部在一个文件

两个文件都无法独立调试单个功能，改一处需要理解全部代码。

## 目标

```
前后端各拆成 6-7 个模块，每个 ≤200 行，职责单一，零循环依赖，可分别调试。
```

---

## 后端：735 行 → 48 行入口 + 6 模块

| 步骤 | 模块 | 包含函数 |
|---|---|---|
| 1 | `config.py` | CORS origins、spaCy 模型名、黑名单、GPT 参数、网络阈值 — 全部常量 |
| 2 | `text_utils.py` | `clean_illustrations`, `split_text_by_sentence`, `extract_persons`（`nlp` 参数注入） |
| 3 | `normalizer.py` | `clean_name`, `enhance_mapping`, `fill_identity_mappings`, `build_variants_map`, `call_gpt_for_mapping`, `apply_gpt_mapping` |
| 4 | `network.py` | `build_cooccurrence_network` — 原嵌套在 `process_text()` 内部 120 行的函数 |
| 5 | `analysis.py` | `split_into_chapters`, `compute_timeline`, `build_chapters_meta`, `build_mentions`, `build_sentence_chapter_index` |
| 6 | `orchestrator.py` | `process_text(text, nlp, client)` — 串联整条管线 |
| 7 | `app.py` | **48 行** — FastAPI 初始化 + CORS + 3 个路由，业务代码零残留 |

**依赖关系（单向无循环）：**
```
app.py → orchestrator.py → { text_utils, normalizer, network, analysis } → config.py
```

**关键举措：**
1. **嵌套函数提升** — `build_cooccurrence_network` 从 `process_text` 内部提升为 `network.py` 模块级
2. **依赖注入** — `nlp` 和 `client` 通过参数传入，方便 mock 测试
3. **配置外提** — 所有魔法数字迁入 `config.py`
4. **GPT 逻辑独立** — prompt 构建、响应解析、fallback 全部在 `normalizer.py`

---

## 前端：1326 行 → 77 行入口 + 5 模块

| 模块 | 行数 | 职责 |
|---|---|---|
| `state.js` | 14 | 全局可变状态对象 `S`，所有模块共享 |
| `utils.js` | 85 | `normalizeId`, `makeEdgeKey`, `escapeHtml`, `highlightByCanon` (名字高亮), `computeAdjacencyFromLinks` |
| `api.js` | 24 | `postFileAnalyze`, `postTextAnalyze` — 统一指向 `:8000` |
| `graph.js` | ~330 | `drawGraph`, `selectNode`, `applyGraphEmphasis`, `emphasizeSingleNeighbor`, `resetGraphView`, `resizeSVG` |
| `panels.js` | ~500 | `setPanel`, `showCharacterDetails`, `renderCharacterTimeline`, `renderFlower`, `renderChapterCard`, `applyChapterEmphasis`, `wireCharacterList`, `wireSaveContext`, `attachChartHelp`, + 4 个 `window.*` context 管理函数 |
| `code.js` | **77** | 入口 — DOM 引用 + 事件绑定 + 初始化，0 行业务逻辑 |

**依赖关系（单向无循环）：**
```
code.js ─┬─ graph.js ─── { utils.js, state.js, forceGraph.js }
         ├─ panels.js ── { utils.js, state.js } ──(lazy)→ graph.js
         └─ api.js
```

**关键举措：**
1. **ESM 只读绑定修复** — `export let` → 可变对象 `S`，其他模块可自由读写
2. **循环依赖打破** — `graph.js` ↔ `panels.js` 通过 lazy `import()` 和共同依赖 `state.js` 解耦
3. **`selectNode` 协调** — 从 `code.js` 移至 `graph.js`，统一管理节点选中逻辑
4. **端口修正** — API 从 `:8001` → `:8000`
5. **Vite 配置** — 新增 `vite.config.js` 固定端口 3000

---

## 顺便修复

| 问题 | 修复 |
|---|---|
| 前端 API 端口写死 `8001` | `api.js` 统一改为 `8000` |
| `Piv/package.json` 重复 key | 清理去重 |
| Vite 默认端口不稳定 | 新增 `vite.config.js` 固定 `:3000` |
| `start.ps1` 无依赖检测 | 首次运行自动 `npm install` / `pip install` |
| 终端中文乱码 | 所有输出改为英文 |

---

## 验证

### 后端

```bash
conda activate piv_env
cd text-vis/backend
python -c "from text_utils import *; print('OK')"
python -c "from normalizer import *; print('OK')"
python -c "from network import *; print('OK')"
python -c "from analysis import *; print('OK')"
python -c "from orchestrator import process_text; print('OK')"
python -c "from app import app; print([r.path for r in app.routes])"
# ['/openapi.json', '/docs', '/docs/oauth2-redirect', '/redoc', '/analyze', '/analyze-text', '/ping']
```

### 前端

```bash
cd text-vis/frontend
node --check state.js && node --check utils.js && node --check api.js
node --check graph.js && node --check panels.js && node --check code.js
# All OK
```

浏览器无痕模式 `http://localhost:3000` → 上传 `.txt` → 网络图 + Timeline + Flower 全部正常。
