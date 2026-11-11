import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, WORKER_URL = "http://localhost:8000", CLIENT_URL = "http://localhost:5173" } = process.env;
const PP = "https://api-m.sandbox.paypal.com"; // sandbox only
const app = express();
app.use(cors({ origin: CLIENT_URL }), express.json());

// In-memory state. Prices are stored server-side so the client can never change what gets charged.
const runs = new Map();   // runId -> { budget, listings }
const orders = new Map(); // paypalOrderId -> { runId, listing, status }

app.post("/api/search", async (req, res) => {
  const { product, budget } = req.body ?? {};
  if (typeof product !== "string" || !(Number(budget) > 0)) return res.status(400).json({ error: "Enter a product and a budget above 0." });
  try {
    const r = await fetch(`${WORKER_URL}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product, budget: Number(budget) }) });
    if (!r.ok) throw new Error(`Worker returned ${r.status}`);
    const data = await r.json();
    const runId = crypto.randomUUID();
    runs.set(runId, { budget: Number(budget), listings: data.listings });
    res.json({ runId, ...data });
  } catch (e) { res.status(502).json({ error: `Agent unavailable: ${e.message}` }); }
});

async function token() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_SECRET in server/.env");
  const r = await fetch(`${PP}/v1/oauth2/token`, { method: "POST", body: "grant_type=client_credentials",
    headers: { Authorization: "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || "PayPal auth failed");
  return j.access_token;
}

// Runs only after the user taps "Approve & pay"
app.post("/api/checkout/create", async (req, res) => {
  const run = runs.get(req.body?.runId);
  const listing = run?.listings.find((l) => l.id === req.body?.listingId);
  if (!listing) return res.status(404).json({ error: "Listing not found. Run a new search." });
  if (!listing.in_stock || listing.total > run.budget) return res.status(409).json({ error: "Listing is out of stock or over budget." });
  try {
    const r = await fetch(`${PP}/v2/checkout/orders`, { method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", "PayPal-Request-Id": crypto.randomUUID() },
      body: JSON.stringify({ intent: "CAPTURE",
        purchase_units: [{ description: `${listing.title} from ${listing.store}`.slice(0, 127),
          amount: { currency_code: "USD", value: listing.total.toFixed(2) } }],
        payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: CLIENT_URL, cancel_url: CLIENT_URL } } } }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || "PayPal order failed");
    orders.set(j.id, { listing, status: "CREATED" });
    const approve = j.links.find((l) => ["approve", "payer-action"].includes(l.rel))?.href;
    res.json({ orderId: j.id, approveUrl: approve });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Called when PayPal redirects back with ?token=ORDER_ID
app.post("/api/checkout/capture", async (req, res) => {
  const order = orders.get(req.body?.orderId);
  if (!order) return res.status(404).json({ error: "Unknown order." });
  if (order.status === "COMPLETED") return res.json({ status: "COMPLETED", listing: order.listing });
  try {
    const r = await fetch(`${PP}/v2/checkout/orders/${req.body.orderId}/capture`, { method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || "Capture failed");
    order.status = j.status;
    res.json({ status: j.status, listing: order.listing, captureId: j.purchase_units?.[0]?.payments?.captures?.[0]?.id });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(4000, () => console.log("API on :4000"));
