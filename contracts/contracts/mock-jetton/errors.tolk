// Mock stablecoin jetton (TEP-74/TEP-89). Test infrastructure for STONPool.
// Adapted from nikandr-surkov/tolk-jetton-blueprint; wallet patched for Tolk 1.4.x.

// these error codes are quite strange, but they are exactly the same as in FunC implementation

const ERR_INVALID_OP = 709
const ERR_NOT_FROM_ADMIN = 73
const ERR_UNAUTHORIZED_BURN = 74
const ERR_NOT_ENOUGH_AMOUNT_TO_RESPOND = 75
const ERR_NOT_FROM_OWNER = 705
const ERR_NOT_ENOUGH_TON = 709
const ERR_NOT_ENOUGH_GAS = 707
const ERR_INVALID_WALLET = 707
const ERR_WRONG_WORKCHAIN = 333
const ERR_NOT_ENOUGH_BALANCE = 706
const ERR_INVALID_PAYLOAD = 708
