/**
 * L5X Studio — Claude bridge for the ladder-logic generator (/l5x)
 * ------------------------------------------------------------------
 * Keeps the Anthropic key server-side (never shipped to the browser) and
 * gives the /l5x page two capabilities:
 *
 *   mode: "chat"
 *     Iterative, back-and-forth PLC design help. The page sends the running
 *     conversation plus a compact snapshot of the current program (sheets +
 *     rung neutral-text). Claude replies conversationally AND emits a strict
 *     JSON "ops" block describing rungs/sheets/tags to apply. The function
 *     splits the two so the page shows clean prose and applies the ops.
 *
 *   mode: "ocr"
 *     Vision read of a photographed / scanned / PDF hand-drawn ladder. Claude
 *     converts the drawing into the SAME neutral-text rungs the chat mode
 *     emits, so the page merges them through one code path.
 *
 * Both modes return: { reply: string, ops: { ... } }  (ops may be empty).
 *
 * Setup (Netlify env):
 *   ANTHROPIC_API_KEY   required
 *   ANTHROPIC_MODEL     optional, default claude-sonnet-5
 *
 * The neutral-text rung grammar (shared contract with the page):
 *   - Series is juxtaposition:            XIC(Start)XIO(Stop)OTE(Motor)
 *   - Parallel branch in square brackets: [XIC(Start),XIC(Run)]OTE(Motor)
 *   - Box instructions carry args:        TON(T_Fill,?,5000,0)
 *   - A rung need not end in ';' (the page normalizes that).
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/* ---- the shared instruction cheat-sheet Claude designs against ---- */
const INSTRUCTION_GUIDE = `
Supported ladder instructions (Rockwell/Studio 5000 neutral text):
  Contacts:  XIC(tag)  examine-if-closed (-] [-),  XIO(tag) examine-if-open (-]/[-)
  Coils:     OTE(tag)  output energize,  OTL(tag) latch,  OTU(tag) unlatch,  ONS(bit) one-shot
  Timers:    TON(timer,?,preset_ms,0)  on-delay,  TOF(...) off-delay,  RTO(...) retentive
  Counters:  CTU(counter,?,preset)  count-up,  CTD(...) count-down,  RES(timer_or_counter)
  Compare:   EQU(a,b) NEQ(a,b) LES(a,b) GRT(a,b) LEQ(a,b) GEQ(a,b) LIM(low,test,high)
  Math/move: MOV(src,dest) ADD(a,b,dest) SUB(a,b,dest) MUL(a,b,dest) DIV(a,b,dest) CLR(dest)
  Routine:   JSR(RoutineName)
Timer/counter fields: use '?' for the auto-created timer/counter tag's own slot; presets are numbers.
Tag names must be valid Logix identifiers: start with a letter/underscore, then letters/digits/underscore.
Every rung ends with an output (a coil or a box). Prefer descriptive tag names (Start_PB, Motor_Run, T_Fill).`;

const CHAT_SYSTEM = `You are a friendly senior controls engineer helping someone build a PLC ladder-logic program that will be exported as a Studio 5000 (RSLogix 5000) .L5X file. Your user may be a layman, so ask clarifying questions when the intent is ambiguous, and explain choices briefly in plain language.

${INSTRUCTION_GUIDE}

You are given the CURRENT PROGRAM as sheets (routines) of neutral-text rungs. When the user asks for logic, translate it into concrete rungs and describe what you did in one short paragraph. Keep interlocks and safety (e.g. seal-in circuits, E-stop, thermal overloads) in mind and mention them.

RESPONSE FORMAT — every reply MUST contain exactly two parts, in order:
1. Your natural-language message to the user (prose, no code fences).
2. A single fenced code block tagged json containing an "ops" object. Emit it EVERY time; use empty arrays when there is nothing to change.

The ops object schema:
{
  "controller": { "name": "optional new controller name" },
  "sheets": ["names of sheets that must exist; created if missing"],
  "replaceSheets": ["names of sheets whose rungs should be cleared before applying new rungs from this turn"],
  "rungs": [
    { "sheet": "SheetName", "comment": "what this rung does", "text": "XIC(Start)[XIC(Run),XIC(Aux)]XIO(Stop)OTE(Motor_Run)" }
  ],
  "removeRungs": [ { "sheet": "SheetName", "index": 0 } ]
}
Rules: put related rungs on the same sheet; use separate sheets for genuinely parallel/independent processes (e.g. "Conveyor", "Fill_Station"). Never invent instructions outside the supported set. If you are only asking a question and not changing logic, still emit an ops block with empty arrays.`;

const OCR_SYSTEM = `You are a controls engineer reading a photograph, scan, or PDF of a HAND-DRAWN or printed ladder-logic diagram, and converting it to Studio 5000 neutral text.

${INSTRUCTION_GUIDE}

Read the drawing rung by rung, left power rail to right power rail. Series contacts are drawn in a line; parallel contacts (branches / OR legs) are stacked vertically — express those with [ , ]. Coils/outputs sit at the right. Infer sensible tag names from any labels or addresses written on the drawing (e.g. "I:0/0", "Start PB", "M1"); if a symbol is illegible, use a clearly-guessed name and note it.

RESPONSE FORMAT — exactly two parts:
1. A short plain-language summary of what the drawing does and anything you were unsure about.
2. A single fenced json code block with the SAME ops schema used by the chat tool:
{ "sheets": ["Imported"], "rungs": [ { "sheet": "Imported", "comment": "...", "text": "XIC(Start)OTE(Motor)" } ] }
Put every converted rung on a sheet named "Imported" unless the drawing clearly shows separate labelled routines.`;

/* Pull the last ```json ... ``` block out of Claude's text; return {reply, ops}. */
function splitReplyAndOps(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m,
    last = null;
  while ((m = fence.exec(text))) last = m;
  let ops = {};
  let reply = text;
  if (last) {
    try {
      ops = JSON.parse(last[1].trim());
    } catch {
      // try to salvage the first {...} span inside the fence
      const s = last[1].indexOf("{"),
        e = last[1].lastIndexOf("}");
      if (s !== -1 && e !== -1) {
        try {
          ops = JSON.parse(last[1].slice(s, e + 1));
        } catch {
          ops = {};
        }
      }
    }
    reply = text.slice(0, last.index).trim();
  }
  if (!reply) reply = "Done — see the updated ladder above.";
  return { reply, ops: ops && typeof ops === "object" ? ops : {} };
}

async function callClaude({ system, messages, maxTokens = 2000, media }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server");

  // If media is supplied (OCR), prepend it to the first user message content.
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error("Anthropic " + res.status + ": " + (await res.text()).slice(0, 500));
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("").trim();
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  try {
    if (body.mode === "ocr") {
      const { mediaType, imageBase64, hint } = body;
      if (!imageBase64) return json({ error: "no image supplied" }, 400);
      const isPdf = mediaType === "application/pdf";
      const media = isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
        : { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } };
      const userText =
        "Convert this ladder diagram to neutral text." +
        (hint ? " Context from the user: " + hint : "");
      const text = await callClaude({
        system: OCR_SYSTEM,
        maxTokens: 2500,
        messages: [{ role: "user", content: [media, { type: "text", text: userText }] }],
      });
      return json(splitReplyAndOps(text));
    }

    // default: chat mode
    const { messages, program } = body;
    if (!Array.isArray(messages) || !messages.length) {
      return json({ error: "no messages" }, 400);
    }
    // Build a compact snapshot of the current program for grounding.
    const snapshot = programSnapshot(program);
    const convo = [
      {
        role: "user",
        content:
          "CURRENT PROGRAM SNAPSHOT (for your reference; do not repeat it back verbatim):\n" +
          snapshot,
      },
      ...messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) })),
    ];
    const text = await callClaude({ system: CHAT_SYSTEM, messages: convo, maxTokens: 2200 });
    return json(splitReplyAndOps(text));
  } catch (err) {
    return json({ error: err.message || String(err) }, 500);
  }
};

function programSnapshot(program) {
  try {
    if (!program || !Array.isArray(program.sheets) || !program.sheets.length) {
      return "(empty — no rungs yet)";
    }
    const lines = [];
    if (program.controller && program.controller.name) {
      lines.push("Controller: " + program.controller.name);
    }
    for (const sheet of program.sheets) {
      lines.push(`Sheet "${sheet.name}":`);
      if (!sheet.rungs || !sheet.rungs.length) {
        lines.push("  (no rungs)");
        continue;
      }
      sheet.rungs.forEach((r, i) => {
        lines.push(`  ${i}: ${r.text}${r.comment ? "   // " + r.comment : ""}`);
      });
    }
    return lines.join("\n").slice(0, 8000);
  } catch {
    return "(snapshot unavailable)";
  }
}
