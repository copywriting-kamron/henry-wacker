// Obi-Server für Vercel: nimmt Unterlagen und Gesprächsverlauf von der Seite entgegen,
// fragt Claude (mit Websuche für Marktdaten) und streamt die Antwort als NDJSON zurück.
// Ereignisse: {t:"text",d} {t:"search",q} {t:"sources",list} {t:"done",truncated} {t:"error",code}
import Anthropic from "@anthropic-ai/sdk";
import { RULES } from "../lib/rules.js";

const MODEL = process.env.OBI_MODEL || "claude-opus-5-5";
const MAX_DOCS = 12;
const MAX_IMAGES = 8;
const MAX_TURNS = 40;
const MAX_TURN_CHARS = 60_000;
const MAX_PAUSES = 3;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Ohne Websuche (falls sie für das Konto nicht freigeschaltet ist) schätzt Obi die Marktwerte, wie in der Vorschau.
const NO_SEARCH_NOTE = `

# Hinweis
In dieser Sitzung kannst du NICHT im Internet suchen. Für Marktwerte, die der Nutzer nicht vorgibt, gilt Ablauf Punkt 3: grobe Schätzung aus deinem Wissen, deutlich als Schätzung gekennzeichnet. Im Abschluss nimmst du den Satz für "ohne Websuche".`;

// Von voll ausgestattet zu minimal: Lehnt die API eine Funktion ab (z. B. Websuche nicht freigeschaltet),
// versucht der Server die nächste Stufe, solange noch nichts an die Seite gestreamt wurde.
const ATTEMPTS = [{ fallback: true, search: true }, { fallback: false, search: true }, { fallback: false, search: false }];

let client;

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// Erste Nutzernachricht wie in der Vorschau: Unterlagen, Bilder, Zusatzinfos, dann der Prüfauftrag.
// PDFs gehen als Dokument an Claude (Text und Seitenbilder), der ausgelesene Text nur, wenn kein PDF dabei ist.
function firstMessage(body) {
  const content = [];
  let text = "# Unterlagen des Nutzers\n\n";
  for (const d of (Array.isArray(body.docs) ? body.docs : []).slice(0, MAX_DOCS)) {
    const name = str(d?.name, 200) || "Datei";
    const pdf = str(d?.pdf, 4_000_000);
    if (pdf) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf }, title: name });
      text += `## Datei: ${name}\n(als PDF beigefügt)\n\n`;
    } else {
      text += `## Datei: ${name}\n${str(d?.text, 400_000) || "(nur als Bild beigefügt)"}\n\n`;
    }
  }
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .filter((img) => IMAGE_TYPES.has(img?.type) && typeof img?.data === "string");
  for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.type, data: img.data } });
  if (images.length) text += `(${images.length} Seite(n) bzw. Foto(s) sind als Bild beigefügt.)\n\n`;
  const extra = str(body.extra, 20_000);
  if (extra) text += `# Zusätzliche Infos vom Nutzer\n${extra}\n\n`;
  text += "Bitte prüfe jetzt das Objekt.";
  // Cache-Breakpoint hinter den Unterlagen: Rückfragen lesen sie dann günstig aus dem Cache.
  content.push({ type: "text", text, cache_control: { type: "ephemeral" } });
  return content;
}

// turns[0] ist der Prüfauftrag (steckt schon in firstMessage), danach abwechselnd assistant/user.
function buildMessages(body) {
  const turns = Array.isArray(body.turns) ? body.turns : [];
  if (!turns.length || turns.length > MAX_TURNS) return null;
  const messages = [{ role: "user", content: firstMessage(body) }];
  for (let i = 1; i < turns.length; i++) {
    const role = i % 2 ? "assistant" : "user";
    if (turns[i]?.role !== role) return null;
    const content = str(turns[i].content, MAX_TURN_CHARS);
    if (!content.trim()) return null;
    messages.push({ role, content });
  }
  return messages.at(-1).role === "user" ? messages : null;
}

function errorCode(e) {
  if (e instanceof Anthropic.AuthenticationError) return "bad_key";
  if (e instanceof Anthropic.RateLimitError) return "rate_limited";
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529) return "overloaded";
    if (e.status === 400 && /credit balance/i.test(e.message)) return "bad_key";
    if (e.status === 413 || (e.status === 400 && /too long|too large|exceed/i.test(e.message))) return "too_large";
  }
  return "upstream";
}

// Kurze, ungefährliche Fehlerbeschreibung für die Seite (Status und Fehlertext der API, keine Schlüssel).
function errorDetail(e) {
  if (e instanceof Anthropic.APIError) return `${e.status || "?"} ${String(e.error?.error?.message || e.message || "").slice(0, 180)}`;
  return String(e?.message || e).slice(0, 180);
}

const retryable = (e) => e instanceof Anthropic.APIError && [400, 403, 404].includes(e.status) && !/credit balance|too long|too large/i.test(e.message);

// Aufruf im Browser zeigt, ob der Server läuft und der Key gesetzt ist.
export function GET() {
  return json(200, { ok: true, key: !!process.env.ANTHROPIC_API_KEY, model: MODEL, code: !!process.env.OBI_CODE });
}

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: "no_key" });
  client ??= new Anthropic();
  const code = process.env.OBI_CODE;
  if (code && request.headers.get("x-obi-code") !== code) return json(401, { error: "unauthorized" });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "upstream" }); }
  const hasInput = (body.docs?.length || body.images?.length || str(body.extra, 10).trim());
  if (!hasInput) return json(400, { error: "empty" });
  const messages = buildMessages(body);
  if (!messages) return json(400, { error: "upstream" });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (o) => ctl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      const sources = new Map();
      const addSource = (url, title) => { if (url && !sources.has(url)) sources.set(url, { url, title: title || "" }); };
      let attempt = 0, sent = false;
      const emit = (o) => { sent = true; send(o); };
      for (;;) try {
        const { fallback, search } = ATTEMPTS[attempt];
        let final;
        for (let pause = 0; ; pause++) {
          const s = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 32000,
            system: search ? RULES : RULES + NO_SEARCH_NOTE,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
            ...(search ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "DE" } }] } : {}),
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
          }, { signal: request.signal });

          // Suchanfragen kommen als Teil-JSON; pro Block sammeln und beim Blockende melden.
          const pending = new Map();
          for await (const ev of s) {
            if (ev.type === "content_block_start") {
              const b = ev.content_block;
              if (b.type === "server_tool_use" && b.name === "web_search") pending.set(ev.index, "");
              else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach((r) => addSource(r.url, r.title));
            } else if (ev.type === "content_block_delta") {
              if (ev.delta.type === "text_delta") emit({ t: "text", d: ev.delta.text });
              else if (ev.delta.type === "input_json_delta" && pending.has(ev.index)) pending.set(ev.index, pending.get(ev.index) + ev.delta.partial_json);
              else if (ev.delta.type === "citations_delta") addSource(ev.delta.citation?.url, ev.delta.citation?.title);
            } else if (ev.type === "content_block_stop" && pending.has(ev.index)) {
              try { const q = JSON.parse(pending.get(ev.index) || "{}").query; if (q) emit({ t: "search", q: String(q) }); } catch {}
              pending.delete(ev.index);
            }
          }
          final = await s.finalMessage();
          // Langer Websuche-Durchlauf: Antwort anhängen und fortsetzen lassen.
          if (final.stop_reason === "pause_turn" && pause < MAX_PAUSES) {
            messages.push({ role: "assistant", content: final.content });
            continue;
          }
          break;
        }
        if (final.stop_reason === "refusal") { send({ t: "error", code: "refused" }); ctl.close(); return; }
        send({ t: "sources", list: [...sources.values()].slice(0, 12) });
        send({ t: "done", truncated: final.stop_reason === "max_tokens" || final.stop_reason === "pause_turn" });
        ctl.close();
        return;
      } catch (e) {
        if (request.signal.aborted) { try { ctl.close(); } catch {} return; }
        console.error(`obi (Stufe ${attempt}):`, errorDetail(e));
        if (!sent && retryable(e) && attempt < ATTEMPTS.length - 1) { attempt++; continue; }
        try { send({ t: "error", code: errorCode(e), detail: errorDetail(e) }); ctl.close(); } catch {}
        return;
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
