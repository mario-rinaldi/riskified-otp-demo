# Riskified OTP demo — pre-auth sync decide, Review original flow

A local harness for demoing the OTP recovery flow end to end: a stand-in merchant
checkout on the left, a live console on the right showing every request, header,
signature and decision as it happens.

## Why there's a server

The page can't call Riskified directly. Requests are authenticated with an
HMAC-SHA256 signature computed over the raw request body using the shop auth
token, so putting the token in client-side JavaScript would expose it, and the
API doesn't serve CORS headers to a page origin. The Express server signs and
forwards; the browser only talks to `localhost`.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. The sandbox credentials are already in
`.env.example`, so this runs as-is.

To rehearse with no network at all:

```bash
SIMULATE=true npm start
```

## The flow

1. **Add funds** → `POST https://sandbox.riskified.com/api/decide`, signed, with
   headers `api-version: 2`, `X-RISKIFIED-SHOP-DOMAIN: otp-recover.demo` and
   `X-RISKIFIED-HMAC-SHA256`.
2. If the response carries a challenge token, the page loads
   `https://otp-sandbox.self-veri.com/otp-widget-sdk.js` and calls
   `window.Riskified.renderOTPWidget(token, onSuccess, onTimeout)`.
3. The widget runs in an iframe and posts back a `challengeAccessToken` on
   success, or fires the timeout callback if the customer runs out of time.
4. On success the page sends a **second** `/decide` carrying that token, and the
   verdict from that call is the final answer.

Ticking **Trigger an OTP challenge** prefixes `otp` onto
`billing_address.first_name` (and `customer.first_name`, so the payload stays
internally consistent), which is what the sandbox keys off.

## Payment methods

The toggle switches `payment_details` between the ACH block and a card block.
**The card details are a placeholder** — `cardPaymentDetails()` in
`public/app.js` is a single function to swap out when the real card payload
arrives. `gateway` and `line_items[].product_id` switch with it.

## What comes from the page vs what's fixed

Sourced from the checkout: amount (`total_price` and `line_items[].price`),
email (order and customer), phone (written to **both** phone fields so whichever
one the OTP service reads gets the same number), the OTP first-name flag,
`client_details` from the live browser, and `created_at` / `delivered_at` as real
timestamps. Order `id` is a fresh `crypto.randomUUID()` per attempt, with `name`
mirroring it, so repeat runs never collide.

Everything else is fixed in the `FIXED` object at the top of `public/app.js` —
addresses, customer profile, KYC block, notes, ACH account details, browser IP,
cart token.

## Known gap

`attachChallengeToken()` in `public/app.js` puts the challenge access token at
`order.challenge_access_token` on the second `/decide`. The widget SDK doesn't
document where it belongs and the integration guide is behind a crawler block,
so **this is a guess** — it's isolated in one function, change it there.

To help, `findChallengeToken()` logs the path it found the inbound token at, so
the first live run tells you what the response shape actually is.

## Files

| File | What's in it |
|---|---|
| `config.js` | Endpoint paths, base URLs, credentials, SDK URL. |
| `server.js` | Signing, proxying, webhook verification, SSE, simulator. |
| `public/app.js` | Payload building, decide calls, OTP handling. |
| `public/index.html` | Storefront, console, OTP modal. |
| `public/styles.css` | Brand styling. |

Two details worth knowing before you change the markup: the OTP container must
keep `id="otp-widget"` because the SDK looks it up by that exact id, and it needs
an explicit height — the injected iframe is `height:100%`, so a container with no
height renders a widget zero pixels tall.

## Verification status

The simulator path, HMAC signing, the proxy and the OTP branching are all tested.
The live sandbox call is **not** — the machine this was built on can't reach
`sandbox.riskified.com`. First run against the real endpoint is the real test,
and the call log shows the full request and response for whatever comes back.
