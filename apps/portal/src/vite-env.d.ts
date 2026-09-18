/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** dsh Web UI 的专属 authority(如 http://dsh.localhost:8080/)。 */
  readonly VITE_DSH_UI_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
