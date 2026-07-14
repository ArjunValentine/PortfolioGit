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

The agent uses its eyes twice:
1. **Up front** (at upload) — a thorough structured read of the whole panel,
   injected into the call so the agent opens already knowing the panel.
2. **Mid-call** (a custom tool, `ClaudeReadSchematic` in Vapi) — spatial
   follow-ups against the *actual image* ("does K1's coil feed through the OL
   contact?"). The drawing is never flattened to lossy text; it's
   re-consulted per question.

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
| `helpline/index.html` | The splash. Upload + client-side downscale, **CALL ME NOW** callback, browser-call fallback (Vapi Web SDK), session/ref-code linkage. |
| `netlify/functions/read-schematic.mjs` | The eyes. `initial` mode = full read (stores image in Blobs); Vapi tool mode = live Q&A on the stored image. |
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
3. **Add the mid-call tool** (optional, for live re-reads): an "API Request"
   tool in Vapi, POST to `https://<your-site>/.netlify/functions/read-schematic`.
   In its **Request Body** schema (not "Response Body" — that extracts *from*
   the reply, not into the request):
   - `sessionId` (string) — Default Value `{{sessionId}}` (static, pulled from
     the call's live variables — don't make the LLM supply this)
   - `question` (string) — leave Default Value blank; the model writes this
     each time based on the tool's description.
4. Paste `VAPI_PUBLIC_KEY` + `VAPI_ASSISTANT_ID` into the `HELPLINE` config in
   `helpline/index.html` (already done on this branch) to enable the browser
   fallback.

## Linkage (call ↔ upload)

- **`sessionId`** (UUID, minted on page load) travels with the upload *and*
  both call paths. It's the key the mid-call tool uses to re-open the right
  image from Blobs.
- **`refCode`** (6 digits, shown on the page) is a human-readable fallback if
  you ever need to look a session up manually.

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

## Notes

- **Request size:** Netlify sync functions cap the body ~6 MB; the page
  downscales images to 1600px before sending to stay well under.
- **Persistence:** Blobs entries are keyed by `sessionId`. Add a TTL/cleanup
  job if you want them to expire.
- **Billing** falls out of the Vapi call record: `ceil(duration/60)` clamped
  to `MIN_MINUTES`, times `RATE_PER_MIN`.
