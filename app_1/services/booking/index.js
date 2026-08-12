// Booking service: confirms holds into final bookings.
// This version persists bookings into Postgres in a transaction to ensure durability and idempotency.

const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('redis');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;
const POSTGRES_USER = process.env.POSTGRES_USER || 'postgres';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'postgres';
const POSTGRES_DB = process.env.POSTGRES_DB || 'movie';

const redis = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
redis.on('error', (err) => console.error('Redis Client Error', err));

const pgPool = new Pool({
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
  database: POSTGRES_DB
});

// Confirm booking: body { hold_id, screening_id, seat_ids, payment_status, payment_txn_id }
app.post('/confirm', async (req, res) => {
  const { hold_id, screening_id, seat_ids, payment_status, payment_txn_id, customer_id } = req.body;
  if (!hold_id || !screening_id || !seat_ids) return res.status(400).json({ error: 'hold_id, screening_id, seat_ids required' });

  // Validate seats are currently held by hold_id in Redis
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

  // Persist booking into Postgres in a transaction. Use payment_txn_id as idempotency key.
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    // Check idempotency: if booking exists for payment_txn_id return it
    if (payment_txn_id) {
      const exist = await client.query('SELECT id FROM bookings WHERE payment_txn_id = $1 LIMIT 1', [payment_txn_id]);
      if (exist.rows.length > 0) {
        await client.query('COMMIT');
        return res.json({ booking_id: exist.rows[0].id, screening_id, seat_ids });
      }
    }

    const booking_id = uuidv4();
    const total_amount = 0.0; // for MVP, we don't calculate prices
    await client.query('INSERT INTO bookings (id, screening_id, customer_id, payment_txn_id, total_amount, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())', [booking_id, screening_id, customer_id || null, payment_txn_id || null, total_amount, 'CONFIRMED']);

    for (const sid of seat_ids) {
      await client.query('INSERT INTO booking_seats (booking_id, seat_external_id, price) VALUES ($1,$2,$3)', [booking_id, sid, 0.0]);
      // Add a seat_states audit row
      await client.query('INSERT INTO seat_states (screening_id, seat_external_id, state, holder_id, txn_id, updated_at) VALUES ($1,$2,$3,$4,$5,now())', [screening_id, sid, 'SOLD', booking_id, payment_txn_id || null]);
    }

    await client.query('DELETE FROM holds WHERE id = $1', [hold_id]);
    await client.query('COMMIT');

    // Mark seats as SOLD atomically in Redis
    const sold = redis.multi();
    for (const k of keys) sold.set(k, `SOLD:${booking_id}:${payment_txn_id || ''}`);
    await sold.exec();

    console.log('Booking confirmed', { booking_id, screening_id, seat_ids, payment_txn_id });
    res.json({ booking_id, screening_id, seat_ids });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Booking transaction failed', err);
    // Attempt to release seats in Redis as compensation
    const rel = redis.multi();
    for (const k of keys) rel.set(k, 'AVAILABLE');
    await rel.exec();
    res.status(500).json({ error: 'booking_failed', details: err.message });
  } finally {
    client.release();
  }
});

// Payment webhook to accept notifications from payment gateway
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
  await pgPool.connect();
  app.listen(PORT, () => console.log(`Booking service listening on ${PORT}`));
})();
