# STONPOOL testnet deploy

End-to-end bring-up of the full stack on TON testnet. Run from the repo root. Two paths: a native
runbook (sections 1-9) and a Docker path for the off-chain services (section 10).

The deployer wallet drives every on-chain step; nothing here needs an admin key in a browser. Keep
mnemonics out of the repo. The demo preset (`--demo`) uses short epoch/commit/reveal windows so a
full cycle runs in minutes.

## 0. Prerequisites

- Node 24.16.0 (`.nvmrc`), Python 3.12, Postgres 15 (or use the Docker path).
- A TON testnet wallet (v4/v5) for the deployer/operator, plus its 24-word mnemonic.
- Optional: a toncenter testnet API key (higher rate limits).

## 1. Fund the deployer

Top up the deployer from `@testgiver_ton_bot` on testnet. Budget roughly 4-5 test TON: contract
storage + deploy values (~1.5), wiring messages, faucet funding, and the demo cycle bond. Request
multiple times if needed.

## 2. Deploy the mock stables + faucet

```
cd contracts
npm install
npx blueprint run deployMockStack --testnet
```

Record the two minter addresses (jUSDT, jUSDC) and the faucet address it prints. Fund the faucet with
a few test TON so it can pay mint gas, and confirm its minters are configured (the script wires
`ConfigureMinters`).

## 3. Deploy the protocol

Pass the jUSDT minter from step 2 as the pool's underlying. `--demo` applies the short-window preset.

```
JETTON_MINTER=<jUSDT_minter> npx blueprint run deployStonpool --testnet --demo
```

The script deploys the mock STON.fi venue, vault, stonfi adapter, governor, draw-engine, and pool-core
in dependency order, runs the wiring messages, prints an address block for both `.env` files, and
writes the full set to `addresses/<network>.json`.

## 4. Wire the env files

Paste the emitted block into `backend/.env` and `frontend/.env` (copy from each `.env.example`).
Then fill the remaining values by hand:

- `backend/.env`: `STONPOOL_TONCENTER_API_KEY`, `STONPOOL_OPERATOR_MNEMONIC` (24 words),
  `STONPOOL_DEPOSIT_CUTOFF` to match the deployed preset (demo = 120, default = 600).
- `frontend/.env`: `VITE_FAUCET_ADDRESS` (step 2), `VITE_APP_URL` (the origin you will deploy to),
  `VITE_API_BASE_URL` (the backend's public URL).

## 5. Migrate + run the backend API

```
cd backend
python -m venv venv && . venv/bin/activate   # Windows: .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
uvicorn app.api.app:create_app --factory --host 0.0.0.0 --port 8000
```

The indexer and API read the chain through toncenter; the `/wallet` endpoint derives jetton wallets
from `STONPOOL_JETTON_MASTER_ADDRESS`.

## 6. Run the keeper

Dry-run first (no `STONPOOL_OPERATOR_MNEMONIC` set) to watch phase detection without broadcasting:

```
python -m app.keeper
```

Then set `STONPOOL_OPERATOR_MNEMONIC` and rerun to let it drive harvest/advance/commit/reveal/settle
on the epoch clock.

## 7. Seed the pool

Populates the leaderboard. With no `DEMO_MNEMONICS`, the deployer is the sole depositor; supply
semicolon-separated 24-word phrases to seed several wallets.

```
cd contracts
JETTON_MINTER=<jUSDT_minter> \
STONPOOL_POOL_CORE_ADDRESS=<pool_core> \
FAUCET_ADDRESS=<faucet> \
npx blueprint run seedDemoPool --testnet
```

## 8. Run a full draw cycle

Injects yield, harvests, advances the epoch, then commits/reveals/settles so a draw lands and pays
out. Set the same address env vars the script reads (see the script header), then:

```
npx blueprint run runDemoCycle --testnet --demo
```

It waits out the on-chain commit and reveal windows, so expect it to run for a few minutes on the
demo preset. The keeper (or indexer) records the draw and payouts the API then serves.

## 9. Build + deploy the frontend

```
cd frontend
npm ci
npm run build            # requires VITE_API_BASE_URL, VITE_POOL_CORE_ADDRESS, VITE_FAUCET_ADDRESS
```

Deploy `dist/` to any static host (Codeberg Pages, Netlify, Vercel). The build writes
`dist/tonconnect-manifest.json` from `VITE_APP_URL`, so the wallet manifest matches the served origin
automatically. Confirm `https://<origin>/tonconnect-manifest.json` and `/icon-180.png` resolve.

## 10. Docker path (off-chain services)

The on-chain steps (1-3, 7-8) always run via Blueprint. The backend API, keeper, Postgres, and the
static frontend run via Compose, replacing sections 5-6 and 9. `docker-compose.yml` defines five
services: `db` (Postgres), `migrate` (one-shot `alembic upgrade head`), `api` (:8000), `keeper`, and
`frontend` (:8080).

Fill `backend/.env` as in step 4 (the compose file overrides `STONPOOL_DATABASE_URL` to point at the
`db` service, so leave that one as-is). The frontend image inlines its config at build time, so put
the `VITE_*` values in a repo-root `.env` that Compose reads for build-arg interpolation:

```
# ./.env (root), consumed by docker compose for the frontend build args
VITE_APP_URL=http://localhost:8080
VITE_API_BASE_URL=http://localhost:8000
VITE_POOL_CORE_ADDRESS=<pool_core>
VITE_FAUCET_ADDRESS=<faucet>
```

Then:

```
docker compose up -d --build
```

This starts Postgres, runs migrations to completion, serves the API on `:8000`, starts the keeper,
and serves the built frontend on `:8080`. The frontend build fails fast if the required `VITE_*`
addresses are unset (the env guard) - that is intentional, not a bug.

Keeper live mode: the `keeper` image is built with `INSTALL_KEEPER=true`, so `pytoniq` is present and
the keeper can broadcast. It still dry-runs (records, no broadcast) until `STONPOOL_OPERATOR_MNEMONIC`
is set in `backend/.env`. Validate `app/keeper/wallet_sender.py` against the installed `pytoniq`
version before relying on live broadcasts - that signing path is wired here but not exercised by the
test suite.

## CI

Codeberg (Woodpecker) runs three parallel workflows under `.woodpecker/` on every push and PR:
contracts (`blueprint build --all` + jest), backend (ruff + pytest), frontend (lint, typecheck, test,
production-scoped `npm audit`, build). The frontend build runs against placeholder addresses so the
env guard passes in CI.