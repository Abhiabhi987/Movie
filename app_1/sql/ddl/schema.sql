-- SQL DDL for Movie Theatre Ticketing System (Postgres) — app_1 schema with holds and seat_states

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS theatres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS screens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theatre_id UUID REFERENCES theatres(id),
  name TEXT,
  layout JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id UUID REFERENCES screens(id),
  external_id TEXT NOT NULL UNIQUE,
  row_label TEXT,
  number INT,
  seat_type TEXT,
  x FLOAT,
  y FLOAT
);

CREATE TABLE IF NOT EXISTS screenings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id UUID REFERENCES screens(id),
  movie_title TEXT,
  start_time TIMESTAMP WITH TIME ZONE,
  end_time TIMESTAMP WITH TIME ZONE,
  pricing JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seat_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screening_id UUID REFERENCES screenings(id),
  seat_external_id TEXT,
  state TEXT, -- AVAILABLE / HELD / RESERVED / SOLD / BLOCKED
  holder_id UUID, -- Hold or booking id
  txn_id TEXT, -- payment txn if sold
  version BIGINT DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screening_id UUID REFERENCES screenings(id),
  seat_external_ids TEXT[],
  customer_id UUID,
  source TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  idempotency_key TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screening_id UUID REFERENCES screenings(id),
  customer_id UUID,
  payment_txn_id TEXT,
  total_amount NUMERIC(10,2),
  status TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID REFERENCES bookings(id),
  seat_external_id TEXT,
  price NUMERIC(10,2)
);
