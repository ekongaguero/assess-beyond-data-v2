
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const PLANS = {
  BASIC_1_DAY: { amount: 100000, days: 1 },
  BASIC_3_DAYS: { amount: 340000, days: 3 },
  BASIC_7_DAYS: { amount: 600000, days: 7 },
  BASIC_30_DAYS: { amount: 2500000, days: 30 },
  PREMIUM_1_DAY: { amount: 200000, days: 1 },
  PREMIUM_3_DAYS: { amount: 600000, days: 3 },
  PREMIUM_7_DAYS: { amount: 1000000, days: 7 },
  PREMIUM_30_DAYS: { amount: 5000000, days: 30 },
};

app.get("/", (req, res) => {
  res.json({ service: "ASSESS Beyond Data V2", status: "running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/database", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      status: "error",
      message: "DATABASE_URL is not configured",
    });
  }

  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", message: "Neon database connected" });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(503).json({ status: "error", message: "Database connection failed" });
  }
});

app.get("/api/plans", (req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([code, plan]) => ({
      code,
      amount_kobo: plan.amount,
      duration_days: plan.days,
      daily_quota_gb: 50,
      device_limit: 1,
    })),
  });
});

app.post("/api/payments/initialize", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ message: "Payment service is not configured" });
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const planCode = String(req.body.planCode || req.body.plan || "").trim().toUpperCase();
    const plan = PLANS[planCode];

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email address is required" });
    }

    if (!plan) {
      return res.status(400).json({ message: "Invalid planCode" });
    }

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: plan.amount,
        currency: "NGN",
        metadata: { planCode },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const data = response.data.data;
    res.json({
      status: "success",
      authorization_url: data.authorization_url,
      reference: data.reference,
      access_code: data.access_code,
      planCode,
      amount_kobo: plan.amount,
    });
  } catch (error) {
    console.error("Payment initialization failed:", error.response?.data || error.message);
    res.status(502).json({ message: "Could not initialize payment" });
  }
});

app.get("/api/payments/verify/:reference", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ message: "Payment service is not configured" });
    }

    const reference = String(req.params.reference || "").trim();

    if (!reference) {
      return res.status(400).json({ message: "Payment reference is required" });
    }

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
        timeout: 20000,
      }
    );

    const transaction = response.data.data;
    const planCode = transaction.metadata?.planCode;
    const plan = PLANS[planCode];

    if (
      transaction.reference !== reference ||
      transaction.status !== "success" ||
      transaction.currency !== "NGN" ||
      !plan ||
      Number(transaction.amount) !== plan.amount
    ) {
      return res.status(400).json({
        paid: false,
        activated: false,
        message: "Payment could not be verified for this plan",
      });
    }

    // Payment is verified, but database activation is not implemented yet.
    res.json({
      paid: true,
      activated: false,
      reference,
      planCode,
      message: "Payment verified. Subscription activation is not yet enabled.",
    });
  } catch (error) {
    console.error("Payment verification failed:", error.response?.data || error.message);
    res.status(502).json({ paid: false, message: "Could not verify payment" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ASSESS Beyond Data V2 running on port ${PORT}`);
});
