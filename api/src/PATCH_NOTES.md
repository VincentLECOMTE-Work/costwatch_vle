# PATCH NOTES (fix39)

- Fix: accounts-config.json path resolution. The server now searches:
  - $ACCOUNTS_CONFIG (if provided)
  - /app/src/accounts-config.json
  - /app/accounts-config.json
  - api/src/accounts-config.json (alongside server.js)
  - ./accounts-config.json (cwd)

- Fix: Cost Explorer `top-combos` — limits GroupBy to 2 (LINKED_ACCOUNT, SERVICE) and aggregates across days.

- Added/normalized endpoints expected by the UI (no more 404):
  - GET /api/costs/by-service
  - GET /api/costs/daily-total
  - GET /api/costs/top-combos
  - GET /api/accounts
  - GET /api/ri/coverage
  - GET /api/ri/utilization
  - GET /api/ri/utilization-by
  - GET /api/ec2/instances
  - GET /api/ebs/volumes
  - GET /api/ri/reservations
  - GET /api/debug/inventory
  - GET /api/debug/accounts-config
  - GET /api/debug/scheduler

- Fix: All list endpoints return arrays (or objects with {items}) to avoid `i.map is not a function` on the UI.

- Inventory: added robust EC2/EBS/ReservedInstances collectors with pagination and per-account/per-region isolation.
