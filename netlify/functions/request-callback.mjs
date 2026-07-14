/**
 * BlueVector Helpline — "CALL ME NOW" outbound callback (Vapi)
 * ------------------------------------------------------------------
 * The splash posts the caller's number here; this triggers a Vapi
 * OUTBOUND call that dials them, with the schematic context attached so
 * the agent opens the call already knowing the panel.
 *
 * Uses the Vapi *private* key (server-side only — never expose in the browser).
 *
 * Netlify env vars (required to go live):
 *   VAPI_PRIVATE_KEY      Vapi private/secret key
 *   VAPI_PHONE_NUMBER_ID  id of the Vapi phone number that places the call
 *   VAPI_ASSISTANT_ID     your pump-diagnostics assistant id
 *
 * The schematicReport/deviceList come straight from the page (already
 * produced by read-schematic at upload time), so no re-analysis here.
 * The mid-call `inspect_schematic` tool still works because the image is
 * stored under sessionId by read-schematic.
 */
const VAPI_URL = "https://api.vapi.ai/call";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function toE164(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;       // default US
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d ? "+" + d : "";
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = process.env.VAPI_PRIVATE_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!key || !phoneNumberId || !assistantId) {
    return json({ error: "callback service not configured (set VAPI_PRIVATE_KEY, VAPI_PHONE_NUMBER_ID, VAPI_ASSISTANT_ID)" }, 503);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const number = toE164(body.phone);
  if (!number || number.replace(/\D/g, "").length < 11) return json({ error: "invalid phone number" }, 400);

  const payload = {
    phoneNumberId,
    assistantId,
    customer: { number, name: (body.callerName || "").slice(0, 80) || undefined },
    assistantOverrides: {
      variableValues: {
        sessionId: body.sessionId || "",
        refCode: body.refCode || "",
        callerName: body.callerName || "",
        faultDesc: body.faultDesc || "",
        schematicReport: body.schematicReport || "(no schematic uploaded)",
        deviceList: Array.isArray(body.deviceList) ? body.deviceList.join(", ") : (body.deviceList || "")
      }
    }
  };

  try {
    const res = await fetch(VAPI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: "Vapi " + res.status + ": " + (data.message || JSON.stringify(data)).slice(0, 300) }, 502);
    return json({ ok: true, callId: data.id || null });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};
