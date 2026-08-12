// Inventory service: provides seat maps and atomic holds using Redis Lua script.
// Comments inside the code explain how each part works. This version adds Postgres persistence for holds
// and loads seat definitions & states from Postgres on startup.

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { createClient } = require('redis');
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

// Create Redis client. This client is used both for reads and to execute the Lua script.
const redis = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
redis.on('error', (err) => console.error('Redis Client Error', err));

// Postgres connection pool used for durable records like holds and seats metadata.
const pgPool = new Pool({
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
  database: POSTGRES_DB
});

// Load Lua script used for atomic reservation
const reserveLua = fs.readFileSync('./scripts/redis/reserve.lua', 'utf8');
let reserveSha = null;

async function ensureLua() {
  if (!reserveSha) {
    // Load the Lua script into Redis script cache and keep its SHA for evalSha calls.
    reserveSha = await redis.scriptLoad(reserveLua);
    console.log('Loaded reserve.lua into Redis with SHA', reserveSha);
  }
}

// If seats metadata exists in Postgres for a screening, use that; otherwise create sample seats.
async function getOrCreateSeats(screening_id) {
  const client = await pgPool.connect();
  try {
    // Check if seats for this screening exist (via seat_definitions table)
    const res = await client.query('SELECT external_id, row_label, number, seat_type FROM seats WHERE screen_id = (SELECT screen_id FROM screenings WHERE id = $1) ORDER BY row_label, number', [screening_id]);
    if (res.rows.length > 0) {
      return res.rows.map(r => ({ id: r.external_id, row: r.row_label, number: r.number, type: r.seat_type }));
    }

    // If seats not present, create a default sample layout and persist into seats table.
    const rows = 5;
    const cols = 10;
    const seats = [];
    // For this sample, we need a screen_id for the newly created seats. Get screen_id by using screenings.screen_id
    const sres = await client.query('SELECT screen_id FROM screenings WHERE id = $1 LIMIT 1', [screening_id]);
    let screen_id = null;
    if (sres.rows.length > 0) {
      screen_id = sres.rows[0].screen_id;
    }
    // If no screening found, we will not persist seats but return an in-memory layout
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        seats.push({ id: `R${r}S${c}`, row: `R${r}`, number: c, type: 'REGULAR' });
      }
    }

    if (screen_id) {
      // Persist seats into seats table
      for (const s of seats) {
        await client.query('INSERT INTO seats (screen_id, external_id, row_label, number, seat_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [screen_id, s.id, s.row, s.number, s.type]);
      }
    }

    return seats;
  } finally {
    client.release();
  }
}

// Initialize screening seats into Redis if missing. Reads seat state from seat_states table if available.
async function initSeats(screening_id) {
  // Load seat definitions from Postgres (or create sample ones)
  const seats = await getOrCreateSeats(screening_id);

  // For each seat, check latest seat_states or default to AVAILABLE
  const client = await pgPool.connect();
  try {
    for (const s of seats) {
      // Get latest state for seat for this screening
      const q = await client.query('SELECT state, holder_id, txn_id FROM seat_states WHERE screening_id = $1 AND seat_external_id = $2 ORDER BY updated_at DESC LIMIT 1', [screening_id, s.id]);
      let stateVal = 'AVAILABLE';
      if (q.rows.length > 0) {
        const st = q.rows[0];
        if (st.state === 'SOLD') {
          stateVal = `SOLD:${st.holder_id || ''}:${st.txn_id || ''}`;
        } else if (st.state === 'HELD') {
          stateVal = `HELD:${st.holder_id || ''}:0`;
        } else if (st.state === 'BLOCKED') {
          stateVal = 'BLOCKED';
        }
      }
      const seatKey = `screening:${screening_id}:seat:${s.id}`;
      await redis.set(seatKey, stateVal);
    }
    // Mark initialized flag
    await redis.set(`screening:${screening_id}:seats_initialized`, '1');
    console.log('Initialized seats for screening', screening_id, 'count', seats.length);
  } finally {
    client.release();
  }
}

// GET seat map. Returns seat metadata with current state from Redis.
app.get('/screenings/:id/seats', async (req, res) => {
  const screening_id = req.params.id;
  await ensureLua();
  const initFlag = await redis.get(`screening:${screening_id}:seats_initialized`);
  if (!initFlag) {
    await initSeats(screening_id);
  }

  // Retrieve seat definitions (from Postgres if available) to return consistent metadata
  const seats = await getOrCreateSeats(screening_id);
  const pipeline = redis.multi();
  for (const s of seats) {
    pipeline.get(`screening:${screening_id}:seat:${s.id}`);
  }
  const results = await pipeline.exec();
  const seatStates = seats.map((s, i) => ({ ...s, state: results[i][1] || 'UNKNOWN' }));
  res.json({ screening_id, seats: seatStates });
});

// POST /holds creates an atomic hold for multiple seats using the Lua script and persists the hold in Postgres.
app.post('/holds', async (req, res) => {
  // body: { screening_id, seat_ids: [], customer_id, ttl_seconds, idempotency_key }
  const { screening_id, seat_ids, customer_id, ttl_seconds, idempotency_key } = req.body;
  if (!screening_id || !seat_ids || seat_ids.length === 0) return res.status(400).json({ error: 'screening_id and seat_ids required' });

  await ensureLua();
  const initFlag = await redis.get(`screening:${screening_id}:seats_initialized`);
  if (!initFlag) {
    await initSeats(screening_id);
  }

  const hold_id = uuidv4();
  const ttl = ttl_seconds || 120; // default 2 minutes

  try {
    // If idempotency_key provided, check existing hold
    if (idempotency_key) {
      const client = await pgPool.connect();
      try {
        const existing = await client.query('SELECT id, seat_external_ids, expires_at FROM holds WHERE idempotency_key = $1 LIMIT 1', [idempotency_key]);
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          return res.json({ hold_id: row.id, screening_id, seat_ids: row.seat_external_ids, expires_at: row.expires_at });
        }
      } finally { client.release(); }
    }

    // Keys for Lua script: one key per seat key
    const keys = seat_ids.map((sid) => `screening:${screening_id}:seat:${sid}`);
    const args = [hold_id, ttl.toString(), customer_id || '', Date.now().toString()];

    // Use EVALSHA to run the atomic reservation; Redis will return JSON string
    const reply = await redis.evalSha(reserveSha, keys.length, ...keys, ...args);
    const result = JSON.parse(reply);
    if (!result.success) {
      // If any seat was not available, return 409 with conflicting keys
      return res.status(409).json({ error: 'Some seats are unavailable', conflicting: result.conflicting });
    }

    // Persist the hold into Postgres for durability and reconciliation
    const client = await pgPool.connect();
    try {
      const expires_at = new Date(Date.now() + ttl * 1000).toISOString();
      await client.query('INSERT INTO holds (id, screening_id, seat_external_ids, customer_id, source, expires_at, idempotency_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())', [hold_id, screening_id, seat_ids, customer_id || null, 'web', expires_at, idempotency_key || null]);
    } finally {
      client.release();
    }

    res.json({ hold_id, screening_id, seat_ids, expires_in: ttl });
  } catch (err) {
    console.error('Hold failed', err);
    res.status(500).json({ error: 'hold_failed', details: err.message });
  }
});

// POST /holds/:id/release releases seats held by a specific hold_id. This implementation also updates Postgres by
// deleting or marking the hold as expired (simple approach). In production keep stronger audit & state machine.
app.post('/holds/:id/release', async (req, res) => {
  const hold_id = req.params.id;
  // Scan keys for seats with HELD:hold_id and set to AVAILABLE
  const pattern = `screening:*:seat:*`;
  const stream = redis.scanIterator({ MATCH: pattern });
  const pipeline = redis.multi();
  for await (const key of stream) {
    const val = await redis.get(key);
    if (val && val:startsWith && typeof val === 'string' && val.startsWith(`HELD:${hold_id}:`)) {
      pipeline.set(key, 'AVAILABLE');
    }
  }
  await pipeline.exec();

  // Update hold in Postgres to mark it expired (simple delete here)
  const client = await pgPool.connect();
  try {
    await client.query('DELETE FROM holds WHERE id = $1', [hold_id]);
  } finally { client.release(); }

  res.json({ released: true });
});

// Utility helper to detect string startsWith safely for older Node versions
String.prototype.startsWith = String.prototype.startsWith || function (s) { return this.indexOf(s) === 0; };

const PORT = process.env.PORT || 3001;
(async () => {
  await redis.connect();
  await pgPool.connect();
  await ensureLua();
  app.listen(PORT, () => console.log(`Inventory service listening on ${PORT}`));
})();
