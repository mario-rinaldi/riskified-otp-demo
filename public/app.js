/* Riskified OTP demo — page logic.
 *
 * Flow: pre-auth synchronous /decide. If the decision asks for an OTP challenge,
 * the hosted widget runs in an iframe; on success it hands back a
 * challengeAccessToken, which goes into a second /decide for the final answer.
 */

const $ = (id) => document.getElementById(id);

let serverConfig = {};
let currentOrderId = null;
let paymentMethod = 'ach';
let lastPayload = null;

const STEPS = [
  { key: 'cart', label: 'Checkout' },
  { key: 'decide', label: 'Decision requested' },
  { key: 'otp', label: 'OTP challenge' },
  { key: 'final', label: 'Final decision' },
];

let reached = new Set(['cart']);

// ---------------------------------------------------------------- payload ---

// Fields the guide says to keep fixed live here, so the parts that do vary are
// obvious at a glance.
const FIXED = {
  browserIp: '172.56.9.90',
  cartToken: 'd0c9f77c-5ab4-4add-a3d2-be95b44ab909',
  currency: 'USD',
  firstName: 'Michael',
  lastName: 'Scott',
  billingAddress: {
    address1: '220 5th Avenue',
    city: 'New York',
    country: 'US',
    country_code: 'US',
    province: 'NY',
    province_code: 'NY',
    zip: '10001',
  },
  customer: {
    account_type: 'registered',
    orders_count: 27,
    created_at: '2026-06-02T21:57:17.832Z',
    id: '10ebdfe4-fbe7-4b15-8a44-8b1813c5ebc0',
    date_of_birth: '1975-07-21T00:00:00Z',
    updated_at: '2026-06-13T19:07:15.384348Z',
    verified_email: true,
    verified_phone: true,
    verified_address: false,
    note: '{"wd_cnt":25,"days_last_wd":0,"ssn":true,"selfie_sent":true}',
    kyc_verified: true,
    kyc_details: [
      { kyc_verified: true, update_at: '2026-06-13T19:07:15Z', vendor_name: 'socure' },
    ],
    spending_limit: 200000,
    document_type: 'Drivers License',
    group_name: 'super_trust',
  },
  achPaymentDetails: [
    {
      type: 'bank',
      account_number: '00100000123456789',
      routing_number: '012000345',
      stored_payment_updated_at: '2026-06-07T15:39:42.430552Z',
      token: 'processor-production-abcdefgh-1234-1234-abcd-1234567890ab',
    },
  ],
  note: '{"cash_value":68.4588,"open_value":0,"active_contr":2,"risk_tier":"super_trust"}',
};

function newOrderId() {
  return crypto.randomUUID();
}

function buildOrder(orderId) {
  const now = new Date().toISOString();
  const amount = Number($('amount').value || 0);
  const email = $('email').value;
  const phone = $('phone').value;

  // The sandbox triggers the OTP challenge on "otp" appearing in the first name.
  const firstName = $('triggerOtp').checked
    ? 'otp' + FIXED.firstName
    : FIXED.firstName;

  const isAch = paymentMethod === 'ach';

  return {
    order: {
      id: orderId,
      name: orderId,
      source: 'desktop_web',
      total_price: amount,
      browser_ip: FIXED.browserIp,
      cart_token: FIXED.cartToken,
      created_at: now,
      currency: FIXED.currency,
      email,
      gateway: isAch ? 'plaid_ach' : 'demo_card_gateway',
      billing_address: {
        ...FIXED.billingAddress,
        first_name: firstName,
        last_name: FIXED.lastName,
        phone,
      },
      customer: {
        ...FIXED.customer,
        email,
        first_name: firstName,
        last_name: FIXED.lastName,
        phone,
      },
      client_details: {
        accept_language: navigator.language || 'en',
        user_agent: navigator.userAgent,
      },
      line_items: [
        {
          category: 'deposit',
          price: amount,
          product_id: isAch ? 'ach_deposit' : 'card_deposit',
          product_type: 'digital',
          quantity: 1,
          requires_shipping: false,
          title: 'Kalshi ACH Fund',
          delivered_at: now,
        },
      ],
      // Card block is a placeholder until the card payload lands — see README.
      payment_details: isAch ? FIXED.achPaymentDetails : cardPaymentDetails(),
      note: FIXED.note,
    },
  };
}

function cardPaymentDetails() {
  return [
    {
      type: 'card',
      credit_card_bin: '424242',
      credit_card_number: 'XXXX-XXXX-XXXX-4242',
      credit_card_company: 'Visa',
      avs_result_code: 'Y',
      cvv_result_code: 'M',
    },
  ];
}

/**
 * Where the challenge token goes on the second /decide.
 * This is the one field the SDK didn't tell us — confirm against the guide and
 * change it here only.
 */
function attachChallengeToken(payload, token) {
  return {
    ...payload,
    order: { ...payload.order, challenge_access_token: token },
  };
}

function payloadToSend(generated) {
  if (!$('useCustom').checked) return generated;
  try {
    return JSON.parse($('payload').value);
  } catch (err) {
    alert('The edited payload is not valid JSON:\n\n' + err.message);
    return null;
  }
}

function refreshPayloadPreview() {
  if ($('useCustom').checked) return;
  $('payload').value = JSON.stringify(
    buildOrder(currentOrderId || newOrderId()),
    null,
    2
  );
}

// ------------------------------------------------------------------ calls ---

async function call(action, body) {
  const res = await fetch(`/call/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function placeOrder() {
  const btn = $('placeOrder');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  try {
    currentOrderId = newOrderId();
    refreshPayloadPreview();

    const body = payloadToSend(buildOrder(currentOrderId));
    if (!body) return;
    lastPayload = body;

    const res = await call('decide', body);
    markStep('decide');
    handleDecision(res, false);
  } catch (err) {
    alert('Call failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add funds';
  }
}

function handleDecision(res, isFinal) {
  const body = res?.body || {};
  const status = String(body?.order?.status || body?.status || '').toLowerCase();
  const token = findChallengeToken(body);

  if (!isFinal && token) {
    markStep('otp');
    startOtp(token, Boolean(res.simulated));
    return;
  }

  markStep('final');
  applyDecision(status || 'unknown', body?.order?.description);
}

/**
 * The decide response carries the widget token somewhere. The exact field isn't
 * documented in the SDK, so check the likely spots and then fall back to a scan
 * for anything token-shaped. Whatever matched is written to the log, so the
 * real path is visible on the first live run.
 */
function findChallengeToken(body) {
  const candidates = [
    'order.authentication.challenge_token',
    'order.authentication.token',
    'order.challenge_token',
    'order.otp_token',
    'order.token',
    'authentication.challenge_token',
    'challenge_token',
    'token',
  ];

  for (const path of candidates) {
    const value = path.split('.').reduce((o, k) => (o == null ? o : o[k]), body);
    if (typeof value === 'string' && value.length > 6) {
      logLocal(`Challenge token found at ${path}`);
      return value;
    }
  }

  let found = null;
  (function scan(node, trail) {
    if (found || node == null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (found) return;
      const here = trail ? `${trail}.${k}` : k;
      if (typeof v === 'string' && /token/i.test(k) && k !== 'cart_token' && v.length > 6) {
        logLocal(`Challenge token found at ${here}`);
        found = v;
        return;
      }
      if (typeof v === 'object') scan(v, here);
    }
  })(body, '');

  return found;
}

// -------------------------------------------------------------------- OTP ---

function startOtp(token, simulated) {
  $('otpModal').classList.add('show');
  $('otpSub').textContent = `A code has been sent to ${$('phone').value}.`;

  if (simulated) {
    $('otpSimulated').style.display = 'block';
    $('otp-widget').style.display = 'none';
    return;
  }

  $('otpSimulated').style.display = 'none';
  $('otp-widget').style.display = 'block';

  if (!window.Riskified || typeof window.Riskified.renderOTPWidget !== 'function') {
    logLocal('OTP SDK did not load — window.Riskified.renderOTPWidget is unavailable.');
    alert('The OTP widget SDK failed to load. Check the network tab.');
    return;
  }

  logLocal('Rendering OTP widget');
  window.Riskified.renderOTPWidget(token, onOtpSuccess, onOtpTimeout);
}

async function onOtpSuccess(challengeAccessToken) {
  logLocal('OTP challenge passed — re-deciding with the challenge access token');
  closeOtp();

  const body = attachChallengeToken(lastPayload, challengeAccessToken);
  const res = await call('decide', body);
  handleDecision(res, true);
}

function onOtpTimeout() {
  logLocal('OTP challenge timed out');
  closeOtp();
  applyDecision('timeout', 'The customer did not complete the challenge in time.');
}

function closeOtp() {
  $('otpModal').classList.remove('show');
  $('otp-widget').innerHTML = '';
}

// --------------------------------------------------------------- timeline ---

function renderTimeline() {
  $('timeline').innerHTML = STEPS.map((s) => {
    const cls = reached.has(s.key) ? 'step done' : 'step';
    return `<div class="${cls}"><span class="dot"></span>${s.label}</div>`;
  }).join('');
}

function markStep(key) {
  reached.add(key);
  renderTimeline();
}

function applyDecision(status, description) {
  const v = $('verdict');
  const copy = {
    approved: ['Approved', 'Proceed with the authorisation.'],
    declined: ['Declined', 'Do not authorise.'],
    captured: ['Approved', 'Proceed with the authorisation.'],
    otp: ['Verification needed', 'An OTP challenge is required before deciding.'],
    timeout: ['Challenge expired', 'The customer ran out of time.'],
  }[status] || [status, description || ''];

  const tone = ['approved', 'captured'].includes(status)
    ? 'approved'
    : ['declined'].includes(status)
    ? 'declined'
    : 'submitted';

  v.className = `verdict show ${tone}`;
  v.innerHTML = `<div>${copy[0]}<span class="note">${description || copy[1]}</span></div>`;
}

// ------------------------------------------------------------------- log ----

function logLocal(message) {
  addEntry({ type: 'note', label: message, at: new Date().toISOString() });
}

function addEntry(event) {
  const log = $('log');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();

  const tagClass =
    { request: 'req', response: 'res', notification: 'hook', error: 'err' }[event.type] || '';
  const tagText =
    { request: 'sent', response: 'received', notification: 'webhook', error: 'error', note: 'note' }[
      event.type
    ] || event.type;

  const title =
    event.label || (event.action ? event.action.replace(/_/g, ' ') : '') || event.message || 'Event';
  const time = new Date(event.at).toLocaleTimeString();

  const detail = { ...event };
  delete detail.at;

  const el = document.createElement('div');
  el.className = 'entry';
  el.innerHTML = `
    <div class="entry-head">
      <span class="tag ${tagClass}">${tagText}</span>
      <span>${title}</span>
      <span class="time">${time}</span>
    </div>
    <pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre>`;
  el.querySelector('.entry-head').addEventListener('click', () => el.classList.toggle('open'));
  log.prepend(el);
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ------------------------------------------------------------------ init ----

function loadOtpSdk(url) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(true);
    s.onerror = () => {
      logLocal(`OTP SDK failed to load from ${url}`);
      resolve(false);
    };
    document.head.appendChild(s);
  });
}

async function init() {
  serverConfig = await (await fetch('/config')).json();

  $('env').innerHTML = [
    `<span class="pill">${serverConfig.shopDomain}</span>`,
    `<span class="pill">${new URL(serverConfig.syncBase).host}</span>`,
    serverConfig.simulate
      ? '<span class="pill warn">Simulator mode</span>'
      : serverConfig.hasToken
      ? '<span class="pill live">Live — token loaded</span>'
      : '<span class="pill warn">No auth token</span>',
  ].join('');

  renderTimeline();
  refreshPayloadPreview();

  if (!serverConfig.simulate) await loadOtpSdk(serverConfig.otpSdkUrl);

  const es = new EventSource('/events');
  es.onmessage = (e) => addEntry(JSON.parse(e.data));

  $('placeOrder').addEventListener('click', placeOrder);

  $('methodToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    paymentMethod = btn.dataset.method;
    for (const s of $('methodToggle').querySelectorAll('.seg')) {
      s.classList.toggle('active', s === btn);
    }
    $('methodHint').textContent =
      paymentMethod === 'ach'
        ? 'Plaid ACH. Account and routing numbers are fixed in the payload.'
        : 'Card. Placeholder details until the card payload is confirmed.';
    refreshPayloadPreview();
  });

  $('resetDemo').addEventListener('click', () => {
    reached = new Set(['cart']);
    currentOrderId = null;
    renderTimeline();
    $('verdict').className = 'verdict';
    $('log').innerHTML = '<p class="empty">Nothing yet. Add funds to start.</p>';
    refreshPayloadPreview();
  });

  $('clearLog').addEventListener('click', () => {
    $('log').innerHTML = '<p class="empty">Cleared.</p>';
  });

  $('otpClose').addEventListener('click', closeOtp);
  $('otpSimPass').addEventListener('click', () => onOtpSuccess('SIMULATED-ACCESS-TOKEN'));
  $('otpSimTimeout').addEventListener('click', onOtpTimeout);

  $('amount').addEventListener('input', () => {
    const n = Number($('amount').value || 0);
    $('displayAmount').textContent = `$${n.toFixed(2)}`;
    refreshPayloadPreview();
  });

  for (const id of ['email', 'phone', 'triggerOtp']) {
    $(id).addEventListener('input', refreshPayloadPreview);
  }
  $('triggerOtp').addEventListener('change', refreshPayloadPreview);
}

init();
