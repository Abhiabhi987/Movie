// Inventory service: provides seat maps and atomic holds using Redis Lua script.
// Comments inside the code explain how each part works.

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Create Redis client. This client is used both for reads and to execute the Lua script.
const redis = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
redis.on('error', (err) => console.error('Redis Client Error', err));

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

// sampleScreening generates a simple seat layout for demo purposes.
function sampleScreening(seId) {
  const rows = 5;
  const cols = 10;
  const seats = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      seats.push({ id: `R${r}S${c}`, row: r, number: c, type: 'REGULAR' });
    }
  }
  return { screening_id: seId, seats };
}

// Initialize screening seats into Redis if missing. This sets each seat key to 'AVAILABLE'.
async function initSeats(screening_id) {
  const key = `screening:${screening_id}:seats_initialized`;
  const exists = await redis.get(key);
  if (exists) return;

  const { seats } = sampleScreening(screening_id);
  const pipeline = redis.multi();
  for (const s of seats) {
    const seatKey = `screening:${screening_id}:seat:${s.id}`;
    pipeline.set(seatKey, 'AVAILABLE');
  }
  pipeline.set(key, '1');
  await pipeline.exec();
  console.log('Initialized seats for screening', screening_id);
}

// GET seat map. Returns seat metadata with current state from Redis.
app.get('/screenings/:id/seats', async (req, res) => {
  const screening_id = req.params.id;
  await ensureLua();
  await initSeats(screening_id);

  const { seats } = sampleScreening(screening_id);
  const pipeline = redis.multi();
  for (const s of seats) {
    pipeline.get(`screening:${screening_id}:seat:${s.id}`);
  }
  const results = await pipeline.exec();
  const seatStates = seats.map((s, i) => ({ ...s, state: results[i][1] || 'UNKNOWN' }));
  res.json({ screening_id, seats: seatStates });
});

// POST /holds creates an atomic hold for multiple seats using the Lua script.
app.post('/holds', async (req, res) => {
  // body: { screening_id, seat_ids: [], customer_id, ttl_seconds }
  const { screening_id, seat_ids, customer_id, ttl_seconds } = req.body;
  if (!screening_id || !seat_ids || seat_ids.length === 0) return res.status(400).json({ error: 'screening_id and seat_ids required' });

  await ensureLua();
  await initSeats(screening_id);

  const hold_id = uuidv4();
  const ttl = ttl_seconds || 120; // default 2 minutes

  try {
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

    // In production persist the hold in Postgres (idempotent).

    res.json({ hold_id, screening_id, seat_ids, expires_in: ttl });
  } catch (err) {
    console.error('Hold failed', err);
    res.status(500).json({ error: 'hold_failed', details: err.message });
  }
});

// POST /holds/:id/release releases seats held by a specific hold_id. This is a simple implementation
// that scans all seat keys and resets ones matching the hold; in production keep a mapping of hold -> seats
app.post('/holds/:id/release', async (req, res) => {
  const hold_id = req.params.id;
  const pattern = `screening:*:seat:*`;
  const stream = redis.scanIterator({ MATCH: pattern });
  const pipeline = redis.multi();
  for await (const key of stream) {
    const val = await redis.get(key);
    if (val && val.startsWith(`HELD:${hold_id}:`)) {
      pipeline.set(key, 'AVAILABLE');
    }
  }
  await pipeline.exec();
  res.json({ released: true });
});

const PORT = process.env.PORT || 3001;
(async () => {
  await redis.connect();
  await ensureLua();
  app.listen(PORT, () => console.log(`Inventory service listening on ${PORT}`));
})();
