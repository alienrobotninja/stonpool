/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_NETWORK?: string;
  readonly VITE_POOL_CORE_ADDRESS?: string;
  readonly VITE_JETTON_MINTER_ADDRESS?: string;
  readonly VITE_FAUCET_ADDRESS?: string;
  readonly VITE_ADAPTER_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}