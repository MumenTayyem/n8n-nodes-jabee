# n8n-nodes-jabee

Ask a person on WhatsApp before your workflow does something irreversible,
and send alerts from any workflow, without owning a WhatsApp number.

Two nodes and one credential:

| Node | What it does |
|---|---|
| **Jabee** | Request an approval and optionally wait for the tap; send an alert; read, revise, cancel or report the outcome of a request; check in to a heartbeat |
| **Jabee Trigger** | Starts a workflow when somebody answers, when a request expires or fails, or when the verified handset types something back |

The number and the Meta-approved template belong to Jabee, so there is no
WhatsApp Business account to open, no number to register, and no template to
submit. The trade that makes that possible: it reaches **your own people**,
not your customers. Delivery goes to one handset the business verified, or
the account owner's phone. A shared sender messaging strangers is what gets
numbers banned, so it cannot do that. To reach customers you connect your own
number, which is a different Jabee product.

## Installing

Self-hosted n8n: **Settings → Community nodes → Install**, then
`n8n-nodes-jabee`.

## The credential

One credential, `Jabee API`, used by both nodes.

| Field | Where it comes from |
|---|---|
| **API Key** | app.jabee.ai → Management → Approvals → create a key. Begins `jak_`, shown once. |
| **Webhook Signing Secret** | Beside the webhook address on the same page. Begins `whsec_`. Only the trigger reads it; leave it empty if you are not using the trigger. |
| **Base URL** | `https://api.jabee.ai/api/v1`. Change it only to point at another Jabee deployment. |

Before anything can be delivered, whoever is going to be messaged needs a
verified phone: app.jabee.ai → Alerts → **Where alerts go**, then tap the
link and send one message from the handset.

Pressing **Test** on the credential lists one approval. It messages nobody.

## Jabee node

### Approval → Request

| Field | Notes |
|---|---|
| Title | Required, at most 120 characters. Longer is refused, not trimmed. |
| Body | At most 2000 characters. Sent verbatim; Jabee reads none of it. |
| Buttons | One to three of Approve, Skip, Edit. Default Approve and Skip. |
| Wait for the Answer | Polls until somebody answers or the timeout runs out |
| Wait Timeout | 5 to 3600 seconds, default 900 |
| External ID | Your own ID. The same one twice returns the request already made. |
| Link | A full http or https address |
| Expires In | 5 minutes to a week, default 1440 minutes |
| Metadata | A JSON object, at most 16KB, handed back unchanged on every read and on the webhook |

The output is the request: `id`, `status`, `round`, `title`, `body`, `url`,
`options`, `external_id`, `metadata`, `response_text`, `responded_at`,
`responded_by`, `delivered_via`, `outcome`, `outcome_note`, `outcome_at`,
`cancelled_at`, `cancel_reason`, `expires_at`, `created_at`, `updated_at`,
plus `existing`.

`status` is one of `pending`, `approved`, `skipped`, `edited`, `expired`,
`failed`, `cancelled`.

Three things worth knowing.

**Delivery happens before the response returns.** A request that reached
nobody comes back `failed` straight away, so waiting on it is pointless and
the node does not.

**Edit is one-way.** Words typed into Edit arrive in `response_text` and
close the request as `edited`. Nothing is said back on the WhatsApp thread.
If the person asked a question there, answer it with **Revise**, which puts
the amended request to them again.

**`existing: true`** means the External ID matched a request already made,
and the message was not sent again, whatever its status. Use a new External
ID to ask a second time.

### Approval → Get, Get Many, Revise, Cancel, Report Outcome

**Get Many** filters on status and on *Changed Since*, oldest first. Return
All pages on the last `updated_at` it saw, because the API has no cursor.

**Revise** needs at least one of Title, Body or Link, and only works on a
request answered with Edit. Five rounds at most, and each one costs what a
new request costs.

**Cancel** works from `pending` or `edited`. Repeating it is a success.

**Report Outcome** is how Jabee learns whether the approved thing actually
happened. `outcome` is your own word, 1 to 40 characters of `a-z`, `0-9` and
`_`. It does not move `updated_at`, so a *Changed Since* poll is not handed
back a request it has already acted on.

### Alert → Send

The same call with the question taken out: no buttons, nothing to answer.
Title, Body, and the same additional fields.

### Heartbeat → Check In

For the failure a push-only alert cannot see: the workflow that stopped
running at all. Each run checks in; if a check-in does not arrive by its
deadline, Jabee raises one alert.

| Field | Notes |
|---|---|
| Name | 1 to 60 characters of `a-z`, `0-9`, `-` and `_`, starting with a letter or digit. 20 checks per account. |
| Every | How often the workflow runs: `90s`, `15m`, `2h`, `1d`, or plain seconds. Required on the first check-in. |
| Grace | How late a run may be. Nothing set means no grace. |
| Alert on Recovery | Off by default: a recovery doubles what an outage costs against the allowance. |

The first check-in registers the check. Later ones may leave **Every** out
and the stored schedule is kept, so a second workflow checking in to the same
name cannot silently re-time somebody else's.

## Jabee Trigger node

Jabee's webhook address is one setting on the account, so **this trigger
cannot register itself** — there is no API for it, by design: a `jak_` key
that could repoint where answers are delivered would be worth far more to
somebody who stole it than the messages it can send.

1. Activate the workflow and copy the **Production URL**.
2. Paste it into app.jabee.ai → Management → Approvals, as the webhook
   address.
3. Copy the `whsec_` secret shown there into **Webhook Signing Secret** on
   the credential.

Without that secret the node refuses to run and says so. Every delivery is
verified: `X-Jabee-Signature: t=<unix>,v1=<hex>` is the HMAC-SHA256 of
`<t>.<raw body>`, checked over the raw bytes, compared in constant time, and
refused if the timestamp is more than five minutes from this machine's clock.

Events: `approval.answered`, `approval.expired`, `approval.failed`,
`message.received`, `approval.test`. Every event for the whole account
arrives at the one address, and the node answers the ones it was not asked
for with a 200 rather than a refusal — refusing would put Jabee's
eleven-hour retry ladder behind messages nobody wanted.

The item is the delivery as Jabee sent it: `id` (the delivery ID), `event`,
and then `approval` or, for `message.received`, `message` with `text`,
`from`, `received_at`, `about_approval_id` and `whatsapp_message_id`.
Delivery is at-least-once, so dedupe on `id` if the next step is not safe to
repeat.

`message.received` is the half with no counterpart elsewhere: words the
verified handset typed on the WhatsApp thread, which were not a button and
not a stop word. A reply from a phone can be an instruction.

## Limits, and the ones that will bite

- **One call per input item.** A node fed 40 rows sends 40 WhatsApp
  messages. Put a **Limit**, **Aggregate** or Code node in front of it.
  "14 payments failed overnight" is a better message than fourteen messages.
- **500 approvals and alerts a month** on the $29 plan, counted together,
  then 3 cents each. The first three are free, so this can be wired up and
  watched to arrive before anything is paid for.
- **200 new requests per account per 24 hours**, and **60 API calls a minute
  per key**. The minute limit is waited out and retried twice; the daily one
  is not, because it cannot be waited out inside an execution.
- **Three notices in a row with no tap and no reply** and Jabee stops
  sending to that handset, with an email to the account owner. Any message
  to the Jabee number starts it again.
- **120 characters on the title.** `{{ $json.subject.slice(0, 120) }}` if it
  is built from data you do not control.

## Example workflows

In `examples/`, importable as they are:

- **`refund-approval-on-whatsapp.json`** — a refund request arrives on a
  webhook; anything over the limit stops until somebody taps Approve, then
  the money moves and the outcome is reported back.
- **`approval-answered-trigger.json`** — the same job without holding an
  execution open: the trigger starts the workflow when the answer arrives,
  however many hours later.

## Developing

```
npm install
npm run typecheck   # tsc over the nodes, the credential and the tests
npm test            # vitest
npm run lint        # n8n's community-node lint, strict mode
npm run build       # tsc + copy the icons into dist
```

The nodes have **no runtime dependencies**, which n8n Cloud verification
requires: HTTP goes through `this.helpers.httpRequestWithAuthentication` and
the HMAC through `node:crypto`.

## Licence

MIT. Built by [M4B1](https://m4b1.com), Dubai, UAE.

WhatsApp is a trademark of Meta Platforms, Inc. Jabee is an independent
product and is not endorsed by or affiliated with Meta.
