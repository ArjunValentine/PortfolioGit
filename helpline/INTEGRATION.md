# BlueVector Helpline — how it fits together

The `/helpline` splash does three things: read the caller's schematic with a
vision model, place a real Vapi voice call, and link the two. This doc is the
map.

## The mental model: one agent, one pair of eyes

- **Vapi assistant** = the *agent*. It talks to the caller, reasons about the
  fault, decides what to ask. It's the only conversational thing.
- **Claude vision** (via the Netlify function) = a *tool/sense*, not a second
  agent. Stateless: hand it the image + a question, it answers "what's on the
  drawing." Voice agents can't see images — this is how the agent sees.

The agent uses its eyes three ways:
1. **Up front** (at upload) — a thorough structured read of the whole panel,
   injected into the call so the agent opens already knowing the panel.
2. **Mid-call** (a custom tool, `ClaudeReadSchematic` in Vapi) — spatial
   follow-ups against the *actual image* ("does K1's coil feed through the OL
   contact?"). The drawing is never flattened to lossy text; it's
   re-consulted per question.
3. **Text chat on the splash page** — the same eyes, called directly (no Vapi
   involved) so a visitor can type follow-up questions about the panel
   without placing a call at all.

## Call model: two ways in, same context

- **CALL ME NOW** (primary) — caller types their number, `request-callback.mjs`
  triggers a Vapi **outbound** call to them. Works from any phone, no mic.
- **Start a browser call** (secondary) — Vapi Web SDK, in-page WebRTC call.
  Both paths pass the same `variableValues` (sessionId, refCode, callerName,
  faultDesc, schematicReport, deviceList) so the agent opens knowing the panel
  either way.

## Pieces in this repo

| File | Role |
|---|---|
| `helpline/index.html` | The splash. Upload + client-side downscale, **CALL ME NOW** callback, browser-call fallback (Vapi Web SDK), text chat box, session/ref-code linkage. |
| `netlify/functions/read-schematic.mjs` | The eyes. `initial` mode = full read (stores image in Blobs); `chat` mode = direct text Q&A for the splash-page chat box; Vapi tool mode = live Q&A on the stored image during a call. |
| `netlify/functions/request-callback.mjs` | The **CALL ME NOW** handler. Triggers a Vapi *outbound* call with the schematic context attached. |
| `netlify.toml` | Functions-only build config (does **not** touch the site's publish dir). |
| `package.json` | One dep: `@netlify/blobs` (image storage for the mid-call tool). |

## Front-end config (`HELPLINE` block in `index.html`)

```js
CALLBACK_ENDPOINT: "/.netlify/functions/request-callback"
VISION_ENDPOINT:   "/.netlify/functions/read-schematic"
VAPI_PUBLIC_KEY:   ""   // Vapi *public* key (browser-safe) — enables the browser-call fallback
VAPI_ASSISTANT_ID: ""   // your pump-diagnostics assistant
```
Everything degrades gracefully: with the Vapi fields blank, browser calling
shows "isn't configured yet" and CALL ME NOW still works via the server
function (once its own env vars are set, below).

## Setup checklist

1. **Netlify env vars:**
   - `ANTHROPIC_API_KEY` (required — the vision reads). Optional
     `ANTHROPIC_MODEL` (default `claude-sonnet-5`; use `claude-opus-4-8` for
     the most careful schematic reading, at higher latency/cost).
   - For **CALL ME NOW**: `VAPI_PRIVATE_KEY`, `VAPI_PHONE_NUMBER_ID`,
     `VAPI_ASSISTANT_ID`. (Buy/import a number in Vapi to get the phone-number id.)
2. **Create a Vapi assistant.** Paste the pump-diagnostics system prompt,
   referencing the injected variables:
   ```
   Panel on file for this caller:
   {{schematicReport}}
   Devices: {{deviceList}}
   Caller: {{callerName}} — reported: {{faultDesc}}
   ```
3. **Add the mid-call tool**: an "API Request" tool in Vapi, POST to
   `https://<your-site>/.netlify/functions/read-schematic`. In its **Request
   Body** schema (not "Response Body" — that extracts *from* the reply, not
   into the request), add **three** properties:
   - `sessionId` (string) — Default Value `{{sessionId}}` (static, auto-filled
     from the call's live variables on browser/CALL ME NOW calls; empty on a
     raw inbound call — that's fine, see `refCode` below)
   - `refCode` (string) — leave Default Value **blank**, LLM-supplied. This is
     the fallback for someone who dialed the number directly: tell the
     assistant (in its system prompt) to ask for the caller's 6-digit
     reference code from the website when `sessionId` wasn't pre-attached, and
     pass whatever the caller says here.
   - `question` (string) — leave Default Value blank; the model writes this
     each time based on the tool's description.
4. Paste `VAPI_PUBLIC_KEY` + `VAPI_ASSISTANT_ID` into the `HELPLINE` config in
   `helpline/index.html` (already done on this branch) to enable the browser
   fallback.

## Linkage (call ↔ upload)

- **`sessionId`** (UUID, minted on page load) travels with the upload *and*
  both call paths. It's the key the mid-call tool uses to re-open the right
  image from Blobs.
- **`refCode`** (6 digits, shown on the page) is a real, working fallback key
  for inbound calls: at upload time the function also stores a small
  `ref:<code> → sessionId` pointer, so a caller who dials in directly (no
  pre-attached sessionId) can read the code aloud and the tool resolves it
  back to their stored schematic.

## Testing the full loop without CALL ME NOW

If your Vapi number has hit its native-number daily outbound cap (common on a
brand-new PAYG account — see Vapi's `call.start.error-vapi-number-outbound-daily-limit`),
you can still test the *entire* diagnostic quality end-to-end via a plain
**inbound** call, which isn't subject to that limit:

1. On the splash, upload a real schematic and click "Read my schematic" —
   note the reference code shown on the page.
2. Call your Vapi number directly from your own phone (a normal inbound call).
3. Tell the assistant your reference code and describe the symptom.
4. The assistant should call its tool with your spoken `refCode`, which
   resolves to your stored image — this exercises the *live* mid-call vision
   lookup (the harder, less-tested path), not just the pre-injected report
   that CALL ME NOW/browser calls get for free.

## Request shapes

Initial read (browser → function):
```json
POST /.netlify/functions/read-schematic
{ "mode":"initial", "sessionId":"…", "mediaType":"image/jpeg",
  "imageBase64":"…", "faultDesc":"pump won't start" }
→ { "report":"…", "deviceList":["Contactor K1","Thermal OL 10A", …] }
```

CALL ME NOW (browser → function → Vapi outbound call):
```json
POST /.netlify/functions/request-callback
{ "sessionId":"…", "refCode":"…", "phone":"+1...", "callerName":"…",
  "faultDesc":"…", "schematicReport":"…", "deviceList":[...] }
→ { "ok": true, "callId": "..." }
```

Live tool (Vapi → function): standard Vapi tool-call payload in; the function
replies `{ "results":[{ "toolCallId":"…", "result":"…" }] }`.

Text chat (splash page → function, no Vapi involved):
```json
POST /.netlify/functions/read-schematic
{ "mode":"chat", "sessionId":"…", "refCode":"…", "question":"why won't the pump start?" }
→ { "answer":"…" }
```
Requires a schematic already on file for that `sessionId`/`refCode` (i.e. the
splash page's "Read my schematic" step must have run first). Same
`resolveSchematic` + Claude vision path as the Vapi tool, just called
directly and returning a plain `{ answer }` instead of Vapi's tool-result
envelope.

## Notes

- **Request size:** Netlify sync functions cap the body ~6 MB; the page
  downscales images to 1600px before sending to stay well under.
- **Persistence:** Blobs entries are keyed by `sessionId`. Add a TTL/cleanup
  job if you want them to expire.
- **Billing** falls out of the Vapi call record: `ceil(duration/60)` clamped
  to `MIN_MINUTES`, times `RATE_PER_MIN`.
