// Booking service: confirms holds into final bookings.
// Comments explain the confirmation path including payment webhook handling.

const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('redis');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const redis = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
redis.on('error', (err) => console.error('Redis Client Error', err));

// Confirm booking: body { hold_id, screening_id, seat_ids, payment_status, payment_txn_id }
app.post('/confirm', async (req, res) => {
  const { hold_id, screening_id, seat_ids, payment_status, payment_txn_id, customer_id } = req.body;
  if (!hold_id || !screening_id || !seat_ids) return res.status(400).json({ error: 'hold_id, screening_id, seat_ids required' });

  // Validate seats are currently held by hold_id
  const keys = seat_ids.map((sid) => `screening:${screening_id}:seat:${sid}`);
  const pipeline = redis.multi();
  for (const k of keys) pipeline.get(k);
  const results = await pipeline.exec();
  const states = results.map((r) => r[1]);
  for (const s of states) {
    if (!s || !s.startsWith(`HELD:${hold_id}:`)) {
      return res.status(409).json({ error: 'Seat not held by this hold_id', states });
    }
  }

  if (payment_status !== 'SUCCESS') {
    // If payment failed, release seats
    const rel = redis.multi();
    for (const k of keys) rel.set(k, 'AVAILABLE');
    await rel.exec();
    return res.status(402).json({ error: 'payment_failed' });
  }

  // Mark seats as SOLD atomically
  const sold = redis.multi();
  for (const k of keys) sold.set(k, `SOLD:${hold_id}:${payment_txn_id}`);
  await sold.exec();

  // Persist to Postgres: create Booking and BookingSeat rows (omitted here but commented for guidance).
  // In production you'd open a DB transaction and insert booking + booking_seats and update seat_states atomically.

  const booking_id = uuidv4();
  console.log('Booking confirmed', { booking_id, screening_id, seat_ids, payment_txn_id });

  // Emit event to partners/event bus here (omitted in MVP).

  res.json({ booking_id, screening_id, seat_ids });
});

// Payment webhook: Payment gateway will POST here to notify of payment result.
app.post('/payments/webhook', async (req, res) => {
  // For the stub: the payment stub will call this endpoint with { status, payment_txn_id, hold_id, screening_id, seat_ids }
  const payload = req.body;
  console.log('Received payment webhook', payload);

  // For MVP we immediately call /confirm to finalize booking. In real systems this is more complex and must be idempotent.
  try {
    const confirmResp = await fetch('http://booking:3002/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hold_id: payload.hold_id, screening_id: payload.screening_id, seat_ids: payload.seat_ids, payment_status: payload.status, payment_txn_id: payload.payment_txn_id }) });
    const body = await confirmResp.json();
    console.log('Confirm response', body);
  } catch (err) {
    console.error('Failed to call confirm internally', err);
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3002;
(async () => {
  await redis.connect();
  app.listen(PORT, () => console.log(`Booking service listening on ${PORT}`));
})();
