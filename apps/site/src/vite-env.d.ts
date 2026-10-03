/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NEAL_SOURCE_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
