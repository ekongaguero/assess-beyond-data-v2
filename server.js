
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
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
      return res.json({
        status: 'ok',
        paid: true,
        activated: true,
        alreadyActivated: true,
        reference,
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

    console.log('ASSESS PAYMENT DIAGNOSTIC', {
  referenceMatches: transaction.reference === reference,
  transactionStatus: transaction.status,
  transactionCurrency: transaction.currency,
  savedCurrency: saved.currency,
  verifiedAmountKobo: Number(transaction.amount),
  expectedAmountKobo: Number(saved.expected_amount_kobo),
  planAmountKobo: Number(plan.amount_kobo),
    gatewayResponseAmount: transaction.gateway_response,
  feeKobo: transaction.fees,
  requestedAmountKobo: transaction.requested_amount,    
});
    
    const valid =
      transaction.reference === reference &&
      transaction.status === 'success' &&
      transaction.currency === 'NGN' &&
      saved.currency === 'NGN' &&
      Number.isSafeInteger(verifiedAmount) &&
      verifiedAmount === expectedAmount &&
      expectedAmount === Number(plan.amount_kobo);

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
        await client.query('COMMIT');
        return res.json({
          status: 'ok',
          paid: true,
          activated: true,
          alreadyActivated: true,
          reference,
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

    if (
      transaction.reference !== payment.reference ||
      transaction.status !== 'success' ||
      transaction.currency !== payment.currency ||
      Number(transaction.amount) !== Number(payment.expected_amount_kobo) ||
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
