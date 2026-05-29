/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHELBY_API_KEY: string;
  readonly VITE_SHELBY_ACCOUNT_ADDRESS: string;
  readonly VITE_APTOS_API_KEY?: string;
  readonly VITE_SHELBY_ACCOUNT_PRIVATE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}