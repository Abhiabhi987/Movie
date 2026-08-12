# Architecture Notes for app_1

This folder implements the core inventory and booking flow using Node.js microservices and Redis for fast seat holds.

Key decisions and how they map to the system design:
- Redis is used for atomic seat holds using a Lua script (fast-path to avoid double-booking under contention).
- Booking service finalizes holds into sold seats after payment notification.
- Payment stub simulates a gateway and calls a webhook on booking service. In production replace with a real gateway.
- Postgres schema is provided for durable booking records. The MVP keeps Redis authoritative for holds and sold state; in production persist these changes in a DB transaction.
