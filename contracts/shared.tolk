// shared: global opcodes, error codes, and shared structures for STONPool.
// Imported by every contract. Everything here is part of the on-chain wire
// format and storage ABI. This is a frozen ABI: any change here is breaking.

// Standard TEP-74 jetton op codes. The vault receives transfer_notification on
// the pool jetton wallet and sends transfer to pay out; the rest are here so
// the vault and adapter recognize them without redefining.
const OP_JETTON_TRANSFER = 0x0f8a7ea5;
const OP_JETTON_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_JETTON_INTERNAL_TRANSFER = 0x178d4519;
const OP_JETTON_EXCESSES = 0xd53276db;
const OP_JETTON_BURN = 0x595f07bc;
const OP_JETTON_BURN_NOTIFICATION = 0x7bdd97de;
const OP_PROVIDE_WALLET_ADDRESS = 0x2c76b973;
const OP_TAKE_WALLET_ADDRESS = 0xd1735400;

// Deposit intent, carried in the jetton transfer forward_payload so the vault
// can tell a pool deposit from a stray transfer.
const OP_DEPOSIT = 0x10000001;

// pool-core
const OP_REQUEST_WITHDRAW = 0x10000002;
const OP_CLAIM_PRIZE = 0x10000003;
const OP_ADVANCE_EPOCH = 0x10000004;
const OP_PAYOUT = 0x10000005;

// draw-engine
const OP_COMMIT = 0x10000011;
const OP_REVEAL = 0x10000012;
const OP_RUN_DRAW = 0x10000013;
const OP_DRAW_RESULT = 0x10000014;

// selection-ledger
const OP_SELECT_WINNERS = 0x10000021;
const OP_WINNERS_RESULT = 0x10000022;

// yield adapter interface (C5): pool-core and every adapter agree on these.
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_WITHDRAW_PRINCIPAL = 0x10000032;
const OP_HARVEST_YIELD = 0x10000033;
const OP_ADAPTER_REPORT = 0x10000034;

// param-governor (C8)
const OP_PROPOSE_PARAMS = 0x10000041;
const OP_EXECUTE_PARAMS = 0x10000042;
const OP_PARAMS_UPDATED = 0x10000043;

// test infrastructure (mock stables + faucet). Faucet-internal ops live with
// the faucet; these are the cross-contract ones.
const OP_MINT = 0x10000051;
const OP_FAUCET_REQUEST = 0x10000052;

// Exit / error codes. Custom range starts at 400 to stay clear of TVM standard
// codes (0..255) and common tooling ranges.
const ERR_UNKNOWN_OP = 400;
const ERR_UNAUTHORIZED = 401;
const ERR_WRONG_SENDER = 402;
const ERR_WRONG_JETTON = 403;
const ERR_INSUFFICIENT_VALUE = 404;
const ERR_DEPOSIT_CLOSED = 410;
const ERR_WITHDRAW_TOO_EARLY = 411;
const ERR_NOTHING_TO_WITHDRAW = 412;
const ERR_EPOCH_NOT_ENDED = 420;
const ERR_EPOCH_ALREADY_DRAWN = 421;
const ERR_NO_DEPOSITORS = 422;
const ERR_NOT_COMMIT_WINDOW = 430;
const ERR_NOT_REVEAL_WINDOW = 431;
const ERR_NO_COMMIT = 432;
const ERR_BAD_REVEAL = 433;
const ERR_INSUFFICIENT_BOND = 434;
const ERR_TIMELOCK_ACTIVE = 440;
const ERR_INVALID_PARAMS = 441;
const ERR_ADAPTER_FAILED = 450;
const ERR_BUSY = 451;

type Bps = uint16;
type Timestamp = uint32;
type EpochId = uint32;

// Governed pool parameters. param-governor sets them, pool-core reads them.
struct PoolConfig {
    epochLength: uint32
    depositCutoff: uint32
    commitWindow: uint32
    revealWindow: uint32
    minHoldEpochs: uint16
    prizeTiers: uint8
    skimBps: uint16
    drawBond: coins
}

// Adapter -> pool-core callback after a deposit/withdraw/harvest settles.
struct AdapterReport {
    reportedOp: uint32
    principal: coins
    yieldAmount: coins
    success: bool
}

// draw-engine -> pool-core once the seed is finalized.
struct DrawResult {
    epoch: uint32
    seed: uint256
}

// Deposit hint carried in the jetton transfer forward_payload.
struct DepositPayload {
    op: uint32
    beneficiary: address
}
