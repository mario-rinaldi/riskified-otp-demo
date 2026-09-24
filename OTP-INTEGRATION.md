# OTP recovery — integration guide

This assumes you have already integrated `/decide` and the Beacon. Nothing here
repeats HMAC signing, the shop-domain header or Beacon setup; the OTP flow reuses
all of it unchanged.

What is new is everything after a decline. This guide covers the recovery flow
end to end, how to force one in the sandbox, and the things that cost us time.

Every example is live in this repo — `public/app.js` for the browser half,
`server.js` and `config.js` for the signed calls.

## What OTP recovery is

A declined order is not always fraud. Some declines are a good customer who looks
wrong — new device, unusual amount, travel. OTP recovery gives that customer one
chance to prove they hold the phone on the account: Riskified sends an SMS, a
hosted widget collects the code, and the order can go through after all.

The important mental shift: **a decline is no longer a terminal state.** Some
declines carry an offer to recover, and if you treat every `declined` as final
you will never see the flow.

## The sequence

```
1.  POST /api/decide                    sandbox.riskified.com
    -> declined + advice.recommendations[{type:"otp", recommended:true}]

2.  you generate a challenge_access_token (UUID)

3.  POST /recover/v1/otp/initiate       otp-sandbox.self-veri.com   [backend]
    -> { "widget_token": "<JWT>" }      and an SMS goes out

4.  RISKX-style SDK renders the widget  [browser]
    window.Riskified.renderOTPWidget(widget_token, onSuccess, onTimeout)

5.  widget handles /details, /verify, /resend internally
    -> onSuccess(challengeAccessToken)  the same token you minted in step 2

6.  validate the echoed token, then let the order through
```

Two hosts are involved. `/decide` is on `sandbox.riskified.com`; everything OTP
is on `otp-sandbox.self-veri.com`. Production is `otp.self-veri.com`.

## Step 1 — recognise a recoverable decline

A recoverable decline looks like this:

```json
{
  "order": {
    "id": "112f5276-d56b-4ec1-8455-a47ee522b35a",
    "status": "declined",
    "description": "Order exhibits strong fraudulent indicators",
    "old_status": "created",
    "category": "Fraudulent",
    "advice": {
      "recommendations": [
        { "type": "otp", "recommended": true }
      ]
    }
  }
}
```

Gate on the recommendation, not on a token:

```js
function otpRecommended(body) {
  const recommendations = body?.order?.advice?.recommendations;
  if (!Array.isArray(recommendations)) return false;
  return recommendations.some(
    (r) => String(r?.type).toLowerCase() === 'otp' && r?.recommended === true
  );
}
```

**There is no token anywhere in this response.** If you are looking for one you
will not find it, and the flow will silently never start. `advice.recommendations`
is a shared array — `three_ds` and `psd2` recommendations arrive the same way —
so always check `type`.

## Step 2 — generate the challenge access token

This token is **yours, not Riskified's**. You mint it, send it to `/otp/initiate`,
and the widget hands the same value back when the customer passes. Comparing the
two is what stops a passed OTP being paired with a different order.

```js
const challengeAccessToken = crypto.randomUUID();
```

Requirements: at least 32 characters and hard to guess. A UUID is 36 and is what
Riskified recommends. Shorter values are rejected:

```
400  "Bad request: Invalid challenge access token length,
      access token must be at least 32 characters long"
```

## Step 3 — call /otp/initiate from your backend

This is a signed, server-side call. It sends the SMS and returns the JWT the
widget needs.

```
POST https://otp-sandbox.self-veri.com/recover/v1/otp/initiate
```

Headers — signed exactly like `/decide`, with one difference:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `application/vnd.riskified.com; version=2` |
| `X-RISKIFIED-SHOP-DOMAIN` | your shop domain |
| `X-RISKIFIED-HMAC-SHA256` | HMAC-SHA256 of the raw body, same auth token |

**The OTP host versions itself through `Accept`, not `api-version`.** That is the
one header difference from `/decide`. Send `api-version` here and you are relying
on undefined behaviour.

Body:

```json
{
  "id": "112f5276-d56b-4ec1-8455-a47ee522b35a",
  "challenge_access_token": "0b1f6e2c-9a4d-4f77-8c31-5a2be7d40f19",
  "localization_language": "en-US",
  "contact_details": "support@your-shop.com",
  "channel_method": {
    "channel_type": "Sms",
    "sender_name": "Your Shop"
  }
}
```

- `id` must be the order id Riskified decided on. It is looked up server-side; a
  mismatch gives a 404.
- `localization_language` accepts `en-US`, `es-ES`, `fr-FR`. Ask your integration
  engineer for more.
- `channel_type` is `Sms` only today, and it is case-sensitive.
- `contact_details` is your support address, shown inside the widget.

Response:

```json
{ "widget_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

**It is `widget_token`, snake_case.** The published OpenAPI example shows
`widgetToken` and it is wrong. This cost us a full debugging cycle: the call
returned HTTP 200 with a perfectly good JWT and our code reported failure because
it read the camelCase key. Read both if you want to be safe.

The JWT is bound to the order and lives 20 minutes:

```json
{ "shopUrl": "your-shop.com", "entityType": "Order",
  "entityId": "112f5276-...", "iat": 1789579385, "exp": 1789580585 }
```

Errors worth handling:

| Status | Meaning |
|---|---|
| 400 | Token under 32 chars, order not eligible, or eligibility window expired |
| 401 | HMAC wrong — check it covers the exact serialized body |
| 403 | Order has already been through recovery |
| 404 | Order id not found for this shop domain |
| 500 | Server-side fault — capture the `Trace-Id` response header |

## Step 4 — render the widget

Load the SDK once, in the page head:

```
sandbox     https://otp-sandbox.self-veri.com/otp-widget-sdk.js
production  https://otp.self-veri.com/otp-widget-sdk.js
```

Both 301-redirect to S3. If you run a strict Content-Security-Policy, allow the
S3 origin in `script-src` as well, or the SDK will never load.

The SDK is about fifteen lines and exposes exactly one function:

```js
window.Riskified.renderOTPWidget(widget_token, onSuccess, onTimeout);
```

It injects an iframe into an element found by `getElementById('otp-widget')`,
listens for `postMessage` from the widget origin, and calls `onSuccess` or
`onTimeout`. That is the whole surface.

Two constraints that are easy to get wrong:

```html
<div id="otp-widget"></div>
```

- **The id must be exactly `otp-widget`.** The SDK does a `getElementById` on that
  literal string and bails with a console error if it is missing. Renaming it to
  fit your CSS conventions breaks the widget.
- **The container needs an explicit height.** The injected iframe is `height:100%`,
  so a container with no height renders a widget zero pixels tall — it loads
  correctly and you see nothing.

The session is 20 minutes, matching the JWT. `onTimeout` fires when it lapses.

## Step 5 — on success

`onSuccess` receives the challenge access token you minted in step 2. Validate it
before doing anything else:

```js
function onOtpSuccess(challengeAccessToken) {
  if (challengeAccessToken !== expectedChallengeToken) {
    // Do not approve. This success belongs to a different order.
    return;
  }
  // Let the order through.
}
```

Skipping this check defeats the point of the token.

**What happens next is the one genuinely unsettled part of this flow.** The web
implementation guide says `/verify`, `/resend` and `/details` are handled inside
the widget, and that on success the merchant should "verify that the token is
valid and proceed with order checkout". It never mentions calling `/decide` again.

This demo does send a second `/decide` carrying `order.challenge_access_token`,
because the point on screen is a Riskified-approved order. That placement is
inferred, not documented. If your second call comes back declined, treat the
widget's success as the recovery signal and stop there.

## Forcing an OTP challenge in the sandbox

This is the part that wastes the most time, because **two separate services have
to agree** and they key off different words.

| Service | Decides | Triggers on |
|---|---|---|
| Decision rules | approve or decline | `decline`, `considerable`, `highrisk` |
| Eligibility | whether OTP is offered | `otp` in `order.email` or `billing_address.first_name` |

An order carrying only `otp` comes back **approved** with an OTP recommendation
attached — and an approved order has nothing to recover. That dead end looks
exactly like a broken integration. You need both words in the same payload.

Two recipes:

**Split fields** — keeps the email you are testing with intact:

```json
"billing_address": {
  "first_name": "otpMichael",
  "last_name": "considerable"
}
```

Write the same values to `customer.first_name` and `customer.last_name` so the
payload stays internally consistent. `considerable` and `highrisk` decline at
different severities.

**Email only** — one field does both jobs:

```json
"email": "decline.otp@test.com"
```

`decline` satisfies the decision rules, standalone `otp` satisfies eligibility.

Either way you should get `status: "declined"` with the recommendation array.

## Things that will bite you

- **`widget_token`, not `widgetToken`.** The docs are wrong.
- **No token in the decide response.** Gate on the recommendation.
- **`Accept` header on the OTP host**, not `api-version`.
- **`otp` alone gets you an approved order**, not a recoverable one.
- **The container id is load-bearing** and needs a height.
- **The eligibility window expires.** Initiate promptly after the decline.
- **One recovery per order.** A second attempt returns 403.
- **`cart_token` should carry the Beacon session id** — same as your existing
  integration. Nothing about OTP changes that.

## Debugging

**The docs are reachable**, despite the crawler block on the integration guide.
`https://developers.riskified.com/llms.txt` indexes every page, and appending
`.md` to any doc URL returns its markdown, OpenAPI definitions included:

```bash
curl -s https://developers.riskified.com/llms.txt | grep -i otp
curl -s https://developers.riskified.com/reference/otp-initiate.md
```

**The widget is cross-origin.** Its console output and network calls never reach
your page, so nothing you log will capture them. Use the browser Network tab and
filter on `self-veri` — iframe requests do show up there.

**A generic "Something went wrong" in the widget** means one of two things: the
token failed to decode at mount, or one of its own API calls failed. Both render
the same screen. Check the Network tab for the `/details` and `/verify` calls.

**Test the backend directly** when the widget misbehaves. The widget authenticates
with a plain bearer token, so you can reproduce its calls with curl:

```bash
curl -s https://otp-sandbox.self-veri.com/recover/v1/otp/details \
  -H "Authorization: Bearer <widget_token>"
```

A 200 here means the backend and your token are fine and the problem is in the
browser.

**`enableRiskxDebug()`** in the console prints Beacon state. It is Beacon-only and
tells you nothing about the OTP widget — worth knowing so you do not go looking.

## Where things are in this repo

| File | What is in it |
|---|---|
| `public/app.js` | `otpRecommended()`, `beginOtpRecovery()`, `startOtp()`, `onOtpSuccess()`, `attachChallengeToken()` |
| `config.js` | Every host and path, including `otp_initiate` and its `Accept` override |
| `server.js` | HMAC signing, the signed proxy, and a simulator that reproduces both sandbox services |
| `public/index.html` | The `#otp-widget` container and the demo controls |

Run `SIMULATE=true npm start` to walk the whole flow offline, including the
approved-with-recommendation dead end.

## Known open issue

As of 2026-09-16, `POST /recover/v1/otp/verify` returns
`500 "There was an internal server error."` in the sandbox when the **correct**
code is entered. A wrong code returns a clean invalid-code response, so
verification itself works and the step after it throws.

This is upstream, not an integration mistake. The call goes from the widget iframe
straight to Riskified, so your server is not in the path. If you hit it, capture
the `Trace-Id` and `Cf-Ray` response headers and raise it with your integration
engineer.
