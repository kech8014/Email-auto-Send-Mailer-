# Kech — Campaign Automation

A self-hosted email campaign console. Connect your own mailbox over SMTP, upload
a recipient spreadsheet, write the message once, and the campaign runs on the
server at a deliberately human pace — it keeps running with the browser closed,
and survives a refresh, a redeploy, or a cold start without re-sending anything.

The product deliberately reports **only what the transport actually told us**.
There is no open tracking, no click tracking, no invented delivery metrics.

---

## What it does

| Area | Behaviour |
| --- | --- |
| Connection | Provider auto-detection from the address, SMTP send test and IMAP connectivity test, live connection health, credentials sealed with AES-256-GCM and never returned to the browser |
| Recipients | CSV/XLSX import, delimiter and header detection, Unicode, quoted fields, email-column detection, personalization-role detection, normalization, de-duplication, malformed-address flagging, preview table |
| Composer | Subject and body with `{{merge_field}}` tokens from any detected column, rich text and raw HTML modes, live rendered preview, multi-attachment drag-and-drop with size validation |
| Preflight | Blocks the start on missing/invalid addresses, missing merge values, oversized attachments, a disconnected mailbox, duplicates, or cap conflicts — with a confirmation panel before the first send |
| Sending | **Every message waits a fresh random gap, weighted toward the short end of a 5s–2m window** (`GAP_BUCKETS` in `api/_engine.js`), hourly (200) and daily (1500) caps, exponential backoff on transient errors, permanent-failure classification, pause / resume / stop, retry-failed |
| Monitoring | SSE live feed with per-recipient state, progress, current rate, ETA, elapsed time, next-send countdown, timestamped activity log |
| Sample campaign | A dashboard rehearsal of the live monitor on invented recipients — progress ring, per-recipient table and activity feed, drawing its gaps from the same weighted distribution. Nothing is sent; a fast-forward control compresses the wait without distorting the reported rate or ETA |
| History | Every campaign with counts, duration, status and attachments; open one to inspect every recipient and event |
| Compliance | `List-Unsubscribe` header on every message, suppression list, plain-text alternative generated from the HTML |

**It does not** attempt to evade provider limits, anti-spam controls, or CAPTCHAs.
When a provider returns a limit or an error, the worker backs off and surfaces
the reason verbatim.

---

## Architecture

```
public/                 Static console — no framework, no build step
  index.html            Access gate + app shell
  assets/app.js         Router, views, spreadsheet parsing, SSE client
  assets/app.css        Design system

api/                    Serverless request handlers (Node, CommonJS)
  auth.js               login / logout / session          (HMAC session cookie)
  connection.js         discover / test / save / recheck / disconnect / providers
  campaign.js           create / list / get / recipients / preflight / preview /
                        control / analytics / delete / suppress
  upload.js             attachment upload + delete
  settings.js           settings and suppression list
  stream.js             Server-Sent Events feed for the monitor
  tick.js               worker entry point (self-chain, cron sweep, heartbeat)
  health.js             health check with store/config warnings

  _store.js             persistence: redis → blob → memory, plus a send mutex
  _crypto.js            AES-256-GCM sealing, HMAC session and worker tokens
  _providers.js         provider catalogue and auto-detection
  _engine.js            campaign state machine, pacing, caps, classification
  _worker.js            one tick = one send, then chains to the next tick
  _view.js              public projections (strips every secret)
  _http.js              JSON body/response helpers, session extraction

scripts/
  dev-server.js         local server that routes /api/* to the handlers
  smtp-sink.js          fake SMTP server with programmable failures
  e2e.js                end-to-end suite against the sink (43 checks)
```

**Why a self-chaining worker.** A campaign can run for hours; a serverless
request cannot. Each `/api/tick` invocation takes the lock, sends exactly one
message, persists the result, and schedules the next tick. Nothing depends on
the browser staying open. If a chain dies — a cold start, a deploy, a network
blip — the cron sweep and the dashboard heartbeat both revive it, and the
per-recipient state in the store means a revived chain resumes rather than
restarts. That is what makes duplicate sends structurally impossible rather than
merely unlikely.

---

## Run it locally

```bash
npm install
```

```bash
cp .env.example .env
```

Set `ACCESS_CODE` and `SECRET_KEY` (see the comments in `.env.example`), then:

```bash
SECRET_KEY=dev-key ACCESS_CODE=kech node scripts/dev-server.js
```

Open http://127.0.0.1:3400 and sign in with the access code.

Without a KV or Blob token the store runs in process memory — the console works
fully, but campaign state dies with the process. `/api/health` says so.

### Tests

```bash
node scripts/e2e.js
```

Runs the whole engine against a local SMTP sink: real sends, merge fields,
attachments, malformed and duplicate rows, pacing variance, retry with backoff,
permanent-failure classification, cap enforcement, pause/resume, a simulated
crash mid-campaign resumed with no duplicate deliveries, and the security
boundary (sealed passwords, tampered sessions, campaign-scoped worker tokens).

---

## Deploy to Vercel

1. **Create the project** and push this directory.

2. **Add a persistent store.** In the project's Storage tab, create either an
   Upstash/KV database (preferred — strongly consistent) or a Blob store. The
   integration injects `KV_REST_API_URL`/`KV_REST_API_TOKEN` or
   `BLOB_READ_WRITE_TOKEN` for you.

3. **Set the environment variables** from `.env.example`:

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `ACCESS_CODE` | yes | console entry |
   | `SECRET_KEY` | yes | seals credentials, signs sessions and worker tokens |
   | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | one store | persistence |
   | `BLOB_READ_WRITE_TOKEN` | one store | persistence (alternative) |
   | `CRON_SECRET` | recommended | authorises the cron sweep |
   | `PUBLIC_BASE_URL` | if custom domain | origin the worker chains to |

4. **Deploy.** `vercel.json` already sets the function durations (60s for the
   tick, stream, connection test and campaign endpoints) and registers the
   cron sweep `GET /api/tick?sweep=1`.

5. **Verify** `GET /api/health` returns `"status": "ok"` with no warnings, then
   sign in and connect a mailbox.

> **Hobby plan:** Vercel limits Hobby accounts to one cron run per day, so the
> sweep is scheduled at `0 3 * * *`. The sweep is only the backstop — the worker
> chains itself from tick to tick, and the open dashboard sends a revive
> heartbeat every two minutes. On Pro, tighten it to `0 * * * *` for a campaign
> that can recover within the hour even with nobody watching.

> Rotating `SECRET_KEY` invalidates every stored credential and every session.
> Re-enter the mailbox password afterwards.

### Gmail / Google Workspace and Microsoft 365

Both require an **app password** (Gmail) or **SMTP AUTH enabled** (M365) —
the account's normal password will be rejected by the provider. The connection
screen detects the provider from the address and fills in the servers; the test
step tells you exactly which of the two failed and why.

---

## API

Every endpoint is `POST` with a JSON body `{ "action": "...", ... }` unless
noted, and every one except `auth:login` and `health` requires the session
cookie set at login. Responses are JSON; errors are `{ "error": "..." }` with a
matching status.

| Endpoint | Actions |
| --- | --- |
| `/api/auth` | `login` `logout` `session` |
| `/api/connection` | `discover` `test` `save` `recheck` `get` `disconnect` `providers` |
| `/api/campaign` | `create` `list` `get` `recipients` `preflight` `preview` `control` `analytics` `delete` `suppress` |
| `/api/campaign` → `control` | `start` `pause` `resume` `stop` `retry-failed` |
| `/api/upload` | attachment upload (default action), `delete` |
| `/api/settings` | `get` `save` `suppression-list` `suppression-add` |
| `/api/stream?id=<campaignId>` | `GET`, `text/event-stream`; frames carry the full authoritative campaign state |
| `/api/tick` | `GET`/`POST`; worker only — authorised by a campaign-scoped worker token, the cron header/`CRON_SECRET`, or a live session |
| `/api/health` | `GET`; store driver, configuration checks, active campaigns, warnings |

No response body ever contains an SMTP or IMAP password, a token, or the secret
key — `_view.js` projects every stored object before it leaves the server.

---

## Pacing

Pacing is the part most likely to get a domain in trouble, so it is worth being
precise about what the code does.

`nextDelay()` draws a fresh random gap before **every** message. The draw is not
uniform — a flat distribution over 5s–2m produces a suspiciously even rhythm
where every gap is equally likely. Real sending is bursty: mostly quick, with
the occasional pause. `GAP_BUCKETS` reproduces that shape:

| Gap | Share | Reads as |
| --- | --- | --- |
| 5–10s | 55% | follows straight on |
| 10–30s | 25% | a short pause |
| 30s–1m20 | 15% | a longer one |
| 1m20–2m | 5% | rarely, near the ceiling |

Mean gap ~22s, so roughly 160 messages/hour. Bucket bounds are expressed against
the canonical 5s–2m window and rescaled to whatever window is configured, so a
custom min/max keeps the same shape. `expectedDelay()` derives the mean from the
same table — every duration estimate in the app reads from it rather than
assuming a midpoint.

Rolling caps sit on top: **200/hour** and **1500/day** by default, chosen to sit
above the distribution's natural ~160/hour so the cap does not fight the pacing,
and below Google Workspace's 2,000/day. Free consumer Gmail is 500/day, and a
domain with no sending history should be warmed up well below either — both are
editable in Settings. When a cap binds, the campaign reports `blocked` with the
time it will resume rather than pushing through.

The window is visible in three places: the **Sending gap** row on the dashboard
identity card, the countdown on the live monitor, and the sample campaign, which
names the gap it actually drew (“waiting 8s, drawn at random (mostly 5–10s, up
to 2m)”). All three read the same settings.

This is self-restraint, not evasion. It exists to stay comfortably inside what a
provider already permits — when the provider itself returns a limit or an error,
the worker backs off and surfaces the reason verbatim rather than working around
it.

## Security notes

- Credentials are sealed with AES-256-GCM using a key derived from `SECRET_KEY`;
  the ciphertext is what lands in the store.
- Sessions are HMAC-signed, expire after 8 hours, and are checked server-side on
  every request.
- Worker tokens are scoped to a single campaign id, so a leaked token cannot
  drive another campaign.
- A send mutex (atomic in Redis, lease-based otherwise) prevents two overlapping
  chains from sending the same message twice.
- Static responses set `X-Frame-Options`, `nosniff`, `no-referrer` and a
  restrictive `Permissions-Policy`; the console is `noindex, nofollow`.
