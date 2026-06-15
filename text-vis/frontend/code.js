// Entry point — DOM event binding and initialization.
console.log("[code.js] loading...");

import { S } from "./state.js";
import { setPanel, wireSaveContext } from "./panels.js";
import { drawGraph, resizeSVG } from "./graph.js";
import { postFileAnalyze, postTextAnalyze } from "./api.js";

console.log("[code.js] imports done, DOM init...");

// ---- DOM refs ----
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const articleInput = document.getElementById("articleInput");
const articleAnalyzeBtn = document.getElementById("articleAnalyzeBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const toggleBar = document.getElementById("panelToggles");

console.log("[code.js] uploadBtn:", !!uploadBtn, "statusEl:", !!statusEl);

// ---- resize ----
resizeSVG();
window.addEventListener("resize", resizeSVG);

// ---- panel toggles ----
if (toggleBar) {
  toggleBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-panel]");
    if (!btn) return;
    setPanel(btn.getAttribute("data-panel"));
  });
}

// init panel
setPanel(S.activePanel);

// ---- upload file ----
if (uploadBtn) {
  uploadBtn.addEventListener("click", async () => {
    console.log("[code.js] uploadBtn clicked");
    const file = fileInput?.files?.[0];
    if (!file) return alert("Please select a file first.");

    if (statusEl) statusEl.textContent = "Analyzing... (this may take a minute)";
    try {
      console.log("[code.js] calling postFileAnalyze...");
      const data = await postFileAnalyze(file);
      console.log("[code.js] got data:", Object.keys(data));
      if (statusEl) statusEl.textContent = "Done!";
      drawGraph(data);
      console.log("[code.js] drawGraph done");
    } catch (err) {
      console.error("[code.js] Backend error:", err);
      if (statusEl) statusEl.textContent = "Error occurred.";
    }
  });
} else {
  console.error("[code.js] uploadBtn NOT FOUND!");
}

// ---- analyze text ----
if (articleAnalyzeBtn && articleInput) {
  articleAnalyzeBtn.addEventListener("click", async () => {
    console.log("[code.js] articleAnalyzeBtn clicked");
    const text = articleInput.value.trim();
    if (!text) return alert("Please paste or write text to analyze.");

    if (statusEl) statusEl.textContent = "Analyzing... (this may take a minute)";
    try {
      const data = await postTextAnalyze(text);
      if (statusEl) statusEl.textContent = "Done!";
      drawGraph(data);
    } catch (err) {
      console.error("[code.js] Backend error:", err);
      if (statusEl) statusEl.textContent = "Error occurred.";
    }
  });
}

// ---- reset view ----
if (resetViewBtn) {
  import("./graph.js").then((m) => {
    resetViewBtn.addEventListener("click", m.resetGraphView);
  });
}

// ---- save context ----
wireSaveContext();

console.log("[code.js] ready");
