/** Minimal Gemini generateContent client (REST, no SDK). Used for the non-agentic LLM calls. */
export interface GeminiResult { text: string; structured?: any; usage?: { prompt: number; output: number; thoughts?: number }; error?: string }

export async function geminiGenerate(opts: { apiKey: string; model: string; prompt: string; schema?: any; system?: string; timeoutMs?: number }): Promise<GeminiResult> {
  const body: any = { contents: [{ role: "user", parts: [{ text: opts.prompt }] }], generationConfig: {} };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.schema) { body.generationConfig.responseMimeType = "application/json"; body.generationConfig.responseJsonSchema = opts.schema; }
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { text: "", error: `gemini ${r.status}: ${j.error?.message ?? r.statusText}` };
    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    const u = j.usageMetadata;
    const out: GeminiResult = { text, usage: u ? { prompt: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thoughts: u.thoughtsTokenCount } : undefined };
    if (opts.schema) { try { out.structured = JSON.parse(text); } catch { out.error = "gemini returned non-JSON despite schema"; } }
    if (!text && cand?.finishReason && cand.finishReason !== "STOP") out.error = `gemini finish: ${cand.finishReason}`;
    return out;
  } catch (e: any) { return { text: "", error: `gemini: ${e?.message ?? e}` }; }
  finally { clearTimeout(t); }
}

/** Load KEY=VALUE files into process.env without overriding existing values. */
export function loadEnvFiles(paths: string[]) {
  const fs = require("node:fs");
  for (const p of paths) {
    let txt: string; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m || line.trim().startsWith("#")) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
