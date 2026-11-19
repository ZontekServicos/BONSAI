/**
 * Credenciais das contas de DEMONSTRAÇÃO (criadas por `pnpm demo:seed`).
 *
 * São contas reais no banco: o login passa pela API e pelo RBAC normal.
 * No front, este módulo só é usado quando DEMO_LOGIN_ENABLED é true, o que
 * exige o servidor de desenvolvimento do Vite. Em `vite build` a condição vira
 * `false` e o bundler remove as credenciais do JavaScript de produção.
 */
export const DEMO_ACCOUNTS = {
  gestor: {
    role: "admin",
    nome: "Gestor Demo",
    email: "gestor@bonsai.demo",
    password: "Bonsai@Gestor2026",
  },
  professor: {
    role: "professor",
    nome: "Professor Demo",
    email: "professor@bonsai.demo",
    password: "Bonsai@Professor2026",
  },
  aluno: {
    role: "aluno",
    nome: "Aluno Demo",
    email: "aluno@bonsai.demo",
    password: "Bonsai@Aluno2026",
  },
} as const;

export type DemoProfile = keyof typeof DEMO_ACCOUNTS;
