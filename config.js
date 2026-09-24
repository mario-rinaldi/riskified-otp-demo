/**
 * Endpoint + credential configuration.
 *
 * Flow strategy: pre-auth synchronous /decide, with the OTP challenge handled
 * by Riskified's OTP widget in the browser (Review — original flow).
 */

const env = process.env;

const config = {
  // ---- Credentials -------------------------------------------------------
  shopDomain: env.RISKIFIED_SHOP_DOMAIN || "otp-recover.demo",
  authToken: env.RISKIFIED_AUTH_TOKEN || "bb32b9210dc18174119ae412053c0d44",

  // ---- Base URLs ---------------------------------------------------------
  syncBase: env.RISKIFIED_SYNC_BASE || "https://sandbox.riskified.com",
  asyncBase: env.RISKIFIED_ASYNC_BASE || "https://sandbox.riskified.com",

  // Sent as the `api-version` header on every call.
  apiVersion: env.RISKIFIED_API_VERSION || "2",

  // The OTP widget SDK. Loaded by the page, not by this server.
  otpSdkUrl:
    env.RISKIFIED_OTP_SDK_URL ||
    "https://otp-sandbox.self-veri.com/otp-widget-sdk.js",

  // The Beacon. Loaded by the page, not by this server. It collects the device
  // and behavioural signals behind the session id that rides along as
  // `cart_token` on every API call.
  beaconUrl: env.RISKIFIED_BEACON_URL || "https://beacon.riskified.com",

  // OTP recovery lives on its own host, not on the /decide host.
  otpBase: env.RISKIFIED_OTP_BASE || "https://otp-sandbox.self-veri.com",

  // Body fields for /otp/initiate that don't vary per order.
  otp: {
    // en-US, es-ES and fr-FR are the only values the API accepts.
    localizationLanguage: env.RISKIFIED_OTP_LANGUAGE || "en-US",
    // The merchant support address shown in the widget.
    contactDetails: env.RISKIFIED_OTP_CONTACT || "support@otp-recover.demo",
    // Appears as the sender name in the SMS. 'Sms' is the only channel today.
    senderName: env.RISKIFIED_OTP_SENDER || "Prediction Market",
    channelType: "Sms",
  },

  // ---- Behaviour ---------------------------------------------------------
  // simulate=true short-circuits every call, including the OTP challenge.
  simulate: String(env.SIMULATE || "false").toLowerCase() === "true",

  verifyWebhookHmac:
    String(env.VERIFY_WEBHOOK_HMAC || "true").toLowerCase() === "true",

  port: Number(env.PORT || 3000),
};

/**
 * `sync: true` means the response body carries the decision itself.
 * /decide is the only call this demo needs; the rest are here so lifecycle
 * notifications can be added without touching anything but this object.
 */
const ACTIONS = {
  decide: { path: "/api/decide", sync: true, label: "Decision requested" },
  /**
   * Called from the backend after /decide returns declined with an OTP
   * recommendation. Sends the SMS and returns `{ widgetToken }` — the JWT the
   * browser hands to renderOTPWidget(). Different host from /decide, and it
   * wants an Accept header instead of `api-version`.
   */
  otp_initiate: {
    path: "/recover/v1/otp/initiate",
    host: "otp",
    sync: true,
    label: "OTP initiated",
    accept: "application/vnd.riskified.com; version=2",
  },
  checkout_denied: {
    path: "/api/checkout_denied",
    sync: false,
    label: "Checkout denied",
  },
  decision: {
    path: "/api/decision",
    sync: false,
    label: "Merchant decision reported",
  },
  cancel: { path: "/api/cancel", sync: false, label: "Order cancelled" },
  fulfill: { path: "/api/fulfill", sync: false, label: "Order fulfilled" },
  refund: { path: "/api/refund", sync: false, label: "Order refunded" },
  chargeback: {
    path: "/api/chargeback",
    sync: false,
    label: "Chargeback reported",
  },
};

module.exports = { config, ACTIONS };
