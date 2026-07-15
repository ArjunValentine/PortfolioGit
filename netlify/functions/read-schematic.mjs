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
 *     -> loads the stored image for the caller's sessionId, OR by refCode if
 *        the caller dialed in directly and read their 6-digit code aloud
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
 *   - Point your Vapi assistant's custom tool at:
 *       POST https://<your-site>/.netlify/functions/read-schematic
 *     with Request Body parameters:
 *       sessionId (string, Default Value {{sessionId}} - auto-filled on
 *                  browser/outbound calls, empty on a raw inbound call)
 *       refCode   (string, no default - LLM-supplied; ask the caller for
 *                  their 6-digit reference code when sessionId is empty)
 *       question  (string, no default - LLM-supplied)
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
function clamp01(n) { n = Number(n); return isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }

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
  "summary": "<ONE sentence, ~20 words max: what kind of panel this is and the single most likely fault cause given the reported symptom>",
  "report": "<6-10 sentence plain-spoken briefing for a phone technician: what this panel is, the key devices and their ratings, how power flows (supply -> protection -> switching -> load) and the control path (start/stop -> coil), anything unusual, and the 1-2 most likely causes of the reported symptom given what you can SEE in the drawing>",
  "deviceList": ["<short device labels, e.g. 'Contactor K1', 'Thermal OL 10A', 'Soft starter ABB PSE', 'VFD', '3HP pump motor'>"]
}
If something is illegible, say so in the report rather than guessing.`;

const LIVEVISION_PROMPT = (fault) => `You are a control-panel diagnostics expert looking at a single live camera frame of a control panel (not a clean schematic scan — it may have glare, angle distortion, or partial framing; do your best with what's visible).

Caller's reported symptom: ${fault || "(not provided)"}

Identify the physical locations of the devices most relevant to diagnosing this fault, and return an ORDERED, numbered sequence of "steps" a technician should look at in order:
1. Start with the device(s) you suspect are the actual fault (role "suspected-fault") — the thing most likely causing the reported symptom, based on what you can see.
2. THEN, if and only if reaching or testing that suspected component requires the technician to touch, open, or come near energized equipment, add a step (role "safety-action") pointing at the breaker, disconnect, or fuse that must be switched OFF FIRST, before physically touching the suspected-fault component. Always order safety-action steps AFTER the fault they protect against, so the reading order is "here's what's likely wrong" -> "here's what to shut off before you touch it."
3. You may include additional supporting steps (role "reference") if useful, but keep the total to 5 steps or fewer, ordered by priority.

For each step give a bounding box as normalized fractions of the FULL image, top-left origin (0,0) to bottom-right (1,1): x = left edge / image width, y = top edge / image height, w = box width / image width, h = box height / image height. Be as tight and accurate as you can to the actual device's visible location in the frame.

Return ONLY a JSON object, no prose, in this exact shape:
{
  "summary": "<ONE sentence, ~20 words max: what you see and the single most likely fault>",
  "steps": [
    { "label": "<short device label, e.g. 'Starter contactor K1'>",
      "role": "suspected-fault" | "safety-action" | "reference",
      "boundingBox": { "x":0.0, "y":0.0, "w":0.0, "h":0.0 },
      "note": "<one sentence: why this step matters / what to check or do>" }
  ]
}
If you cannot confidently locate any device in this frame (too blurry, wrong subject, etc.), return an empty "steps" array and explain why in "summary" rather than guessing at coordinates.`;

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
  // sessionId may come via the tool args or the call's variableValues (browser/outbound
  // calls pre-attach it). refCode is the fallback for a caller who dialed in directly
  // and read their 6-digit code aloud - the agent passes whatever the caller gave it.
  const vv =
    (m.call && m.call.assistantOverrides && m.call.assistantOverrides.variableValues) ||
    (body.call && body.call.assistantOverrides && body.call.assistantOverrides.variableValues) || {};
  return {
    toolCallId: c.id || c.toolCallId,
    sessionId: args.sessionId || vv.sessionId,
    refCode: args.refCode || vv.refCode,
    question: args.question || args.query || ""
  };
}

/* Resolve a sessionId directly, or fall back to a 6-digit refCode pointer
   (stored at upload time) for callers who dialed in without one pre-attached. */
async function resolveSchematic({ sessionId, refCode }) {
  if (sessionId) {
    const raw = await store().get(sessionId, { type: "text" });
    if (raw) return raw;
  }
  if (refCode) {
    const digits = String(refCode).replace(/\D/g, "");
    if (digits) {
      const mappedSessionId = await store().get("ref:" + digits, { type: "text" });
      if (mappedSessionId) return store().get(mappedSessionId, { type: "text" });
    }
  }
  return null;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  // ---- Path A0: Vapi "assistant-request" (this endpoint is sitting as a
  // phone number's Server URL, not just the tool's). Vapi sends this when a
  // number has no assistant statically assigned and needs one within 7.5s,
  // or it aborts the call. Answer it so an inbound call never dies here. ----
  if (body && body.message && body.message.type === "assistant-request") {
    const assistantId = process.env.VAPI_ASSISTANT_ID;
    return assistantId ? json({ assistantId }) : json({ error: "VAPI_ASSISTANT_ID not set" }, 500);
  }

  // ---- Path A: Vapi tool call (live, mid-conversation) ----
  const tool = parseVapiToolCall(body);
  if (tool) {
    try {
      if (!tool.sessionId && !tool.refCode) throw new Error("no sessionId or refCode on tool call");
      const raw = await resolveSchematic(tool);
      if (!raw) throw new Error("no schematic on file for that session/reference code");
      const { mediaType, base64 } = JSON.parse(raw);
      const answer = await askVision({ mediaType, base64, prompt: QUERY_PROMPT(tool.question), maxTokens: 600 });
      // Vapi expects { results: [{ toolCallId, result }] }
      return json({ results: [{ toolCallId: tool.toolCallId, result: answer }] });
    } catch (err) {
      return json({ results: [{ toolCallId: tool.toolCallId, result: "Vision lookup failed: " + err.message }] });
    }
  }

  // ---- Path B: initial read from the splash page ----
  const { mode, sessionId, refCode, mediaType, imageBase64, faultDesc, question } = body;

  // ---- Path B1: direct text chat (splash-page chat box, no phone call) ----
  if (mode === "chat") {
    if (!sessionId && !refCode) return json({ error: "no sessionId or refCode" }, 400);
    if (!question || !question.trim()) return json({ error: "no question" }, 400);
    try {
      const raw = await resolveSchematic({ sessionId, refCode });
      if (!raw) return json({ error: "no schematic on file for that session/reference code" }, 404);
      const { mediaType: storedMediaType, base64 } = JSON.parse(raw);
      const answer = await askVision({ mediaType: storedMediaType, base64, prompt: QUERY_PROMPT(question), maxTokens: 600 });
      return json({ answer });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ---- Path B2: Live Vision capture (splash-page camera tab) — same idea as
  // "initial" but the prompt asks for spatially-located steps (bounding boxes)
  // instead of a free-text report, to drive the on-page AR overlay. ----
  if (mode === "livevision" && imageBase64 && sessionId) {
    try {
      await store().set(sessionId, JSON.stringify({ mediaType, base64: imageBase64 }));
      if (refCode) await store().set("ref:" + String(refCode).replace(/\D/g, ""), sessionId);

      const text = await askVision({ mediaType, base64: imageBase64, prompt: LIVEVISION_PROMPT(faultDesc), maxTokens: 1200 });
      let out = { summary: "", steps: [] };
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          out = { summary: parsed.summary || "", steps: Array.isArray(parsed.steps) ? parsed.steps : [] };
        } catch { /* keep steps empty, summary falls back below */ }
      }
      if (!out.summary) out.summary = text.slice(0, 160) || "Couldn't parse a structured read of this frame.";
      // sanitize/clamp bounding boxes defensively so a malformed value can't break the overlay
      out.steps = out.steps
        .filter((s) => s && s.boundingBox)
        .map((s) => ({
          label: String(s.label || "Unlabeled"),
          role: ["suspected-fault", "safety-action", "reference"].includes(s.role) ? s.role : "reference",
          boundingBox: {
            x: clamp01(s.boundingBox.x), y: clamp01(s.boundingBox.y),
            w: clamp01(s.boundingBox.w), h: clamp01(s.boundingBox.h)
          },
          note: String(s.note || "")
        }));
      const deviceList = out.steps.map((s) => s.label);
      return json({ summary: out.summary, steps: out.steps, deviceList });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if ((mode === "initial" || !mode) && imageBase64 && sessionId) {
    try {
      // stash the image so the live tool can re-open it during the call
      await store().set(sessionId, JSON.stringify({ mediaType, base64: imageBase64 }));
      // and a small pointer so an inbound caller can find it by reading their refCode aloud
      if (refCode) await store().set("ref:" + String(refCode).replace(/\D/g, ""), sessionId);

      const text = await askVision({ mediaType, base64: imageBase64, prompt: INITIAL_PROMPT(faultDesc) });
      let out = { summary: "", report: text, deviceList: [] };
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          out = { summary: parsed.summary || "", report: parsed.report || text, deviceList: parsed.deviceList || [] };
        } catch { /* keep raw text as report */ }
      }
      if (!out.summary) out.summary = (out.report.split(/(?<=[.!?])\s/)[0] || out.report).slice(0, 160);
      return json(out);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ---- Any other Vapi call-lifecycle event this endpoint wasn't meant to
  // receive (status-update, end-of-call-report, transcript, etc. - this
  // happens if this URL is ever left as a phone number's Server URL instead
  // of only the tool's). Acknowledge harmlessly rather than error the call. ----
  if (body && body.message && body.message.type) return json({});

  return json({ error: "unrecognized request; expected an initial read or a Vapi tool call" }, 400);
};
