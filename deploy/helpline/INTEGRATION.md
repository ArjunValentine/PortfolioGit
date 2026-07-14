# BlueVector Helpline — backend integration notes

The `/helpline` page is intentionally backend-agnostic. This doc explains the
two problems you have to solve on the server and the design the front end
already supports:

1. **Linking a call to the schematic that was just uploaded.**
2. **Giving the AI voice agent access to that schematic during the call.**

---

## 1. The linkage problem

A phone call and a web upload are two separate events with no shared identity.
The page solves this with one value generated on page load:

- **`sessionId`** — a UUID minted in the browser, stored in `sessionStorage`.
  It is sent with the schematic upload **and** carried into the call. It is the
  join key: everything about this visit lives under `sessionId`.
- **`refCode`** — a stable 6-digit code derived from `sessionId`, shown on the
  page. It only exists as a **fallback for plain phone (`tel:`) dialing**, where
  you cannot attach data to the call. The IVR/agent asks the caller to say or
  key it in; the backend looks up the schematic by it.

You get to pick which linkage path you use:

| Call path | How the call is linked | Caller effort |
|---|---|---|
| **In-browser web call (WebRTC)** — best | `sessionId` passed as call metadata directly | none |
| **Phone dial (`tel:`)** | caller reads/keys the `refCode`; backend joins on it | reads 6 digits |
| **Caller-ID match** — weakest | match the call's `From` number to the phone entered at upload | none, but fragile (spoofing, shared/withheld numbers, calling from a different phone) |

Recommended: use the **web call** path as primary and keep `refCode` as the
fallback for anyone who dials the number instead.

### Upload payload the page already sends

`POST` (multipart/form-data) to `HELPLINE.UPLOAD_ENDPOINT`:

```
schematics   one or more files
sessionId    UUID  (join key)
refCode      6-digit fallback key
callerName   string
callerPhone  string
faultDesc    string
```

Your handler should: store the files, create a record keyed by both
`sessionId` and `refCode`, and (see below) kick off schematic pre-processing.

---

## 2. Giving the agent access to the upload

Key fact: **voice agents work on text, not images.** The agent can't "look at"
a PDF mid-call. So convert the schematic to text **at upload time**, then feed
that text into the call. Two ways to feed it, use both:

### a) Pre-process at upload (do this once, immediately)

When the file lands, run Claude vision over it and store a structured summary:

```
POST /api/upload  ->  save files under sessionId
                  ->  claude(vision) extracts:
                        - device list (contactors, thermal OLs, VFD/soft starter, model #s)
                        - control flow / wiring path
                        - a short plain-text panel summary
                  ->  store that text on the sessionId record
```

This runs while the caller is still dialing, so it's ready by the time the
call connects. (This is exactly the "semantic device graph" step from the
diagnostics plan.)

### b) Inject that summary into the specific call

When the call starts and your webhook receives the `sessionId`, load the stored
summary and put it into the agent's context — as a per-call system-prompt
variable / assistant override:

```
call connects (sessionId in metadata)
  -> webhook loads schematic_summary for sessionId
  -> start the agent with that text injected, e.g.:
       "PANEL ON FILE FOR THIS CALLER:
        {schematic_summary}
        Devices: {device_list}
        Use this when diagnosing. Refer to specific devices by their label."
```

### c) Optional: give the agent a tool to fetch details on demand

For deep dives, register a function the agent can call mid-conversation:

```
tool  get_schematic_detail(sessionId, query)  ->  your API returns
      the relevant slice of the analysis (e.g. "what feeds the coil of K1?")
```

Platforms below all support custom tools/functions for this.

---

## 3. Concrete wiring per platform

The front end doesn't care which you pick — you set `HELPLINE.HELPLINE_NUMBER`
(and optionally `HELPLINE.VOICE_TOKEN_ENDPOINT` for web calls) and point the
platform's webhook at your server.

### Vapi
- Create an **assistant**; paste the pump-diagnostic system prompt.
- Web call: `vapi.start(ASSISTANT_ID, { metadata: { sessionId }, variableValues: { schematic_summary } })`.
  Inbound phone: set a **server URL**; Vapi sends call events there — read
  `refCode`/caller ID, load the summary, return **assistant overrides** with the
  summary injected.
- Custom tools -> point at your `get_schematic_detail` endpoint.

### Retell AI
- Create an **agent** with the prompt; supports **dynamic variables** and
  **custom functions**.
- Web call: `startCall({ accessToken, metadata: { sessionId } })`.
  Inbound: agent-level webhook delivers call data; inject the summary via
  dynamic variables (`retell_llm_dynamic_variables`).

### Bland.ai
- Most turnkey / no-code pathways. Pass request-level variables and use its
  tools to hit your API. Least flexible for per-call context injection, but
  fastest to stand up.

### Raw Twilio (most control, most work)
- Media Streams + your own STT -> Claude -> TTS. `tel:` can't carry data, so
  use the `refCode` IVR (`<Gather>` the digits) or caller-ID match to find the
  `sessionId`, then stream the summary into the model's system prompt.

---

## Minimal data model

```
session
  id            (uuid)           -- sessionId
  ref_code      (6-digit)        -- fallback join key
  caller_name   text
  caller_phone  text
  fault_desc    text
  created_at    timestamp

schematic
  session_id    -> session.id
  file_url      text             -- storage location
  summary       text             -- Claude vision output (what the agent reads)
  device_list   jsonb

call
  session_id    -> session.id    -- joined on connect via metadata or ref_code
  provider_call_id  text
  duration_sec  int
  billed_minutes int             -- ceil(duration/60), min = HELPLINE.MIN_MINUTES
```

Billing then falls out of the `call` row: `ceil(duration_sec/60)` clamped to the
minimum, times the per-minute rate.
