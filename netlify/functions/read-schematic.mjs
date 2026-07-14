/**
 * BlueVector Helpline — schematic vision bridge (Claude vision)
 * ------------------------------------------------------------------
 * Vapi is voice/text only; it cannot see an image. This function is the
 * agent's EYES. It runs two modes:
 *
 *   mode: "initial"  (called by the splash page at upload time)
 *     -> stores the image (Netlify Blobs, keyed by sessionId)
 *     -> Claude vision does a THOROUGH structured read of the drawing
 *     -> returns { report, deviceList } which the page injects into the call
 *
 *   Vapi tool call    (called by the assistant DURING the conversation)
 *     -> loads the stored image for the caller's sessionId
 *     -> Claude vision answers a specific spatial question about the drawing
 *     -> returns the answer in Vapi's expected tool-result shape
 *
 * The image is never flattened to lossy text — the actual drawing is
 * re-consulted whenever the agent asks a question about it.
 *
 * Setup:
 *   - Netlify env var  ANTHROPIC_API_KEY   (required)
 *   - Optional         ANTHROPIC_MODEL     (default: claude-sonnet-5)
 *   - Netlify Blobs is auto-provisioned on deploy; no config needed.
 *   - Point your Vapi assistant's custom tool ("inspect_schematic") at:
 *       POST https://<your-site>/.netlify/functions/read-schematic
 *     with parameters { sessionId (string), question (string) }.
 */
import { getStore } from "@netlify/blobs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

function store() { return getStore("helpline-schematics"); }

/* ---- Claude vision call ---- */
async function askVision({ mediaType, base64, prompt, maxTokens = 1200 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const isPdf = mediaType === "application/pdf";
  const media = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image",    source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 } };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: [media, { type: "text", text: prompt }] }]
    })
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + ": " + (await res.text()).slice(0, 400));
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("").trim();
}

/* ---- prompts ---- */
const INITIAL_PROMPT = (fault) => `You are a control-panel diagnostics expert reading a schematic or a photo of a control panel. Read the ACTUAL drawing carefully — devices, labels, ratings, and how they are wired together.

Caller's reported symptom: ${fault || "(not provided)"}

Return ONLY a JSON object, no prose, in this exact shape:
{
  "report": "<6-10 sentence plain-spoken briefing for a phone technician: what this panel is, the key devices and their ratings, how power flows (supply -> protection -> switching -> load) and the control path (start/stop -> coil), anything unusual, and the 1-2 most likely causes of the reported symptom given what you can SEE in the drawing>",
  "deviceList": ["<short device labels, e.g. 'Contactor K1', 'Thermal OL 10A', 'Soft starter ABB PSE', 'VFD', '3HP pump motor'>"]
}
If something is illegible, say so in the report rather than guessing.`;

const QUERY_PROMPT = (q) => `You are the EYES for a diagnostician who is on a live phone call and cannot see this drawing. Answer their question by looking at the schematic/photo. Be specific and concise (1-4 sentences). Refer to devices by their exact labels. If the drawing doesn't show enough to answer, say exactly what's missing.

Question: ${q}`;

/* ---- extract a Vapi tool call, if this is one ---- */
function parseVapiToolCall(body) {
  const m = body && body.message;
  if (!m) return null;
  const calls = m.toolCalls || m.toolCallList || (m.toolCall ? [m.toolCall] : null);
  if (!calls || !calls.length) return null;
  const c = calls[0];
  let args = (c.function && c.function.arguments) || c.arguments || {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  // sessionId may come via the tool args or the call's variableValues
  const vv =
    (m.call && m.call.assistantOverrides && m.call.assistantOverrides.variableValues) ||
    (body.call && body.call.assistantOverrides && body.call.assistantOverrides.variableValues) || {};
  return {
    toolCallId: c.id || c.toolCallId,
    sessionId: args.sessionId || vv.sessionId,
    question: args.question || args.query || ""
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  // ---- Path A: Vapi tool call (live, mid-conversation) ----
  const tool = parseVapiToolCall(body);
  if (tool) {
    try {
      if (!tool.sessionId) throw new Error("no sessionId on tool call");
      const raw = await store().get(tool.sessionId, { type: "text" });
      if (!raw) throw new Error("no schematic on file for this session");
      const { mediaType, base64 } = JSON.parse(raw);
      const answer = await askVision({ mediaType, base64, prompt: QUERY_PROMPT(tool.question), maxTokens: 600 });
      // Vapi expects { results: [{ toolCallId, result }] }
      return json({ results: [{ toolCallId: tool.toolCallId, result: answer }] });
    } catch (err) {
      return json({ results: [{ toolCallId: tool.toolCallId, result: "Vision lookup failed: " + err.message }] });
    }
  }

  // ---- Path B: initial read from the splash page ----
  const { mode, sessionId, mediaType, imageBase64, faultDesc } = body;
  if ((mode === "initial" || !mode) && imageBase64 && sessionId) {
    try {
      // stash the image so the live tool can re-open it during the call
      await store().set(sessionId, JSON.stringify({ mediaType, base64: imageBase64 }));

      const text = await askVision({ mediaType, base64: imageBase64, prompt: INITIAL_PROMPT(faultDesc) });
      let out = { report: text, deviceList: [] };
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          out = { report: parsed.report || text, deviceList: parsed.deviceList || [] };
        } catch { /* keep raw text as report */ }
      }
      return json(out);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: "unrecognized request; expected an initial read or a Vapi tool call" }, 400);
};
