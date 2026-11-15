/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** "true" exibe os botões de acesso de demonstração (somente em `vite dev`). */
  readonly VITE_DEMO_LOGIN?: string;
}
