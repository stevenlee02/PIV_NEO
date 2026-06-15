// Pure utility functions — reads S from state.js for highlightSelected.
import { S } from "./state.js";

export function normalizeId(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && x.id) return x.id;
  return String(x);
}

export function makeEdgeKey(a, b) {
  return [a, b].sort().join("|");
}

export function ensureArrayContexts(entryArr) {
  const arr = Array.isArray(entryArr) ? entryArr : [];
  return arr.map((e) => {
    if (typeof e === "string") return { text: e, chapters: [] };
    if (e && typeof e.text === "string")
      return { text: e.text, chapters: Array.isArray(e.chapters) ? e.chapters : [] };
    return { text: String(e ?? ""), chapters: [] };
  });
}

export function computeAdjacencyFromLinks(data) {
  const adj = new Map();
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

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function highlightByCanon(text, canon) {
  const raw = String(text ?? "");
  const safe = escapeHtml(raw);
  if (!canon || !S.currentGraphData?.variants) return safe;

  const variants = S.currentGraphData.variants?.[canon];
  if (!Array.isArray(variants) || variants.length === 0) return safe;

  const names = [...variants].filter(Boolean).sort((a, b) => String(b).length - String(a).length);
  if (!names.length) return safe;

  const pattern = names
    .map((n) => escapeRegex(String(n)).replace(/\\\s+/g, "\\s+"))
    .join("|");
  if (!pattern) return safe;

  const re = new RegExp(`\\b(?:${pattern})\\b`, "gi");
  return safe.replace(re, (m) => `<mark class="name-hl">${m}</mark>`);
}

export function highlightSelected(text) {
  if (!S.selectedNodeId) return escapeHtml(String(text ?? ""));
  return highlightByCanon(text, S.selectedNodeId);
}
