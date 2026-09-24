/**
 * Riskified Review demo — local server.
 *
 * Why this exists: the browser cannot call Riskified directly. Every request
 * must carry an HMAC-SHA256 signature computed over the raw request body with
 * the shop auth token, and api.riskified.com does not serve CORS headers to a
 * page origin. So the page talks to this server, and this server talks to
 * Riskified.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { config, ACTIONS } = require('./config');

const app = express();

// The webhook needs the raw bytes to verify the signature, so it is mounted
// before the JSON parser and reads a Buffer.
app.post(
  '/webhook/riskified',
  express.raw({ type: '*/*', limit: '2mb' }),
  handleWebhook
);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory state. Restarting the server clears the demo, which is what you
// want between runs.
// ---------------------------------------------------------------------------
const orders = new Map(); // order id -> { id, status, events: [] }
const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function record(orderId, event) {
  const entry = { ...event, at: new Date().toISOString() };
  if (orderId) {
    if (!orders.has(orderId)) orders.set(orderId, { id: orderId, status: 'new', events: [] });
    const order = orders.get(orderId);
    order.events.push(entry);
    if (entry.status) order.status = entry.status;
    entry.orderId = orderId;
  }
  broadcast(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------
function sign(body) {
  return crypto
    .createHmac('sha256', config.authToken)
    .update(body, 'utf8')
    .digest('hex');
}

function buildHeaders(rawBody, action = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-RISKIFIED-SHOP-DOMAIN': config.shopDomain,
    // HMAC is computed over the raw body only — headers are not part of it.
    'X-RISKIFIED-HMAC-SHA256': sign(rawBody),
  };
  // The OTP host versions itself through Accept; everything else uses
  // `api-version`. Sending both to the OTP host is not worth the risk.
  if (action.accept) headers.Accept = action.accept;
  else headers['api-version'] = config.apiVersion;
  return headers;
}

// ---------------------------------------------------------------------------
// Outbound proxy: POST /call/:action
// ---------------------------------------------------------------------------
app.post('/call/:action', async (req, res) => {
  const action = ACTIONS[req.params.action];
  if (!action) {
    return res.status(400).json({ error: `Unknown action "${req.params.action}"` });
  }

  const payload = req.body;
  const orderId =
    payload?.order?.id ?? payload?.checkout?.id ?? payload?.id ?? null;

  const rawBody = JSON.stringify(payload);
  const headers = buildHeaders(rawBody, action);
  const base =
    action.host === 'otp'
      ? config.otpBase
      : action.sync
        ? config.syncBase
        : config.asyncBase;
  const url = base + action.path;

  const sent = {
    type: 'request',
    action: req.params.action,
    label: action.label,
    url,
    // The token itself is never shown; the derived signature is, because
    // seeing it is half the point of the demo.
    headers: { ...headers },
    body: payload,
    simulated: config.simulate,
  };
  record(orderId, sent);

  if (config.simulate) {
    const simulated = simulateResponse(req.params.action, payload);
    record(orderId, {
      type: 'response',
      action: req.params.action,
      status: simulated.status,
      httpStatus: 200,
      body: simulated.body,
      simulated: true,
    });
    if (simulated.deferredDecision) {
      scheduleSimulatedDecision(orderId, simulated.deferredDecision);
    }
    return res.json({ ok: true, httpStatus: 200, body: simulated.body, simulated: true });
  }

  if (!config.authToken) {
    const message =
      'No RISKIFIED_AUTH_TOKEN set. Add it to .env, or run with SIMULATE=true.';
    record(orderId, { type: 'error', action: req.params.action, message });
    return res.status(500).json({ error: message });
  }

  try {
    const upstream = await fetch(url, { method: 'POST', headers, body: rawBody });
    const text = await upstream.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    record(orderId, {
      type: 'response',
      action: req.params.action,
      httpStatus: upstream.status,
      status: body?.order?.status || body?.status || null,
      body,
    });

    res.status(200).json({ ok: upstream.ok, httpStatus: upstream.status, body });
  } catch (err) {
    record(orderId, { type: 'error', action: req.params.action, message: err.message });
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Inbound notification endpoint. This is the URL you register in the Riskified
// portal (point a tunnel at it: ngrok http 3000 -> https://xxx.ngrok.app/webhook/riskified)
// ---------------------------------------------------------------------------
function handleWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const received = req.get('X-RISKIFIED-HMAC-SHA256') || '';

  let verified = null;
  if (config.verifyWebhookHmac && config.authToken) {
    const expected = sign(raw);
    verified =
      received.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  const orderId = body?.order?.id ?? body?.id ?? null;
  const status = body?.order?.status ?? body?.status ?? null;

  record(orderId, {
    type: 'notification',
    label: 'Decision received',
    status,
    hmacVerified: verified,
    headers: {
      'X-RISKIFIED-HMAC-SHA256': received,
      'X-RISKIFIED-SHOP-DOMAIN': req.get('X-RISKIFIED-SHOP-DOMAIN') || null,
    },
    body,
  });

  // Riskified retries on non-2xx, so always acknowledge.
  res.status(200).json({ received: true });
}

// ---------------------------------------------------------------------------
// Simulator — lets the demo run with no network and no credentials.
// ---------------------------------------------------------------------------
function simulateResponse(actionName, payload) {
  const order = payload?.order || {};
  const firstName = String(order?.billing_address?.first_name || '').toLowerCase();
  const lastName = String(order?.billing_address?.last_name || '').toLowerCase();
  const email = String(order?.email || '').toLowerCase();

  // The sandbox splits this across two services, and so does the simulator —
  // otherwise it would approve orders the real thing declines, or worse,
  // decline ones it approves.
  //   decision rules: decline on 'decline' | 'considerable' | 'highrisk'
  //   eligibility:    recommend OTP on 'otp' in the email or first name
  const declineKeywords = ['decline', 'considerable', 'highrisk'];
  const declined = declineKeywords.some(
    (k) => firstName.includes(k) || lastName.includes(k) || email.includes(k)
  );
  const eligible = firstName.includes('otp') || email.includes('otp');

  // /otp/initiate returns the widget JWT and nothing else. A simulated one
  // can't open the hosted widget, so the page shows a stand-in panel instead.
  if (actionName === 'otp_initiate') {
    return {
      status: null,
      // snake_case, matching the live API rather than its OpenAPI example.
      body: { widget_token: 'SIMULATED-WIDGET-TOKEN' },
    };
  }

  if (actionName === 'decide') {
    const alreadyChallenged = Boolean(order?.challenge_access_token);

    // Only a declined order can be recovered. 'otp' on its own is approved
    // with a recommendation attached, which is a dead end — reproduce that
    // here so the trap is visible in the simulator too.
    if (declined && eligible && !alreadyChallenged) {
      // Mirrors the real sandbox: the order is declined, and the OTP offer
      // rides along in advice.recommendations. There is no token here.
      return {
        status: 'declined',
        body: {
          order: {
            id: order.id,
            status: 'declined',
            description: 'Order exhibits strong fraudulent indicators',
            old_status: 'created',
            category: 'Fraudulent',
            advice: {
              recommendations: [{ type: 'otp', recommended: true }],
            },
          },
        },
      };
    }

    // Declined with no OTP word: a plain decline, nothing to recover.
    if (declined && !alreadyChallenged) {
      return {
        status: 'declined',
        body: {
          order: {
            id: order.id,
            status: 'declined',
            description: 'Order exhibits strong fraudulent indicators',
            old_status: 'created',
            category: 'Fraudulent',
          },
        },
      };
    }

    return {
      status: 'approved',
      body: {
        order: {
          id: order.id,
          status: 'approved',
          // 'otp' without a decline keyword: the recommendation rides along on
          // an approved order, so the widget never opens. This is the trap.
          ...(eligible && !alreadyChallenged
            ? { advice: { recommendations: [{ type: 'otp', recommended: true }] } }
            : {}),
          description: alreadyChallenged
            ? 'Simulated decision after OTP challenge'
            : 'Simulated decision',
        },
      },
    };
  }

  return { status: null, body: { order: { id: order.id, status: 'ok' } } };
}

function scheduleSimulatedDecision(orderId, status) {
  setTimeout(() => {
    record(orderId, {
      type: 'notification',
      label: 'Decision received',
      status,
      hmacVerified: null,
      simulated: true,
      body: {
        order: {
          id: orderId,
          status,
          description: 'Simulated asynchronous decision',
          decided_at: new Date().toISOString(),
        },
      },
    });
  }, 4000);
}

// Manual override — the button in the console that forces a decision on stage.
app.post('/simulate/decision', (req, res) => {
  const { orderId, status } = req.body || {};
  if (!orderId || !status) return res.status(400).json({ error: 'orderId and status required' });
  record(orderId, {
    type: 'notification',
    label: 'Decision received',
    status,
    simulated: true,
    body: { order: { id: orderId, status, description: 'Injected from demo console' } },
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Live stream to the page
// ---------------------------------------------------------------------------
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/config', (req, res) => {
  res.json({
    shopDomain: config.shopDomain,
    asyncBase: config.asyncBase,
    syncBase: config.syncBase,
    simulate: config.simulate,
    hasToken: Boolean(config.authToken),
    otpSdkUrl: config.otpSdkUrl,
    beaconUrl: config.beaconUrl,
    // The page assembles the /otp/initiate body so it shows up in the console
    // panel like every other request; these are the parts it can't invent.
    otp: config.otp,
    actions: Object.fromEntries(
      Object.entries(ACTIONS).map(([k, v]) => [k, { label: v.label, path: v.path, sync: v.sync }])
    ),
  });
});

app.listen(config.port, () => {
  console.log(`\n  Riskified Review demo`);
  console.log(`  ---------------------`);
  console.log(`  Storefront   http://localhost:${config.port}`);
  console.log(`  Webhook      POST /webhook/riskified`);
  console.log(`  Shop domain  ${config.shopDomain}`);
  console.log(`  Mode         ${config.simulate ? 'simulator (no calls leave this machine)' : 'live'}`);
  if (!config.simulate && !config.authToken) {
    console.log(`  Warning      no auth token set — calls will fail\n`);
  } else {
    console.log('');
  }
});
