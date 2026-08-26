export async function api<T = any>(path: string, body?: any, method = body !== undefined ? "POST" : "GET"): Promise<T> {
  const r = await fetch(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}
export const del = (path: string) => api(path, undefined, "DELETE");
