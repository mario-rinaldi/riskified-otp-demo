/**
 * Endpoint + credential configuration.
 *
 * Flow strategy: pre-auth synchronous /decide, with the OTP challenge handled
 * by Riskified's OTP widget in the browser (Review — original flow).
 */

const env = process.env;

const config = {
  // ---- Credentials -------------------------------------------------------
  shopDomain: env.RISKIFIED_SHOP_DOMAIN || 'otp-recover.demo',
  authToken: env.RISKIFIED_AUTH_TOKEN || '',

  // ---- Base URLs ---------------------------------------------------------
  syncBase: env.RISKIFIED_SYNC_BASE || 'https://sandbox.riskified.com',
  asyncBase: env.RISKIFIED_ASYNC_BASE || 'https://sandbox.riskified.com',

  // Sent as the `api-version` header on every call.
  apiVersion: env.RISKIFIED_API_VERSION || '2',

  // The OTP widget SDK. Loaded by the page, not by this server.
  otpSdkUrl: env.RISKIFIED_OTP_SDK_URL || 'https://otp-sandbox.self-veri.com/otp-widget-sdk.js',

  // ---- Behaviour ---------------------------------------------------------
  // simulate=true short-circuits every call, including the OTP challenge.
  simulate: String(env.SIMULATE || 'false').toLowerCase() === 'true',

  verifyWebhookHmac: String(env.VERIFY_WEBHOOK_HMAC || 'true').toLowerCase() === 'true',

  port: Number(env.PORT || 3000),
};

/**
 * `sync: true` means the response body carries the decision itself.
 * /decide is the only call this demo needs; the rest are here so lifecycle
 * notifications can be added without touching anything but this object.
 */
const ACTIONS = {
  decide: { path: '/api/decide', sync: true, label: 'Decision requested' },
  checkout_denied: { path: '/api/checkout_denied', sync: false, label: 'Checkout denied' },
  decision: { path: '/api/decision', sync: false, label: 'Merchant decision reported' },
  cancel: { path: '/api/cancel', sync: false, label: 'Order cancelled' },
  fulfill: { path: '/api/fulfill', sync: false, label: 'Order fulfilled' },
  refund: { path: '/api/refund', sync: false, label: 'Order refunded' },
  chargeback: { path: '/api/chargeback', sync: false, label: 'Chargeback reported' },
};

module.exports = { config, ACTIONS };
