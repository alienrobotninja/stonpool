// Mock stablecoin jetton (TEP-74/TEP-89). Test infrastructure for STONPool.
// Adapted from nikandr-surkov/tolk-jetton-blueprint; wallet patched for Tolk 1.4.x.

// 6905(computational_gas_price) * 1000(cur_gas_price) = 6905000 ~= 0.01 TON
const MINIMAL_MESSAGE_VALUE_BOUND = ton("0.01")

const MIN_TONS_FOR_STORAGE = ton("0.01")

const JETTON_WALLET_GAS_CONSUMPTION = ton("0.015")
