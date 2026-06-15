# piv_neo — Literary Character Network

**Full-stack literary text analysis tool.** Upload a novel or short story, and automatically extract characters, merge name variants with GPT, build a co-occurrence network, and explore relationships through interactive visualizations.

![](https://img.shields.io/badge/backend-FastAPI-009688) ![](https://img.shields.io/badge/NLP-spaCy_+_GPT--4o--mini-blue) ![](https://img.shields.io/badge/graph-NetworkX-orange) ![](https://img.shields.io/badge/frontend-Vite_+_D3.js-646cff) ![](https://img.shields.io/badge/refactored-modular_architecture-success)

---

## STAR

### Situation

Literary scholars and casual readers alike struggle to track character relationships across long texts. Existing tools require manual annotation. Meanwhile, the original codebase was a set of monolithic scripts (backend 735 lines, frontend 1,326 lines in single files) that mixed HTTP routes, NLP, GPT calls, D3 rendering, and inline HTML templates — impossible to debug or extend.

### Task

Build an end-to-end pipeline that:

1. Extracts person entities from raw `.txt` novels using spaCy NER
2. Normalizes name variants (e.g. "Darcy" + "Mr. Darcy" → "Mr. Darcy") via GPT-4o-mini
3. Constructs a character co-occurrence network with NetworkX
4. Computes per-chapter timelines and evidence sentences
5. Visualizes everything as an interactive D3 force graph with Timeline, Flower diagram, and searchable character list
6. Refactors both frontend and backend into clean, testable modules with zero circular dependencies

### Action

**Backend — 7-step modular refactoring (735 → 48 lines):**

| Step | Module | Responsibility |
|---|---|---|
| 1 | `config.py` | All constants (CORS, thresholds, blacklist, GPT params) |
| 2 | `text_utils.py` | Text cleaning + NLP helpers (`nlp` injected as parameter) |
| 3 | `normalizer.py` | Name cleaning + GPT prompt building + response parsing + variant mapping |
| 4 | `network.py` | `build_cooccurrence_network` — extracted nested function |
| 5 | `analysis.py` | Chapter splitting, timeline, mentions, sentence-chapter index |
| 6 | `orchestrator.py` | `process_text()` pipeline orchestrator |
| 7 | `app.py` | **48 lines** — FastAPI init + CORS + 3 routes only |

Dependency chain (one-way, no cycles):
```
app.py → orchestrator.py → { text_utils, normalizer, network, analysis } → config.py
```

**Frontend — 5-module split (1,326 → 92 lines):**

| Module | Lines | Responsibility |
|---|---|---|
| `state.js` | 14 | Mutable state object `S` — single source of truth |
| `utils.js` | 85 | `escapeHtml`, `highlightByCanon`, `computeAdjacencyFromLinks` |
| `api.js` | 24 | HTTP layer — single `BASE` URL, fixed port `8001→8000` |
| `graph.js` | 458 | D3 force graph, node/edge interaction, emphasis, reset |
| `panels.js` | 538 | Timeline (d3 line chart), Flower (d3 arc diagram), character list, context editor |
| `code.js` | **92** | DOM refs + 5 event listeners + init — zero business logic |

Dependency chain (one-way, circularity broken via lazy `import()`):
```
code.js ─┬─ graph.js ─── { utils.js, state.js, forceGraph.js }
         ├─ panels.js ── { utils.js, state.js } ──(lazy)→ graph.js
         └─ api.js
```

**Key design decisions:**
- **Dependency injection** — `nlp` (spaCy) and `client` (OpenAI) passed as parameters, enabling mock testing
- **ESM mutable state** — `export let` replaced with a single `S` object since ESM imports are read-only bindings
- **Lazy imports for cycle breaking** — `graph.js` ↔ `panels.js` decoupled by sharing `state.js` and using dynamic `import()` for cross-calls
- **CSS extraction** — 390 lines of inline `<style>` moved from `index.html` to `style.css` with organized sections

### Result

| Metric | Before | After |
|---|---|---|
| Backend entry | 735 lines in 1 file | 48 lines + 6 modules |
| Frontend entry | 1,326 lines in 1 file | 92 lines + 5 modules |
| Circular dependencies | N/A (single file) | 0 cycles (verified) |
| Debug granularity | Must run entire pipeline | Each module importable standalone |
| Startup | 2 manual terminals | `.\start.ps1` (one-click) |

Every module passes independent syntax check and runtime verification. The full pipeline — upload → NER → GPT → network → D3 visualization — works end-to-end in incognito browser.

---

## Quick Start

### Prerequisites

- Conda environment `piv_env` with Python 3.12+
- Node.js 18+
- OpenAI API key

### First-time setup

```powershell
# Backend
conda activate piv_env
cd text-vis/backend
pip install -r requirements.txt
python -m spacy download en_core_web_sm

# Frontend
cd text-vis/frontend
npm install

# API key — create text-vis/backend/.env:
# OPENAI_API_KEY=sk-xxx
```

### Run

```powershell
.\start.ps1
```

Opens two terminals: backend `:8000` + frontend `:3000`. Open `http://localhost:3000`, upload a `.txt` file, click Analyze.

---

## Architecture

```
Upload .txt
    │
    ▼
┌─────────────────────────────────────────┐
│  FastAPI (:8000)                         │
│  process_text()                          │
│  ├─ clean illustrations                  │
│  ├─ spaCy NER → extract persons          │
│  ├─ GPT-4o-mini → normalize names        │
│  ├─ split chapters                       │
│  ├─ NetworkX → co-occurrence graph        │
│  ├─ compute timeline + mentions          │
│  └─ return JSON                          │
└─────────────────────────────────────────┘
    │  {nodes, links, timeline, mentions, variants}
    ▼
┌─────────────────────────────────────────┐
│  Browser (:3000)                         │
│  code.js → api.js → fetch               │
│  graph.js → ForceGraph (D3)             │
│  panels.js → Timeline + Flower + List   │
│  state.js → S (shared mutable state)    │
└─────────────────────────────────────────┘
```

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/analyze` | Upload `.txt` file → full analysis JSON |
| `POST` | `/analyze-text` | Submit `{"text": "..."}` → full analysis JSON |
| `GET` | `/ping` | Health check + API key status |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend framework | FastAPI |
| NLP (NER + tokenization) | spaCy (`en_core_web_sm`) |
| Name normalization | OpenAI GPT-4o-mini |
| Graph analysis | NetworkX |
| Frontend bundler | Vite |
| Visualization | D3.js v7 (ESM, force graph + arc diagram + line chart) |
| Environment | Conda (`piv_env`) |

---

## Project Structure

```
piv_neo/
├── README.md
├── README_CN.md                # Chinese version (for self-reference)
├── start.ps1                   # One-click launcher
├── .gitignore
└── text-vis/
    ├── backend/
    │   ├── app.py              # Entry (48 lines, routes only)
    │   ├── orchestrator.py     # Pipeline orchestrator
    │   ├── config.py           # All constants
    │   ├── text_utils.py       # Text cleaning + NLP helpers
    │   ├── normalizer.py       # Name cleaning + GPT normalization
    │   ├── network.py          # Co-occurrence network builder
    │   ├── analysis.py         # Chapters, timeline, mentions
    │   └── requirements.txt
    └── frontend/
        ├── index.html          # HTML structure (98 lines)
        ├── style.css           # Dark theme
        ├── code.js             # Entry (92 lines, DOM events only)
        ├── state.js            # Shared mutable state (S)
        ├── utils.js            # Utility functions
        ├── api.js              # HTTP layer
        ├── graph.js            # D3 force graph + interaction
        ├── panels.js           # Timeline, Flower, List, Contexts
        ├── forceGraph.js       # D3 force layout wrapper
        ├── vite.config.js      # Vite config (port 3000)
        └── package.json
```
