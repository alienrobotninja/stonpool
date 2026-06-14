const env = import.meta.env;

export const config = {
  apiBaseUrl: (env.VITE_API_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, ""),
  network: env.VITE_NETWORK ?? "testnet",
  addresses: {
    poolCore: env.VITE_POOL_CORE_ADDRESS ?? "",
    jettonMinter: env.VITE_JETTON_MINTER_ADDRESS ?? "",
    faucet: env.VITE_FAUCET_ADDRESS ?? "",
    adapter: env.VITE_ADAPTER_ADDRESS ?? "",
  },
} as const;