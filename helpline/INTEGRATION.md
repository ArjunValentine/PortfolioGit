# BlueVector Helpline — how it fits together

The `/helpline` splash does three things: read the caller's schematic with a
vision model, start a voice call with Vapi, and link the two. This doc is the
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
2. **Mid-call** (a custom tool) — spatial follow-ups against the *actual image*
   ("does K1's coil feed through the OL contact?"). The drawing is never
   flattened to lossy text; it's re-consulted per question.

## Pieces in this repo

| File | Role |
|---|---|
| `helpline/index.html` | The splash (blueprint look). Upload + client-side downscale, **CALL ME NOW** callback, session/ref-code linkage, optional browser-call fallback. |
| `netlify/functions/read-schematic.mjs` | The eyes. `initial` mode = full read; Vapi tool mode = live Q&A on the stored image. |
| `netlify/functions/request-callback.mjs` | The **CALL ME NOW** handler. Triggers a Vapi *outbound* call to the caller with the schematic context attached. |
| `netlify.toml` | Functions-only build config (does **not** touch your publish dir). |
| `package.json` | One dep: `@netlify/blobs` (image storage for the mid-call tool). |

## Call model: callback-primary

The hero action is **CALL ME NOW** — the caller types their number and Vapi
dials *them* (outbound). This works from any phone, no mic/permissions. A
secondary "browser call" link uses the Vapi Web SDK (WebRTC) for anyone who'd
rather talk through the page. Both hand the agent the same schematic context.

## Front-end config (`HELPLINE` block in `index.html`)

```js
VAPI_PUBLIC_KEY:   ""   // Vapi *public* key (browser-safe)
VAPI_ASSISTANT_ID: ""   // your pump-diagnostics assistant
VISION_ENDPOINT:   "/.netlify/functions/read-schematic"
HELPLINE_NUMBER:   ""   // optional phone fallback (E.164)
```

Everything degrades gracefully: with all blank the page still works and tells
the user what isn't wired yet.

## Setup checklist

1. **Netlify env vars:**
   - `ANTHROPIC_API_KEY` (required — the vision reads). Optional
     `ANTHROPIC_MODEL` (default `claude-sonnet-5`; use `claude-opus-4-8` for the
     most careful schematic reading, at higher latency/cost).
   - For **CALL ME NOW**: `VAPI_PRIVATE_KEY`, `VAPI_PHONE_NUMBER_ID`,
     `VAPI_ASSISTANT_ID`. (Buy/import a number in Vapi to get the phone-number id.)
2. **Deploy.** Netlify auto-provisions Blobs and bundles the function. The
   function lives at `/.netlify/functions/read-schematic`.
3. **Create a Vapi assistant.** Paste the pump-diagnostics system prompt. Have
   it reference the injected variables, e.g.:
   ```
   Panel on file for this caller:
   {{schematicReport}}
   Devices: {{deviceList}}
   Caller: {{callerName}} — reported: {{faultDesc}}
   ```
4. **Add a custom tool** on the assistant named `inspect_schematic`, pointed at
   `POST https://<your-site>/.netlify/functions/read-schematic`, with parameters
   `sessionId` (string) and `question` (string). Tell the agent in its prompt to
   pass `{{sessionId}}` and to call this tool whenever it needs to look at the
   drawing again.
5. **Paste** `VAPI_PUBLIC_KEY` and `VAPI_ASSISTANT_ID` into the `HELPLINE`
   config. Optionally set `HELPLINE_NUMBER` for phone-in callers.

## Linkage (call ↔ upload)

- **`sessionId`** (UUID, minted on page load) travels with the upload *and* the
  call (`variableValues.sessionId`). It's the key the mid-call tool uses to
  re-open the right image from Blobs.
- **`refCode`** (6 digits, shown on the page) is the fallback for anyone who
  phones the number instead of using the browser button — they read it out and
  the expert pulls up the schematic.

## Request shapes

Initial read (browser → function):
```json
POST /.netlify/functions/read-schematic
{ "mode":"initial", "sessionId":"…", "mediaType":"image/jpeg",
  "imageBase64":"…", "faultDesc":"pump won't start" }
→ { "report":"…", "deviceList":["Contactor K1","Thermal OL 10A", …] }
```

Live tool (Vapi → function): standard Vapi tool-call payload in; the function
replies `{ "results":[{ "toolCallId":"…", "result":"…" }] }`.

## Notes / next steps

- **Request size:** Netlify sync functions cap the body ~6 MB; the page
  downscales images to `MAX_IMG_DIM` (1600px) before sending to stay well under.
- **Persistence:** Blobs entries are keyed by `sessionId`. Add a TTL/cleanup job
  if you want them to expire.
- **Billing** falls out of the Vapi call record: `ceil(duration/60)` clamped to
  `MIN_MINUTES`, times `RATE_PER_MIN`.
