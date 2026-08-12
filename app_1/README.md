# app_1 — MVP Microservices (Node.js)

This folder contains the MVP microservices implementation for the Movie Theatre Ticketing System. It is designed for local development using Docker Compose and focuses on correctness for seat holds & bookings.

Structure
- services/inventory: seat map API and atomic holds via Redis Lua script
- services/booking: booking confirmation and payment webhook handling
- services/payment-stub: fake payment gateway for local testing
- sql/ddl/schema.sql: Postgres schema DDL (commented)
- docker-compose.yml: local dev composition (Postgres, Redis, services)
- examples/client/flow.js: demo client that performs hold -> pay -> confirm
- docs/architecture.md: short architecture notes

How to run (local dev)
1. Install Docker and Docker Compose.
2. From this folder run: docker-compose up --build
3. Wait for services to start and then run the example client:
   node examples/client/flow.js

Notes
- This is intentionally a minimal, educational scaffold. Production deployments must add persistence to Postgres, an event bus, monitoring, backups, and secure configuration.
