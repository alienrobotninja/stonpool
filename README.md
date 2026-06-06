# STONPool

Automated, trustless, no-loss prize pool on TON, built on STON.fi. Depositors keep their principal; pooled principal earns yield through a STON.fi stable pool (USDT/USDC, USDT/USDe fallback), and each epoch the accrued yield is awarded to a depositor selected by a verifiable on-chain draw. No depositor can lose principal outside a stablecoin depeg event, which is socialized and disclosed.

Submission target: STON.fi grant program.

## Stack

- On-chain: Tolk (TVM), Blueprint toolchain, `@ton/sandbox` for tests.
- Backend: Python 3.12 / FastAPI, Postgres, Alembic.
- Frontend: TypeScript / React / Vite, TON Connect, `@ston-fi/sdk` + `@ston-fi/api`.
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
- `B1 stonfi-client` read wrapper over api.ston.fi.
- `B2 indexer` chain tail, opcode decode, read model.
- `B3 scheduler` permissionless epoch poker (advance/commit/reveal/draw).
- `B4 api` REST for the frontend.

Frontend (TS/React):
- `F0 bindings` Tolk-to-TS contract wrappers.
- `F1 wallet` TON Connect.
- `F2 deposit-withdraw` pool messaging, Omniston swap-then-deposit.
- `F3 dashboard` live APR, odds, prize estimate, history.

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
backend/          FastAPI service
  app/
  alembic/
  tests/
frontend/         Vite + React app
  src/
addresses/        per-network contract address registry (json)
```

## Prerequisites

- Node 22+ (see `.nvmrc`)
- Python 3.12+
- Postgres 15+
- A TON testnet wallet funded from the faucet

## Setup

Copy `.env.example` to `.env` and fill values. Never commit `.env` or any mnemonic/key material.

Per-track install and run commands are added as each track lands.

## Networks

Testnet first. STON.fi v2 contracts are deployed on testnet, but `api.ston.fi` serves mainnet only and testnet stable liquidity must be self-seeded via the mock token + faucet infra. Real prize economics exist only on mainnet.

## License

MIT. See `LICENSE`.