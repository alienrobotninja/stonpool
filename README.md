# STONPool

Automated, trustless, no-loss prize pool on TON, built on STON.fi. Depositors keep their principal; pooled principal earns yield through a STON.fi stable pool (USDT/USDC, USDT/USDe fallback), and each epoch the accrued yield is awarded to a depositor selected by a verifiable on-chain draw. No depositor can lose principal outside a stablecoin depeg event, which is socialized and disclosed.

## Stack

- On-chain: Tolk (TVM), Blueprint toolchain, `@ton/sandbox` for tests.
- Backend: Python 3.12 / FastAPI, Postgres, Alembic.
- Frontend: TypeScript / React / Vite, TON Connect; live pool data from the backend API.
- CI: Codeberg (Woodpecker).

## Module map

On-chain (Tolk):
- `C0 shared` schemas, opcodes, error codes, storage layouts. Freeze artifact.
- `C1 pool-core` custody, depositor ledger, epoch FSM, payout orchestration.
- `C2 selection-ledger` cumulative-balance lookup for winner selection.
- `C3 draw-engine` bonded commit-reveal, slash-on-no-reveal, N-winner derivation.
- `C4 jetton-vault` transfer_notification verification, deposit bounce handling.
- `C5 yield-adapter-iface` deposit_principal / harvest_yield / withdraw_principal / get_deployed_value.
- `C6 yield-adapter-stonfi` real STON.fi router LP integration, referral fees.
- `C7 yield-adapter-mock` synthetic yield for sandbox and demo.
- `C8 param-governor` time-locked, multisig-gated pool params.

Mock infra: custom Jetton masters (mock USDT/USDC) + on-chain faucet.

Backend (FastAPI):
- `B0 persistence` Postgres models + migrations.
- `B1 quote-source` LP reserve/supply reads; testnet reads the deployed mock STON.fi pool on-chain (api.ston.fi is mainnet-only).
- `B2 indexer` chain tail, opcode decode, read model.
- `B3 keeper` permissionless epoch poker (advance/commit/reveal/draw); runs as `python -m app.keeper`.
- `B4 api` REST for the frontend.

Frontend (TS/React):
- `F0 bindings` Tolk-to-TS contract wrappers.
- `F1 wallet` TON Connect.
- `F2 deposit-withdraw` pool messaging via direct jUSDT TEP-74 transfers.
- `F3 dashboard` odds, prize estimate, draw history, activity, sourced from the backend API.

Tooling:
- `T0 test-harness` full-lifecycle sandbox suites.
- `T1 deploy-ops` Blueprint deploy scripts, address registry.

## Intended layout

```
contracts/        Blueprint project: Tolk sources, wrappers, sandbox tests, deploy scripts
  contracts/        Tolk (.tolk) sources
  wrappers/         TS contract wrappers (F0 bindings live here)
  tests/            @ton/sandbox suites (T0)
  scripts/          deploy + ops (T1)
  addresses/        per-network registry (json), written by deployStonpool
backend/          FastAPI service
  app/
  alembic/
  tests/
frontend/         Vite + React app
  src/
```

## Prerequisites

- Node 24.16.0 (see `.nvmrc`)
- Python 3.12+
- Postgres 15+
- A TON testnet wallet funded from the faucet

## Setup

Copy `.env.example` to `.env` and fill values. Never commit `.env` or any mnemonic/key material.

### Quickstart (local)

```
# contracts: compile + sandbox suites
cd contracts && npm install && npx blueprint build --all && npx jest

# backend: API + tests (sqlite for tests; Postgres for run)
cd backend && python -m venv venv && . venv/bin/activate && pip install -r requirements.txt -r requirements-dev.txt
ruff check app tests && pytest -q

# frontend: dev server / checks
cd frontend && npm ci && npm run dev
npm run lint && npm run typecheck && npm run test
```

### Testnet deploy

See [`DEPLOY.md`](DEPLOY.md) for end-to-end testnet bring-up (Blueprint deploy scripts, keeper, demo
seed + draw cycle, static frontend) and the Docker Compose path for the off-chain services.

## Networks

Testnet first. STON.fi v2 contracts are deployed on testnet, but `api.ston.fi` serves mainnet only and testnet stable liquidity must be self-seeded via the mock token + faucet infra. Real prize economics exist only on mainnet.

## Scope

Shipped is a complete testnet MVP: on-chain protocol, backend indexer/API/keeper, frontend dApp, deploy + demo tooling, CI, and Docker. Three items are deliberately deferred to a mainnet cut, since none can be exercised or verified against testnet (the real venue and its API are mainnet-only):

- Real `api.ston.fi` client for live APR and referral accruals (testnet uses on-chain mock-pool reads).
- `@ston-fi/sdk` live-APR dashboard wiring (the dApp sources APR/odds/prize from the backend API).
- Omniston swap-then-deposit for non-stablecoin entry (deposits are direct jUSDT TEP-74).

These belong to a future `feat/mainnet-integration` effort with its own testing story (forked-mainnet or staged rollout), not the testnet MVP.

## License

MIT. See `LICENSE`.