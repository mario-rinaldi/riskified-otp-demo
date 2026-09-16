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
- `public/app.js` — payload construction and the OTP widget lifecycle.

## Flow

1. `POST /api/decide` on `sandbox.riskified.com`, signed, with headers
   `api-version: 2`, `X-RISKIFIED-SHOP-DOMAIN`, `X-RISKIFIED-HMAC-SHA256`.
2. If the response carries a challenge token, the page calls
   `window.Riskified.renderOTPWidget(token, onSuccess, onTimeout)`.
3. On success the widget returns a `challengeAccessToken`.
4. A second `/decide` carries that token; its verdict is final.

## Constraints — do not break these

- The OTP container must keep `id="otp-widget"`. The SDK does a
  `getElementById` on that literal string and bails otherwise.
- That container needs an explicit height. The injected iframe is `height:100%`,
  so a container with no height renders a widget zero pixels tall.
- The HMAC is computed over the exact serialized body. Anything that reformats
  JSON between signing and sending invalidates the signature — that's the first
  thing to check on a 401.
- Never commit `.env`.

## Known unknowns

- `attachChallengeToken()` in `public/app.js` places the challenge access token
  at `order.challenge_access_token` on the second `/decide`. This is inferred,
  not documented — the integration guide is behind a crawler block. If the
  second call misbehaves, start here.
- `cardPaymentDetails()` is a placeholder. The real card payload is pending.

## Conventions

- Vanilla JS, no build step, no framework. Keep it that way — the value of this
  demo is that anyone can read the whole thing in one sitting.
- Values that must stay fixed live in the `FIXED` object at the top of
  `public/app.js`. Only add there; don't scatter constants.
- Styling follows Riskified brand: sentence case, no italics, no all-caps,
  rounded corners, blue `#5A4CFF` for interactive elements only.
