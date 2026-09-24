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
// The challenge access token we generate and send to /otp/initiate. The widget
// should hand back the same value on success.
let expectedChallengeToken = null;

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
  // The card block is shaped differently from the ACH one: no `type`, and
  // `credit_card_number` is the last four only, not a masked full number.
  cardPaymentDetails: [
    {
      credit_card_bin: '424242',
      credit_card_company: 'visa',
      credit_card_number: '4242',
      stored_payment_updated_at: '2026-06-09T18:22:04.118Z',
    },
  ],
  /**
   * Sandbox triggers for the recovery demo.
   *
   * Two separate services have to agree, and they key off different words.
   * Swan's mock decision rules decide approve/decline, and only its own
   * keywords ("decline", "considerable", "highrisk") produce a decline. The
   * eligibility service adds the OTP recommendation, and it keys off "otp" in
   * `order.email` or `billing_address.first_name`.
   *
   * So "otp" alone gets an approved order with an OTP recommendation attached
   * — and an approved order has nothing to recover. Both words have to be in
   * the same payload.
   *
   * This uses the split-fields recipe: "otp" in the first name, the decline
   * keyword in the last name, which leaves the email the operator typed
   * untouched. The single-field alternative is the email
   * `decline.otp@test.com`, where "decline" and standalone "otp" do both jobs.
   */
  otpTrigger: {
    firstNamePrefix: 'otp',
    // 'considerable' or 'highrisk' — both decline, at different severities.
    declineLastName: 'considerable',
  },
  // Shown on the page and sent as line_items[].title, so the two can't drift.
  lineItemTitle: {
    ach: 'Prediction Market ACH Fund',
    card: 'Prediction Market Card Fund',
  },
  note: '{"cash_value":68.4588,"open_value":0,"active_contr":2,"risk_tier":"super_trust"}',
};

/**
 * Country dialling codes for the phone control.
 *
 * Kept out of FIXED deliberately: FIXED holds values that go into the payload,
 * and this is a UI list. Not exhaustive, and doesn't need to be — add a row and
 * the picker picks it up.
 */
const DIAL_CODES = [
  { name: 'United States', dial: '+1' },
  { name: 'Canada', dial: '+1' },
  { name: 'United Kingdom', dial: '+44' },
  { name: 'Ireland', dial: '+353' },
  { name: 'Brazil', dial: '+55' },
  { name: 'Mexico', dial: '+52' },
  { name: 'Argentina', dial: '+54' },
  { name: 'Chile', dial: '+56' },
  { name: 'Colombia', dial: '+57' },
  { name: 'Peru', dial: '+51' },
  { name: 'Portugal', dial: '+351' },
  { name: 'Spain', dial: '+34' },
  { name: 'France', dial: '+33' },
  { name: 'Germany', dial: '+49' },
  { name: 'Netherlands', dial: '+31' },
  { name: 'Belgium', dial: '+32' },
  { name: 'Italy', dial: '+39' },
  { name: 'Switzerland', dial: '+41' },
  { name: 'Austria', dial: '+43' },
  { name: 'Sweden', dial: '+46' },
  { name: 'Norway', dial: '+47' },
  { name: 'Denmark', dial: '+45' },
  { name: 'Finland', dial: '+358' },
  { name: 'Poland', dial: '+48' },
  { name: 'Israel', dial: '+972' },
  { name: 'United Arab Emirates', dial: '+971' },
  { name: 'South Africa', dial: '+27' },
  { name: 'India', dial: '+91' },
  { name: 'Singapore', dial: '+65' },
  { name: 'Hong Kong', dial: '+852' },
  { name: 'China', dial: '+86' },
  { name: 'Japan', dial: '+81' },
  { name: 'South Korea', dial: '+82' },
  { name: 'Australia', dial: '+61' },
  { name: 'New Zealand', dial: '+64' },
];

// Defaults to the persona's own country — the billing address is in New York.
let dialCode = '+1';

// The Beacon session id, once the script has loaded and announced itself.
let beaconSessionId = null;

function newOrderId() {
  return crypto.randomUUID();
}

/**
 * The single phone value the payload uses: dialling code plus whatever digits
 * were typed. Empty when no number has been entered, rather than a bare
 * dialling code that would look like a real number in the payload.
 */
function phoneValue() {
  const national = $('phoneNational').value.replace(/\D/g, '');
  return national ? dialCode + national : '';
}

/**
 * `cart_token` carries the Beacon session id. That id is how Riskified ties the
 * device and behavioural signals the Beacon collected in the browser to this
 * order on the backend — without it the Beacon data and the order never meet.
 *
 * Falls back to the fixed token when the Beacon hasn't reported yet, failed to
 * load, or is switched off in simulator mode, so the payload is always
 * well-formed. The console log and the env pill say which one is in play.
 */
function cartToken() {
  return beaconSessionId || window.RISKX?.getSessionId?.() || FIXED.cartToken;
}

function buildOrder(orderId) {
  const now = new Date().toISOString();
  const amount = Number($('amount').value || 0);
  const email = $('email').value;
  const phone = phoneValue();

  // A recoverable order needs both words: "otp" for the recommendation and a
  // decline keyword so there is something to recover. See FIXED.otpTrigger.
  const recoveryRun = $('triggerOtp').checked;
  const firstName = recoveryRun
    ? FIXED.otpTrigger.firstNamePrefix + FIXED.firstName
    : FIXED.firstName;
  const lastName = recoveryRun ? FIXED.otpTrigger.declineLastName : FIXED.lastName;

  const isAch = paymentMethod === 'ach';

  return {
    order: {
      id: orderId,
      name: orderId,
      source: 'desktop_web',
      total_price: amount,
      browser_ip: FIXED.browserIp,
      cart_token: cartToken(),
      created_at: now,
      currency: FIXED.currency,
      email,
      gateway: isAch ? 'plaid_ach' : 'stripe_link',
      billing_address: {
        ...FIXED.billingAddress,
        first_name: firstName,
        last_name: lastName,
        phone,
      },
      customer: {
        ...FIXED.customer,
        email,
        first_name: firstName,
        last_name: lastName,
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
          title: FIXED.lineItemTitle[paymentMethod],
          delivered_at: now,
        },
      ],
      payment_details: isAch ? FIXED.achPaymentDetails : FIXED.cardPaymentDetails,
      note: FIXED.note,
      // Only the card payload we were given carries this. Left off the ACH path
      // rather than assumed onto it — see README.
      ...(isAch ? {} : { submission_reason: 'non_guarantee_decision' }),
    },
  };
}

/**
 * Where the challenge access token goes on the second /decide.
 *
 * Still the one field no public doc covers. The name is right — /otp/initiate
 * calls it `challenge_access_token` too — but its placement on the decide
 * payload is inferred. If the second call misbehaves, change it here only.
 */
function attachChallengeToken(payload, token) {
  return {
    ...payload,
    order: { ...payload.order, challenge_access_token: token },
  };
}

// -------------------------------------------------------------- beacon ---

/**
 * Loads the Riskified Beacon and captures the session id it announces.
 *
 * This is the integration guide's snippet with two deliberate differences.
 * The shop domain comes from the server config rather than being pasted into
 * the markup, so it can't drift from the `X-RISKIFIED-SHOP-DOMAIN` header the
 * proxy signs with. And it loads immediately instead of waiting for
 * `window.onload` — the guide defers so the Beacon never delays a page, but
 * this page is already loaded by the time init runs, so deferring further would
 * only widen the window where an order could be placed with no session id.
 *
 * The guide's hidden-form-field pattern doesn't apply here: nothing posts a
 * form. The session id goes into the JSON payload as `cart_token`, and the
 * server signs and forwards it.
 *
 * Skipped in simulator mode — the Beacon reports to Riskified, and the point of
 * the simulator is that nothing leaves the machine.
 */
function loadBeacon() {
  // Subscribe before the script is inserted. rskx_ready fires once, and a
  // listener attached afterwards misses it entirely.
  document.addEventListener('rskx_ready', (event) => {
    beaconSessionId =
      event.detail?.sessionId || window.RISKX?.getSessionId?.() || null;
    logLocal(`Beacon ready — session ${beaconSessionId}, sending as cart_token`);
    renderBeaconPill();
    // The preview was built before the id existed; rebuild it so what's on
    // screen matches what would actually be sent.
    refreshPayloadPreview();
  });

  const s = document.createElement('script');
  s.type = 'text/javascript';
  s.async = true;
  s.src = `${serverConfig.beaconUrl}?shop=${encodeURIComponent(serverConfig.shopDomain)}`;
  s.onerror = () => {
    logLocal('Beacon failed to load — cart_token falls back to the fixed value.');
    renderBeaconPill();
  };
  document.head.appendChild(s);
}

function renderBeaconPill() {
  const pill = $('beaconPill');
  if (!pill) return;

  if (beaconSessionId) {
    pill.className = 'pill live';
    pill.textContent = `Beacon ${beaconSessionId.slice(0, 10)}…`;
    pill.title = `cart_token = ${beaconSessionId}`;
    return;
  }

  pill.className = 'pill warn';
  pill.textContent = serverConfig.simulate ? 'Beacon off' : 'Beacon loading…';
  pill.title = `cart_token falls back to ${FIXED.cartToken}`;
}

// ------------------------------------------------------- country picker ---

/**
 * A searchable dialling-code picker. A native <select> can't do this — it only
 * jumps on first letter, so "+1" or "braz" wouldn't find anything — hence the
 * small combobox: a text input over a filtered list.
 *
 * Matches on either half of a row, so "brazil" and "+55" both land on Brazil,
 * and a bare "55" works too.
 */
let dialMatches = DIAL_CODES;
let dialActive = 0;

function dialLabel({ name, dial }) {
  return `${name} ${dial}`;
}

function filterDialCodes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return DIAL_CODES;
  const digits = q.replace(/^\+/, '');
  return DIAL_CODES.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (digits && c.dial.slice(1).startsWith(digits))
  );
}

function renderDialList() {
  const list = $('dialList');
  if (!dialMatches.length) {
    list.innerHTML = '<li class="combo-empty">No match</li>';
    return;
  }
  list.innerHTML = dialMatches
    .map(
      (c, i) =>
        `<li role="option" data-i="${i}" class="${i === dialActive ? 'active' : ''}"
          ><span>${c.name}</span><span class="dial">${c.dial}</span></li>`
    )
    .join('');
}

function openDialList(query = '') {
  dialMatches = filterDialCodes(query);
  dialActive = 0;
  renderDialList();
  $('dialList').hidden = false;
  $('dialInput').setAttribute('aria-expanded', 'true');
}

function closeDialList() {
  $('dialList').hidden = true;
  $('dialInput').setAttribute('aria-expanded', 'false');
}

function chooseDialCode(country) {
  dialCode = country.dial;
  $('dialInput').value = dialLabel(country);
  closeDialList();
  refreshPayloadPreview();
}

function moveDialActive(step) {
  if (!dialMatches.length) return;
  dialActive = (dialActive + step + dialMatches.length) % dialMatches.length;
  renderDialList();
  $('dialList').querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
}

function initDialPicker() {
  const input = $('dialInput');
  const list = $('dialList');

  chooseDialCode(DIAL_CODES.find((c) => c.dial === dialCode));

  // Clear on focus so typing searches immediately instead of appending to the
  // current label; the selection is restored on blur if nothing is picked.
  input.addEventListener('focus', () => {
    input.value = '';
    openDialList('');
  });

  input.addEventListener('input', () => openDialList(input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveDialActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveDialActive(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (dialMatches[dialActive]) chooseDialCode(dialMatches[dialActive]);
    } else if (e.key === 'Escape') {
      closeDialList();
      input.blur();
    }
  });

  // mousedown, not click: blur would close the list before click landed.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    chooseDialCode(dialMatches[Number(li.dataset.i)]);
    input.blur();
  });

  input.addEventListener('blur', () => {
    closeDialList();
    // Nothing chosen — put the current selection back so the box is never left
    // showing a half-typed search.
    input.value = dialLabel(
      DIAL_CODES.find((c) => c.dial === dialCode) || DIAL_CODES[0]
    );
  });
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
    await handleDecision(res, false);
  } catch (err) {
    alert('Call failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add funds';
  }
}

async function handleDecision(res, isFinal) {
  const body = res?.body || {};
  const status = String(body?.order?.status || body?.status || '').toLowerCase();

  // A declined order is not the end of the story. If Riskified also recommends
  // OTP, the order is eligible for recovery and the challenge runs before any
  // decline is shown to the customer.
  if (!isFinal && status === 'declined' && otpRecommended(body)) {
    markStep('otp');
    // Riskified echoes the id it decided on; that's the one /otp/initiate looks
    // up, and it beats currentOrderId if the payload was hand-edited.
    const decidedOrderId =
      body?.order?.id || lastPayload?.order?.id || currentOrderId;
    await beginOtpRecovery(decidedOrderId, Boolean(res.simulated));
    return;
  }

  markStep('final');
  applyDecision(status || 'unknown', body?.order?.description);
}

/**
 * The decide response signals the challenge through advice.recommendations —
 * `{ type: 'otp', recommended: true }`. It carries no token; the widget token
 * comes from the separate /otp/initiate call.
 */
function otpRecommended(body) {
  const recommendations = body?.order?.advice?.recommendations;
  if (!Array.isArray(recommendations)) return false;
  return recommendations.some(
    (r) => String(r?.type).toLowerCase() === 'otp' && r?.recommended === true
  );
}

/**
 * Step two of the recovery flow: mint a challenge access token, call
 * /otp/initiate (which sends the SMS), and open the widget with the JWT it
 * returns.
 *
 * The challenge access token is ours, not Riskified's — the API requires a
 * hard-to-guess value of at least 32 characters, which we generate here, hand
 * to /initiate, and expect the widget to hand back on success. Comparing the
 * two is what stops someone pairing a passed OTP with a different order.
 */
async function beginOtpRecovery(decidedOrderId, simulated) {
  expectedChallengeToken = crypto.randomUUID();

  const otp = serverConfig.otp || {};

  // /initiate rejects the call rather than defaulting anything, and a missing
  // value would be dropped by JSON.stringify and show up as a vague 400. Catch
  // it here, where we can say which field is missing.
  const missing = ['localizationLanguage', 'contactDetails', 'senderName', 'channelType']
    .filter((k) => !otp[k]);
  if (missing.length) {
    logLocal(
      `Cannot call /otp/initiate — missing config: ${missing.join(', ')}. ` +
        'The page loaded a /config without an otp block; restart the server and reload.'
    );
    failRecovery();
    return;
  }

  const initiateBody = {
    // Must be the id Riskified decided on. The custom-payload box can carry a
    // different one, so this comes from the payload we actually sent.
    id: decidedOrderId,
    challenge_access_token: expectedChallengeToken,
    localization_language: otp.localizationLanguage,
    contact_details: otp.contactDetails,
    channel_method: {
      channel_type: otp.channelType,
      sender_name: otp.senderName,
    },
  };

  const res = await call('otp_initiate', initiateBody);
  // The live API returns `widget_token`. The published OpenAPI example says
  // `widgetToken` — it's wrong, so read both and let the real one win.
  const widgetToken = res?.body?.widget_token || res?.body?.widgetToken;

  if (!widgetToken) {
    // The API answers errors with a bare JSON string, so show the body as-is
    // rather than fishing for a field that isn't there.
    const detail =
      typeof res?.body === 'string' ? res.body : JSON.stringify(res?.body ?? res);
    logLocal(`OTP initiate failed (HTTP ${res?.httpStatus ?? '?'}): ${detail}`);
    failRecovery();
    return;
  }

  startOtp(widgetToken, simulated);
}

function failRecovery() {
  markStep('final');
  applyDecision('declined', 'Order declined and OTP recovery could not start.');
}

// -------------------------------------------------------------------- OTP ---

function startOtp(token, simulated) {
  $('otpModal').classList.add('show');
  $('otpSub').textContent = `A code has been sent to ${phoneValue()}.`;

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
  // The widget should echo the token we sent to /otp/initiate. A mismatch means
  // this success belongs to a different order — the exact thing the token is
  // there to catch — so say so loudly rather than approving on it.
  if (expectedChallengeToken && challengeAccessToken !== expectedChallengeToken) {
    logLocal('Challenge access token from the widget does not match the one sent to /otp/initiate.');
  }

  logLocal('OTP challenge passed — re-deciding with the challenge access token');
  closeOtp();

  const body = attachChallengeToken(lastPayload, challengeAccessToken);
  const res = await call('decide', body);
  await handleDecision(res, true);
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
    '<span class="pill" id="beaconPill"></span>',
  ].join('');

  renderBeaconPill();
  // Started before the rest of init so the session id is in hand as early as
  // possible — an order placed before rskx_ready falls back to the fixed token.
  if (!serverConfig.simulate) loadBeacon();

  // Keep the checkbox hint reading from the same constants the payload uses.
  $('otpTriggerFirst').textContent =
    FIXED.otpTrigger.firstNamePrefix + FIXED.firstName;
  $('otpTriggerLast').textContent = FIXED.otpTrigger.declineLastName;

  initDialPicker();

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
    $('productName').textContent = FIXED.lineItemTitle[paymentMethod];
    $('methodHint').textContent =
      paymentMethod === 'ach'
        ? 'Plaid ACH. Account and routing numbers are fixed in the payload.'
        : 'Stripe Link. Card BIN and last four are fixed in the payload.';
    refreshPayloadPreview();
  });

  $('resetDemo').addEventListener('click', () => {
    reached = new Set(['cart']);
    currentOrderId = null;
    expectedChallengeToken = null;
    renderTimeline();
    $('verdict').className = 'verdict';
    $('log').innerHTML = '<p class="empty">Nothing yet. Add funds to start.</p>';
    refreshPayloadPreview();
  });

  $('clearLog').addEventListener('click', () => {
    $('log').innerHTML = '<p class="empty">Cleared.</p>';
  });

  $('otpClose').addEventListener('click', closeOtp);
  // Pass back the token we actually generated, so the simulated path exercises
  // the same match check as the real one.
  $('otpSimPass').addEventListener('click', () => onOtpSuccess(expectedChallengeToken));
  $('otpSimTimeout').addEventListener('click', onOtpTimeout);

  $('amount').addEventListener('input', () => {
    const n = Number($('amount').value || 0);
    $('displayAmount').textContent = `$${n.toFixed(2)}`;
    refreshPayloadPreview();
  });

  for (const id of ['email', 'phoneNational', 'triggerOtp']) {
    $(id).addEventListener('input', refreshPayloadPreview);
  }
  $('triggerOtp').addEventListener('change', refreshPayloadPreview);
}

init();
