# Riskified OTP demo

Local demo harness for Riskified's pre-auth synchronous decision flow with OTP
recovery (Review — original flow). Sandbox only.

## Architecture

- `server.js` — Express. Signs request bodies with HMAC-SHA256 and forwards to
  Riskified. The browser never talks to Riskified directly: the auth token must
  not reach client-side JS, and the API doesn't serve CORS headers to a page
  origin.
- `config.js` — every endpoint path, base URL and credential. Nothing else in
  the codebase hardcodes a path.
- `public/app.js` — payload construction, the Beacon, and the OTP widget
  lifecycle.

## Beacon

`loadBeacon()` in `public/app.js` injects `beacon.riskified.com?shop=<domain>`
and listens for `rskx_ready`, whose `event.detail.sessionId` becomes
`order.cart_token` on every signed call. That id is the only link between the
signals the Beacon gathers in the browser and the order the server submits.

- Subscribe to `rskx_ready` **before** inserting the script. It fires once and
  is guarded by a flag, so a listener added later never hears it.
- The shop domain comes from `/config`, not the markup, so it can't drift from
  the `X-RISKIFIED-SHOP-DOMAIN` header the proxy signs with.
- `cartToken()` falls back to `FIXED.cartToken` when the Beacon hasn't reported
  yet, failed, or is off. Skipped entirely under `SIMULATE=true`.

## Flow

1. `POST /api/decide` on `sandbox.riskified.com`, signed, with headers
   `api-version: 2`, `X-RISKIFIED-SHOP-DOMAIN`, `X-RISKIFIED-HMAC-SHA256`.
2. A recoverable decline comes back as `status: "declined"` **plus**
   `order.advice.recommendations` containing `{type: "otp", recommended: true}`.
   There is no token in this response.
3. The page generates a `challenge_access_token` (UUID, min 32 chars) and posts
   `POST /recover/v1/otp/initiate` on `otp-sandbox.self-veri.com` — a different
   host, signed the same way but versioned through `Accept:
   application/vnd.riskified.com; version=2` instead of `api-version`. This
   sends the SMS and returns `{ widget_token }` — snake_case, despite the
   published OpenAPI example showing `widgetToken`. The JWT is bound to the
   order id and expires 20 minutes after issue.
4. The page calls `window.Riskified.renderOTPWidget(widgetToken, onSuccess,
   onTimeout)`.
5. On success the widget hands back the same `challengeAccessToken` we minted.
6. A second `/decide` carries that token; its verdict is final.

## Constraints — do not break these

- The OTP container must keep `id="otp-widget"`. The SDK does a
  `getElementById` on that literal string and bails otherwise.
- That container needs an explicit height. The injected iframe is `height:100%`,
  so a container with no height renders a widget zero pixels tall.
- The HMAC is computed over the exact serialized body. Anything that reformats
  JSON between signing and sending invalidates the signature — that's the first
  thing to check on a 401.
- Never commit `.env`.

## Sandbox triggers

Two services key off different words, and a recoverable order needs both:

- Decision rules decline on `decline`, `considerable` or `highrisk`.
- Eligibility recommends OTP on `otp` in `order.email` or
  `billing_address.first_name`.

`otp` alone yields an **approved** order carrying an OTP recommendation, which
cannot be recovered. The recipes live in `FIXED.otpTrigger` in `public/app.js`;
the simulator reproduces both services, including that dead end.

## Known unknowns

- `attachChallengeToken()` in `public/app.js` places the challenge access token
  at `order.challenge_access_token` on the second `/decide`. The field name is
  confirmed — `/otp/initiate` uses it too — but its placement on the decide
  payload is still inferred. If the second call misbehaves, start here.
- **The second `/decide` may not be part of the real flow.** The web
  implementation guide says `/otp/verify`, `/otp/resend` and `/otp/details` are
  handled inside the widget, and that on success the merchant should "verify
  that the token is valid and proceed with order checkout" — it never mentions
  calling `/decide` again. This demo still does, because the on-screen point is
  a Riskified-approved order. If that second call comes back declined, the
  widget's success is the actual recovery signal and the demo should stop
  there.
- `submission_reason` is sent on the card path only, because that's the one
  payload we were given that carries it. It probably belongs on ACH too — not
  confirmed.

## Conventions

- Vanilla JS, no build step, no framework. Keep it that way — the value of this
  demo is that anyone can read the whole thing in one sitting.
- Values that must stay fixed live in the `FIXED` object at the top of
  `public/app.js`. Only add there; don't scatter constants.
- Styling follows Riskified brand: sentence case, no italics, no all-caps,
  rounded corners, blue `#5A4CFF` for interactive elements only.
