import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  LayoutDashboard,
  Users,
  LogOut,
  Menu,
  X,
  Wallet,
  ShoppingBag,
  ClipboardCheck,
  KeyRound,
  Eye,
  EyeOff,
  UserRound,
  LockKeyhole,
  ChevronRight,
  LoaderCircle,
  GraduationCap,
  CircleAlert,
} from "lucide-react";
import { DEMO_ACCOUNTS, type DemoProfile } from "./lib/demo-accounts";

// Só no `vite dev` e com VITE_DEMO_LOGIN=true. No build de produção vira `false`
// e o bloco de demonstração (com as credenciais) é eliminado do bundle.
const DEMO_LOGIN_ENABLED = import.meta.env.DEV && import.meta.env.VITE_DEMO_LOGIN === "true";
import { Logo, LOGO_SRC, Wordmark, useScrolled } from "./components/Logo";
import type { User } from "./types/contract";
import { api, login, logout, refresh, errorMessage, streamPresence } from "./lib/api";
import { Card, Form, Notice } from "./components/ui";
import { Dashboard, Students, Presence } from "./components/Academy";
import { Finance, Store, Cash } from "./components/Operations";
import { Member } from "./components/Member";

// min-h-screen (100vh) como base; onde houver suporte, 100svh = altura VISÍVEL no
// celular (o 100vh do iOS inclui a área sob a barra do navegador e "estoura" a tela).
const fullHeight = "min-h-screen supports-[height:100svh]:min-h-svh";
const fieldBox =
  "flex h-14 short:h-12 items-center gap-3 rounded-2xl border border-bonsai-red/35 bg-bonsai-coal/85 px-4 backdrop-blur-sm text-neutral-500 transition " +
  "hover:border-bonsai-red/60 focus-within:border-bonsai-red focus-within:bg-bonsai-red/[0.06] focus-within:text-white " +
  "focus-within:ring-4 focus-within:ring-bonsai-red/20 has-[input:disabled]:opacity-60";
const fieldInput =
  "h-full min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-neutral-500 focus-visible:outline-none";

function Login({ onLogin, notice = "" }: { onLogin: (u: User) => void; notice?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const scrolled = useScrolled();
  const formRef = useRef<HTMLFormElement>(null);
  const alert = error || notice;
  async function signIn(email: string, password: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onLogin((await login(email.trim(), password)).user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void signIn(String(f.get("email")), String(f.get("password")));
  }
  function demo(profile: DemoProfile) {
    const { email, password } = DEMO_ACCOUNTS[profile];
    // Preenche os campos para deixar visível qual conta está sendo usada.
    const form = formRef.current;
    if (form) {
      (form.elements.namedItem("email") as HTMLInputElement).value = email;
      (form.elements.namedItem("password") as HTMLInputElement).value = password;
    }
    void signIn(email, password);
  }
  return (
    <main
      className={`relative isolate flex flex-col overflow-x-clip bg-bonsai-ink text-white lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(440px,0.9fr)] ${fullHeight}`}
    >
      {/* Arte: fundo esmaecido no mobile, coluna-herói no desktop */}
      <section
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[78vh] overflow-hidden lg:relative lg:z-0 lg:flex lg:h-auto lg:flex-col lg:items-center lg:justify-center lg:gap-[4vh] lg:p-10"
      >
        <div className="absolute -top-1/4 -right-1/3 size-[130vw] rounded-full bg-[radial-gradient(circle,rgb(178_34_34/0.45),transparent_62%)] lg:inset-auto lg:top-1/2 lg:left-1/2 lg:size-[70vmin] lg:-translate-1/2" />
        {/* Mobile carrega a arte de 512px (~380 KB); só o desktop baixa a de 1024px. */}
        <picture>
          <source media="(min-width: 1024px)" srcSet={LOGO_SRC.full} />
          <img
            src={LOGO_SRC.mobile}
            alt=""
            width={1024}
            height={1024}
            fetchPriority="high"
            draggable={false}
            onError={(e) => (e.currentTarget.style.display = "none")}
            className="absolute -top-[4vh] -right-[30vw] aspect-square w-[100vw] max-w-none object-contain opacity-40 sm:-right-[12vw] sm:w-[70vw] lg:static lg:w-[min(38vw,32rem,56vh)] lg:opacity-100 lg:drop-shadow-[0_20px_60px_rgb(178_34_34/0.35)]"
          />
        </picture>
        <div className="absolute inset-0 bg-linear-to-b from-bonsai-ink/10 via-bonsai-ink/70 to-bonsai-ink lg:hidden" />
        <div className="relative hidden flex-col items-center gap-5 lg:flex">
          <Wordmark stacked className="text-[clamp(20px,3.6vh,34px)]" />
          <p className="flex items-center gap-3 text-xs font-semibold tracking-[0.35em] text-neutral-400 uppercase">
            Disciplina <i className="size-1 rounded-full bg-bonsai-red" /> Técnica
            <i className="size-1 rounded-full bg-bonsai-red" /> Respeito
          </p>
        </div>
      </section>

      {/* Formulário */}
      <section
        className={`relative flex flex-1 flex-col px-4 pt-[env(safe-area-inset-top)] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8 lg:border-l lg:border-white/5 lg:bg-bonsai-coal/80 lg:px-12 lg:backdrop-blur-sm xl:px-20 ${fullHeight}`}
      >
        <header
          className={`sticky top-0 z-20 -mx-4 shrink-0 px-4 py-3 transition-colors duration-300 sm:-mx-8 sm:px-8 lg:hidden ${
            scrolled ? "border-b border-white/5 bg-bonsai-ink/85 backdrop-blur-md" : ""
          }`}
        >
          <Logo collapsed={scrolled} priority />
        </header>

        {/* flex-1 + justify-center-safe: centraliza quando sobra altura e, quando
            não sobra, alinha ao topo e rola, sem cortar o conteúdo. */}
        <div className="flex flex-1 flex-col justify-center-safe py-6 short:py-4">
          <div className="@container mx-auto w-full max-w-md">
            <header>
              <p className="text-xs font-bold tracking-[0.28em] text-bonsai-ember uppercase">
                Bem-vindo de volta
              </p>
              {/* Tamanho pela largura do container (cqi): cabe em 1 linha com a fonte da marca;
                se ela não carregar, quebra de forma equilibrada em vez de transbordar. */}
              <h1 className="mt-2 -skew-x-6 font-display text-[clamp(2.1rem,12.5cqi,3.75rem)] leading-[0.9] font-black tracking-tight text-balance uppercase italic [text-shadow:0_3px_0_rgb(0_0_0/0.7)]">
                Acesse sua conta
              </h1>
              <span
                aria-hidden="true"
                className="mt-3 block h-1 w-16 -skew-x-12 rounded-full bg-bonsai-red short:mt-2"
              />
              <p className="mt-3 text-[15px] text-neutral-400 short:mt-2 short:text-sm">
                Entre para gerenciar ou acompanhar sua jornada.
              </p>
            </header>

            <form
              ref={formRef}
              className="mt-8 grid gap-5 short:mt-5 short:gap-3.5"
              onSubmit={submit}
            >
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-neutral-100 short:mb-1.5">
                  Usuário
                </span>
                <span className={fieldBox}>
                  <UserRound size={20} aria-hidden="true" className="shrink-0" />
                  <input
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="Digite seu e-mail"
                    required
                    disabled={busy}
                    className={fieldInput}
                  />
                </span>
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-neutral-100 short:mb-1.5">
                  Senha
                </span>
                <span className={fieldBox}>
                  <LockKeyhole size={20} aria-hidden="true" className="shrink-0" />
                  <input
                    name="password"
                    type={visible ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="Digite sua senha"
                    required
                    maxLength={128}
                    disabled={busy}
                    className={fieldInput}
                  />
                  <button
                    type="button"
                    onClick={() => setVisible(!visible)}
                    aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
                    aria-pressed={visible}
                    className="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-neutral-400 transition hover:bg-white/5 hover:text-white focus-visible:outline-bonsai-ember"
                  >
                    {visible ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </span>
              </label>

              {alert && (
                <div
                  role="alert"
                  className="flex animate-alert-in items-start gap-3 rounded-2xl border border-bonsai-red/70 bg-bonsai-red-deep/45 px-4 py-3.5 shadow-[inset_3px_0_0_var(--color-bonsai-red),0_10px_30px_-12px_rgb(178_34_34/0.6)] backdrop-blur-sm short:py-3"
                >
                  <CircleAlert
                    size={20}
                    strokeWidth={2.25}
                    aria-hidden="true"
                    className="mt-px shrink-0 text-bonsai-ember"
                  />
                  <div className="min-w-0 text-sm leading-snug">
                    <p className="font-semibold text-white">
                      {error ? "Não foi possível entrar" : "Serviço indisponível"}
                    </p>
                    <p className="mt-0.5 break-words text-neutral-300">{alert}</p>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="group mt-1 inline-flex h-14 w-full short:h-12 items-center justify-center gap-2 rounded-full bg-linear-to-b from-bonsai-red-bright to-bonsai-red text-lg font-bold text-white shadow-[0_12px_32px_-10px_rgb(178_34_34/0.8)] ring-1 ring-white/10 ring-inset transition hover:brightness-110 active:scale-[0.99] focus-visible:outline-bonsai-ember"
              >
                {busy ? (
                  <>
                    <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
                    Entrando…
                  </>
                ) : (
                  <>
                    Entrar
                    <ChevronRight
                      size={22}
                      strokeWidth={2.5}
                      aria-hidden="true"
                      className="transition-transform group-hover:translate-x-1"
                    />
                  </>
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-[13px] leading-relaxed text-neutral-500 short:mt-4">
              Use o e-mail e a senha cadastrados pela academia.
            </p>

            {DEMO_LOGIN_ENABLED && (
              <section aria-labelledby="demo-title" className="mt-6 short:mt-4">
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-linear-to-r from-transparent to-bonsai-red/40" />
                  <h2
                    id="demo-title"
                    className="text-[11px] font-semibold tracking-[0.25em] text-neutral-400 uppercase"
                  >
                    Acesso de demonstração
                  </h2>
                  <span className="h-px flex-1 bg-linear-to-l from-transparent to-bonsai-red/40" />
                </div>
                <div className="mt-4 flex justify-center gap-3">
                  {(
                    [
                      ["professor", "Professor", GraduationCap],
                      ["aluno", "Aluno", UserRound],
                    ] as const
                  ).map(([profile, label, Icon]) => (
                    <button
                      key={profile}
                      type="button"
                      disabled={busy}
                      onClick={() => demo(profile)}
                      className="inline-flex h-10 items-center gap-2 rounded-full border border-bonsai-red/40 bg-bonsai-coal/85 px-5 text-sm font-semibold text-neutral-200 transition hover:border-bonsai-red hover:bg-bonsai-red/15 hover:text-white focus-visible:outline-bonsai-ember"
                    >
                      <Icon size={16} aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-center text-[11px] text-neutral-600 short:hidden">
                  Visível só no ambiente de desenvolvimento · contas criadas por{" "}
                  <code className="text-neutral-500">pnpm demo:seed</code>
                </p>
              </section>
            )}
          </div>
        </div>

        <small className="block shrink-0 pt-2 text-center text-[11px] tracking-[0.2em] text-neutral-600 uppercase">
          Bonsai Jiu Jitsu Fight · {new Date().getFullYear()}
        </small>
      </section>
    </main>
  );
}
type View = "dashboard" | "students" | "presence" | "finance" | "store" | "cash" | "password";
const items = [
  { id: "dashboard", label: "Visão geral", icon: LayoutDashboard },
  { id: "students", label: "Alunos", icon: Users },
  { id: "presence", label: "Presença", icon: ClipboardCheck },
  { id: "finance", label: "Mensalidades", icon: Wallet },
  { id: "store", label: "Loja e estoque", icon: ShoppingBag },
  { id: "cash", label: "Fluxo de caixa", icon: Wallet },
  { id: "password", label: "Minha senha", icon: KeyRound },
] as const;
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [starting, setStarting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [view, setView] = useState<View>("dashboard");
  const [menu, setMenu] = useState(false);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    let active = true;
    refresh()
      .then((v) => {
        if (active) setUser(v.user);
      })
      .catch((e) => {
        if (active && !(e instanceof Error && "status" in e && e.status === 401))
          setBootError(errorMessage(e));
      })
      .finally(() => {
        if (active) setStarting(false);
      });
    const expired = () => {
      setUser(null);
      setView("dashboard");
    };
    window.addEventListener("bonsai:unauthorized", expired);
    return () => {
      active = false;
      window.removeEventListener("bonsai:unauthorized", expired);
    };
  }, []);
  useEffect(() => {
    if (user?.role !== "admin") return;
    const controller = new AbortController();
    void streamPresence(controller.signal, () => setTick((n) => n + 1));
    return () => controller.abort();
  }, [user?.id, user?.role]);
  async function exit() {
    setExiting(true);
    setError("");
    try {
      await logout();
      setUser(null);
      setView("dashboard");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setExiting(false);
    }
  }
  if (starting)
    return (
      <main
        role="status"
        className="grid min-h-dvh place-content-center justify-items-center gap-8 bg-bonsai-ink px-4 text-white"
      >
        <Logo
          variant="full"
          stacked
          priority
          className="animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm tracking-[0.2em] text-neutral-400 uppercase">
          Conectando à academia…
        </p>
      </main>
    );
  if (!user)
    return (
      <Login
        notice={bootError}
        onLogin={(u) => {
          setUser(u);
          setError("");
          setBootError("");
        }}
      />
    );
  const nav =
    user.role === "admin"
      ? items
      : items.filter((i) => i.id === "dashboard" || i.id === "password");
  const title =
    user.role === "aluno" && view === "dashboard"
      ? "Minha jornada"
      : items.find((i) => i.id === view)?.label;
  return (
    <div className="app">
      <button
        className={`shade ${menu ? "show" : ""}`}
        onClick={() => setMenu(false)}
        aria-label="Fechar menu"
      />
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="side-top">
          <Logo variant="compact" />
          <button onClick={() => setMenu(false)} aria-label="Fechar menu">
            <X />
          </button>
        </div>
        <nav>
          <p>MENU PRINCIPAL</p>
          {nav.map((i) => (
            <button
              key={i.id}
              className={view === i.id ? "active" : ""}
              onClick={() => {
                setView(i.id);
                setMenu(false);
              }}
            >
              <i.icon size={19} />
              {i.id === "dashboard" && user.role === "aluno" ? "Minha carteirinha" : i.label}
            </button>
          ))}
        </nav>
        <div className="profile">
          <div>{user.nome[0]}</div>
          <span>
            <strong>{user.nome}</strong>
            <small>{user.role === "admin" ? "Administrador" : "Aluno"}</small>
          </span>
          <button disabled={exiting} onClick={() => void exit()} aria-label="Sair">
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <main className="page">
        <header className="page-header">
          <div className="title-wrap">
            <button className="menu" onClick={() => setMenu(true)} aria-label="Abrir menu">
              <Menu />
            </button>
            <Logo variant="icon" className="min-[951px]:hidden" />
            <div>
              <h1>{title}</h1>
              <p>
                {user.role === "admin"
                  ? "Sua academia, sob controle."
                  : "Acompanhe sua evolução dentro e fora do tatame."}
              </p>
            </div>
          </div>
        </header>
        <Notice error={error} />
        {view === "password" ? (
          <Card title="Alterar senha">
            <p>Após a alteração, entre novamente em todos os dispositivos.</p>
            <Form
              fields={[
                { name: "senha_atual", label: "Senha atual", type: "password" },
                { name: "nova_senha", label: "Nova senha", type: "password" },
              ]}
              onSubmit={async (b) => {
                await api("/auth/senha", { method: "PATCH", body: b });
                setUser(null);
                setView("dashboard");
              }}
            />
          </Card>
        ) : user.role === "aluno" ? (
          <Member />
        ) : (
          <>
            {view === "dashboard" && <Dashboard tick={tick} />}
            {view === "students" && <Students />}
            {view === "presence" && <Presence tick={tick} />}
            {view === "finance" && <Finance />}
            {view === "store" && <Store />}
            {view === "cash" && <Cash />}
          </>
        )}
      </main>
    </div>
  );
}
