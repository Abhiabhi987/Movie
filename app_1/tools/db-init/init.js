// DB Init script: applies schema and seeds sample data into Postgres, then loads seat keys into Redis.
// Run this once during docker-compose startup as a one-shot task.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('redis');

const POSTGRES_HOST = process.env.POSTGRES_HOST || 'postgres';
const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;
const POSTGRES_USER = process.env.POSTGRES_USER || 'postgres';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'postgres';
const POSTGRES_DB = process.env.POSTGRES_DB || 'movie';
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

async function run() {
  const pool = new Pool({ host: POSTGRES_HOST, port: POSTGRES_PORT, user: POSTGRES_USER, password: POSTGRES_PASSWORD, database: POSTGRES_DB });
  const redis = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
  await redis.connect();
  const client = await pool.connect();
  try {
    console.log('Applying schema...');
    const ddl = fs.readFileSync(path.join(__dirname, '../../sql/ddl/schema.sql'), 'utf8');
    await client.query(ddl);
    console.log('Schema applied. Seeding sample data...');

    // Seed a sample theatre, screen, screening if not exists
    const theatreRes = await client.query("INSERT INTO theatres (id, name, address, created_at) VALUES (gen_random_uuid(), 'Demo Theatre', '123 Demo St', now()) RETURNING id ON CONFLICT DO NOTHING");
    // For simplicity upsert via checking count
    const cnt = await client.query('SELECT count(*) FROM screenings');
    if (Number(cnt.rows[0].count) === 0) {
      // create screen
      const screenRes = await client.query("INSERT INTO screens (id, theatre_id, name, layout, created_at) VALUES (gen_random_uuid(), (SELECT id FROM theatres LIMIT 1), 'Screen 1', '{}', now()) RETURNING id");
      const screen_id = screenRes.rows[0].id;
      // create a screening
      const screeningRes = await client.query("INSERT INTO screenings (id, screen_id, movie_title, start_time, end_time, pricing, created_at) VALUES (gen_random_uuid(), $1, 'Demo Movie', now() + interval '1 hour', now() + interval '3 hour', '{}', now()) RETURNING id", [screen_id]);
      const screening_id = screeningRes.rows[0].id;
      console.log('Created screening', screening_id);

      // create seats for this screen and initial seat_states
      const rows = 5; const cols = 10;
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) {
          const external_id = `R${r}S${c}`;
          await client.query('INSERT INTO seats (screen_id, external_id, row_label, number, seat_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [screen_id, external_id, `R${r}`, c, 'REGULAR']);
          await client.query('INSERT INTO seat_states (screening_id, seat_external_id, state, holder_id, txn_id, updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT DO NOTHING', [screening_id, external_id, 'AVAILABLE', null, null]);
        }
      }

      // After seeding DB, load seats into Redis
      const resSeats = await client.query('SELECT external_id FROM seats WHERE screen_id = $1 ORDER BY row_label, number', [screen_id]);
      for (const row of resSeats.rows) {
        const seatKey = `screening:${screening_id}:seat:${row.external_id}`;
        await redis.set(seatKey, 'AVAILABLE');
      }
      await redis.set(`screening:${screening_id}:seats_initialized`, '1');
      console.log('Seeded seats into Redis for screening', screening_id);
    } else {
      console.log('Screenings already present; skipping seed.');
    }

    console.log('DB init complete.');
  } catch (err) {
    console.error('DB init failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    await redis.disconnect();
  }
}

run();
