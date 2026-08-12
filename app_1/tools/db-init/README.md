# app_1 DB Init

This script creates the database schema and seeds a sample theatre, screen, screening and seats. It also loads the seat keys into Redis so the inventory service can serve seat maps immediately.

It is invoked by docker-compose as a one-shot service named `db-init`.
