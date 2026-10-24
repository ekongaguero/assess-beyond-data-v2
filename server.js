
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );

  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '20kb' }));

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  timeout: 20000,
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY || ''}`,
    'Content-Type': 'application/json',
  },
});

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing.');
}

if (!PAYSTACK_SECRET_KEY) {
  console.error('PAYSTACK_SECRET_KEY is missing.');
}

app.get('/', (req, res) => {
  res.json({
    service: 'ASSESS Beyond Data V2',
    status: 'running',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/database', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      message: 'Neon database connected',
    });
  } catch (error) {
    console.error('Database health check failed:', error.message);
    res.status(503).json({
      status: 'error',
      message: 'Database unavailable',
    });
  }
});

app.get('/api/plans', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT code, name, duration_days, amount_kobo,
             daily_quota_bytes, device_limit
      FROM plans
      WHERE active = true
      ORDER BY duration_days, code
    `);

    res.json({ status: 'ok', plans: result.rows });
  } catch (error) {
    console.error('Could not load plans:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Could not load plans',
    });
  }
});

app.post('/api/payments/initialize', async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) {
    return res.status(503).json({
      status: 'error',
      message: 'Payment service is not configured.',
    });
  }

  const email =
    typeof req.body?.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';

  const planCode =
    typeof req.body?.planCode === 'string'
      ? req.body.planCode.trim().toUpperCase()
      : typeof req.body?.plan === 'string'
        ? req.body.plan.trim().toUpperCase()
        : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: 'error',
      message: 'A valid email address is required.',
    });
  }

  if (!/^[A-Z0-9_]+$/.test(planCode)) {
    return res.status(400).json({
      status: 'error',
      message: 'A valid planCode is required.',
    });
  }

  let client;
  let reference;
  let committed = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const planResult = await client.query(
      `SELECT code, amount_kobo
       FROM plans
       WHERE code = $1 AND active = true`,
      [planCode]
    );

    if (planResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        status: 'error',
        message: 'Plan not found or inactive.',
      });
    }

    const plan = planResult.rows[0];

    const customerResult = await client.query(
      `INSERT INTO customers (email, created_at)
       VALUES ($1, NOW())
       ON CONFLICT (email)
       DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email`,
      [email]
    );

    const customer = customerResult.rows[0];
    reference = `AS${crypto.randomUUID().replace(/-/g, '')}`;

    await client.query(
      `INSERT INTO payments
       (reference, customer_id, plan_code, expected_amount_kobo,
        currency, status, created_at)
       VALUES ($1, $2, $3, $4, 'NGN', 'pending', NOW())`,
      [reference, customer.id, plan.code, plan.amount_kobo]
    );

    await client.query('COMMIT');
    committed = true;

    const response = await paystack.post('/transaction/initialize', {
      email: customer.email,
      amount: String(plan.amount_kobo),
      currency: 'NGN',
      callback_url: 'https://assess-beyond-data-v2.onrender.com/api/payments/callback',
      reference,
      metadata: {
        planCode: plan.code,
        customerId: String(customer.id),
      },
    });

    return res.json({
      status: 'ok',
      authorization_url: response.data.data.authorization_url,
      reference,
      planCode: plan.code,
    });
  } catch (error) {
    if (client && !committed) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }

    if (reference && committed) {
      try {
        await pool.query(
          `UPDATE payments
           SET status = 'failed'
           WHERE reference = $1 AND status = 'pending'`,
          [reference]
        );
      } catch (dbError) {
        console.error('Could not update payment:', dbError.message);
      }
    }

    console.error(
      'Payment initialization failed:',
      error.response?.data?.message || error.message
    );

    return res.status(502).json({
      status: 'error',
      message: 'Could not initialize payment. Please try again.',
    });
  } finally {
    if (client) client.release();
  }
});


app.get('/api/payments/callback', (req, res) => {
  const reference = req.query.reference;

  if (
    typeof reference !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(reference)
  ) {
    return res.redirect(303, '/payment-result?status=invalid');
  }

  return res.redirect(
    303,
    `/payment-result?reference=${encodeURIComponent(reference)}`
  );
});

app.get('/payment-result', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ASSESS Beyond Data — Payment Result</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #071426;
      color: #ffffff;
      font-family: Arial, sans-serif;
      display: flex;
      min-height: 90vh;
      align-items: center;
      justify-content: center;
    }
    main {
      width: 100%;
      max-width: 460px;
      padding: 28px;
      box-sizing: border-box;
      background: #10233a;
      border-radius: 16px;
      text-align: center;
    }
    h1 { letter-spacing: 4px; margin-bottom: 4px; }
    .tagline { color: #43d9bd; letter-spacing: 3px; }
    #message { line-height: 1.6; margin: 28px 0; }
    a {
      display: inline-block;
      color: #071426;
      background: #43d9bd;
      padding: 12px 18px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <main>
    <h1>ASSESS</h1>
    <div class="tagline">BEYOND DATA</div>
    <h2>Payment result</h2>
    <p id="message" role="status" aria-live="polite">
      Checking your payment securely. Please wait…
    </p>
   
<a id="return-link" href="https://exquisite-bombolone-ab117b.netlify.app">
  Return to ASSESS
</a>

  </main>
  <script>
    (async function () {
      const message = document.getElementById('message');
      const params = new URLSearchParams(window.location.search);
      const reference = params.get('reference');

      if (params.get('status') === 'invalid' || !reference ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(reference)) {
        message.textContent =
          'No valid payment reference was received. Please return to ASSESS and check your payment status.';
        return;
      }

      try {
        const response = await fetch(
          '/api/payments/verify/' + encodeURIComponent(reference),
          { cache: 'no-store' }
        );
        const result = await response.json();

       
if (result.paid && result.activated) {
  message.textContent =
    'Payment confirmed! Your ASSESS subscription has been activated. You can now return to ASSESS.';

  document.getElementById('return-link').href =
    'https://exquisite-bombolone-ab117b.netlify.app/?reference=' +
    encodeURIComponent(reference);

  } else {
    message.textContent =
      result.message ||
      'Payment is not confirmed yet. Please contact ASSESS support if you were charged.';
  }
      } catch (error) {

        message.textContent =
          'We could not check your payment right now. Please contact ASSESS support before paying again.';
      }
    })();
  </script>
</body>
</html>`);
});


app.get('/api/payments/verify/:reference', async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) {
    return res.status(503).json({
      status: 'error',
      message: 'Payment service is not configured.',
    });
  }

  const reference = req.params.reference;

  if (!/^[A-Za-z0-9_-]{1,100}$/.test(reference)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid payment reference.',
    });
  }

  let client;

  try {
    const savedResult = await pool.query(
      `SELECT p.reference, p.customer_id, p.plan_code,
              p.expected_amount_kobo, p.status, p.currency,
              s.id AS subscription_id
       FROM payments p
       LEFT JOIN subscriptions s
         ON s.payment_reference = p.reference
       WHERE p.reference = $1`,
      [reference]
    );

    if (savedResult.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Payment reference not found.',
      });
    }

    const saved = savedResult.rows[0];

    
if (saved.status === 'paid' && saved.subscription_id) {
  const subscriptionResult = await pool.query(
    `SELECT plan_code, starts_at, expires_at, status, device_limit
     FROM subscriptions
     WHERE payment_reference = $1
     LIMIT 1`,
    [reference]
  );

  const subscription = subscriptionResult.rows[0];

  return res.json({
    status: 'ok',
    paid: true,
    activated: true,
    alreadyActivated: true,
    reference,
    planCode: subscription?.plan_code || saved.plan_code,
    startsAt: subscription?.starts_at || null,
    expiresAt: subscription?.expires_at || null,
    subscriptionStatus: subscription?.status || null,
    deviceLimit: subscription?.device_limit ?? null,
    autoRenew: false,
  });
}


    if (saved.status !== 'pending') {
      return res.status(400).json({
        status: 'error',
        paid: false,
        message: `This payment is ${saved.status}.`,
      });
    }

    const planResult = await pool.query(
      `SELECT code, duration_days, amount_kobo, device_limit
       FROM plans
       WHERE code = $1 AND active = true`,
      [saved.plan_code]
    );

    if (planResult.rowCount === 0) {
      return res.status(400).json({
        status: 'error',
        paid: false,
        message: 'The saved plan is unavailable.',
      });
    }

    const plan = planResult.rows[0];

    const paystackResult = await paystack.get(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );


    const transaction = paystackResult.data.data;

    const verifiedAmount = Number(transaction.amount);
    const expectedAmount = Number(saved.expected_amount_kobo);

    // Paystack's requested_amount may be absent on some transactions.
    // The saved plan amount is the amount our backend originally requested.
    const requestedAmount = Number(transaction.requested_amount);

    console.log('ASSESS PAYMENT DIAGNOSTIC', {
      referenceMatches: transaction.reference === reference,
      transactionStatus: transaction.status,
      transactionCurrency: transaction.currency,
      savedCurrency: saved.currency,
      verifiedAmountKobo: verifiedAmount,
      expectedAmountKobo: expectedAmount,
      requestedAmountKobo: transaction.requested_amount,
    });

    const valid =
      transaction.reference === reference &&
      transaction.status === 'success' &&
      transaction.currency === 'NGN' &&
      saved.currency === 'NGN' &&
      Number.isSafeInteger(verifiedAmount) &&
      Number.isSafeInteger(expectedAmount) &&
      expectedAmount === Number(plan.amount_kobo) &&
      (
        Number.isSafeInteger(requestedAmount)
          ? requestedAmount === expectedAmount
          : verifiedAmount === expectedAmount
      );

    if (!valid) {
      return res.status(400).json({
        status: 'error',
        paid: false,
        message: 'Payment could not be verified against the saved amount and plan.',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const lockedResult = await client.query(
      `SELECT reference, customer_id, plan_code,
              expected_amount_kobo, currency, status
       FROM payments
       WHERE reference = $1
       FOR UPDATE`,
      [reference]
    );

    if (lockedResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        status: 'error',
        message: 'Payment record not found.',
      });
    }

    const payment = lockedResult.rows[0];

    if (payment.status === 'paid') {
      const existing = await client.query(
        `SELECT id FROM subscriptions WHERE payment_reference = $1`,
        [reference]
      );

     
if (existing.rowCount > 0) {
  const subscriptionResult = await client.query(
    `SELECT plan_code, starts_at, expires_at, status, device_limit
     FROM subscriptions
     WHERE payment_reference = $1
     LIMIT 1`,
    [reference]
  );

  const subscription = subscriptionResult.rows[0];

  await client.query('COMMIT');

  return res.json({
    status: 'ok',
    paid: true,
    activated: true,
    alreadyActivated: true,
    reference,
    planCode: subscription?.plan_code || payment.plan_code,
    startsAt: subscription?.starts_at || null,
    expiresAt: subscription?.expires_at || null,
    subscriptionStatus: subscription?.status || null,
    deviceLimit: subscription?.device_limit ?? null,
    autoRenew: false,
  });
}


      throw new Error('Paid payment has no subscription; manual review required.');
    }

    if (payment.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        status: 'error',
        paid: false,
        message: `Payment is ${payment.status}.`,
      });
    }

    const lockedPlanResult = await client.query(
      `SELECT code, duration_days, amount_kobo, device_limit
       FROM plans
       WHERE code = $1 AND active = true`,
      [payment.plan_code]
    );

    if (lockedPlanResult.rowCount === 0) {
      throw new Error('Plan unavailable during activation.');
    }

    const lockedPlan = lockedPlanResult.rows[0];  
console.log('ASSESS ACTIVATION DIAGNOSTIC', {
  referenceMatches: transaction.reference === payment.reference,
  transactionStatus: transaction.status,
  transactionCurrency: transaction.currency,
  paymentCurrency: payment.currency,
  requestedAmountKobo: Number(transaction.requested_amount),
  expectedAmountKobo: Number(payment.expected_amount_kobo),
  verifiedAmountKobo: Number(transaction.amount),
  feeKobo: Number(transaction.fees),
  totalMatches: Number(transaction.amount) ===
    Number(transaction.requested_amount) + Number(transaction.fees),
  planAmountKobo: Number(lockedPlan.amount_kobo),
});
    
  
if (
  transaction.reference !== payment.reference ||
  transaction.status !== 'success' ||
  transaction.currency !== payment.currency ||
  !Number.isSafeInteger(Number(transaction.amount)) ||
  !Number.isSafeInteger(Number(transaction.requested_amount)) ||
  !Number.isSafeInteger(Number(transaction.fees)) ||
  Number(transaction.requested_amount) !==
    Number(payment.expected_amount_kobo) ||
  Number(transaction.amount) !==
    Number(transaction.requested_amount) + Number(transaction.fees) ||
  Number(payment.expected_amount_kobo) !== Number(lockedPlan.amount_kobo)
) {
  throw new Error('Payment validation failed during activation.');
}


    await client.query(
      `UPDATE payments
       SET status = 'paid',
           paid_amount_kobo = $2,
           paid_at = NOW()
       WHERE reference = $1`,
      [reference, verifiedAmount]
    );

    await client.query(
      `INSERT INTO subscriptions
       (customer_id, payment_reference, plan_code, starts_at, expires_at,
        status, device_limit, created_at)
       VALUES ($1, $2, $3, NOW(),
               NOW() + ($4 * INTERVAL '1 day'),
               'active', $5, NOW())`,
      [
        payment.customer_id,
        reference,
        lockedPlan.code,
        Number(lockedPlan.duration_days),
        Number(lockedPlan.device_limit),
      ]
    );

    await client.query('COMMIT');

    return res.json({
      status: 'ok',
      paid: true,
      activated: true,
      reference,
      planCode: lockedPlan.code,
      durationDays: Number(lockedPlan.duration_days),
      deviceLimit: Number(lockedPlan.device_limit),
      autoRenew: false,
      message: 'Payment confirmed and subscription recorded.',
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }

    console.error(
      'Payment verification or activation failed:',
      error.response?.data?.message || error.message
    );

    return res.status(500).json({
      status: 'error',
      paid: false,
      message: 'Could not complete verification or activation. Please check logs.',
    });
  } finally {
    if (client) client.release();
  }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid JSON request body.',
    });
  }

  console.error('Unexpected server error:', error.message);

  return res.status(500).json({
    status: 'error',
    message: 'Internal server error.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ASSESS Beyond Data V2 running on port ${PORT}`);
});
