/**
 * Minimal OpenAI-compatible chat-completions client (REST, no SDK). Speaks to OpenRouter by default;
 * any server exposing `{base_url}/chat/completions` works by overriding `llm.base_url`.
 */
export interface OpenAIResult { text: string; structured?: any; usage?: { prompt: number; output: number; thoughts?: number }; error?: string }

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export async function openaiGenerate(opts: {
  baseUrl: string; apiKey: string; model: string; prompt: string; schema?: any; system?: string;
  timeoutMs?: number; /** strict json_schema; off by default — our schemas use $ref and optional fields */ strict?: boolean;
  signal?: AbortSignal;
}): Promise<OpenAIResult> {
  const messages: any[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  const body: any = { model: opts.model, messages, stream: false };
  if (opts.schema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: !!opts.strict, schema: opts.schema } };

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json", "x-title": "lenz" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const r = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { text: "", error: `llm ${r.status}: ${j.error?.message ?? j.error ?? r.statusText}` };
    const choice = j.choices?.[0];
    const text = choice?.message?.content ?? "";
    const u = j.usage;
    const out: OpenAIResult = { text, usage: u ? { prompt: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, thoughts: u.completion_tokens_details?.reasoning_tokens } : undefined };
    if (opts.schema && text) { try { out.structured = JSON.parse(text); } catch { /* caller falls back to extractJson */ } }
    if (!text && choice?.finish_reason && choice.finish_reason !== "stop") out.error = `llm finish: ${choice.finish_reason}`;
    if (!text && !out.error) out.error = "llm returned no content";
    return out;
  } catch (e: any) {
    return { text: "", error: ctrl.signal.aborted ? "llm: aborted" : `llm: ${e?.message ?? e}` };
  } finally { clearTimeout(t); opts.signal?.removeEventListener("abort", onAbort); }
}
