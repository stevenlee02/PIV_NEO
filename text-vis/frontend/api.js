// HTTP layer — communicates with the FastAPI backend.
const BASE = "http://127.0.0.1:8000";

export async function postFileAnalyze(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE}/analyze`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

export async function postTextAnalyze(text) {
  const res = await fetch(`${BASE}/analyze-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}
