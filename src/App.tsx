import { useEffect, useState, type FormEvent } from "react";
import {
  ShieldCheck,
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
} from "lucide-react";
import type { User } from "./types/contract";
import { api, login, logout, refresh, errorMessage, streamPresence } from "./lib/api";
import { Card, Form, Notice } from "./components/ui";
import { Dashboard, Students, Presence } from "./components/Academy";
import { Finance, Store, Cash } from "./components/Operations";
import { Member } from "./components/Member";

function Brand() {
  return (
    <div className="brand compact">
      <b>
        <ShieldCheck size={22} />
      </b>
      <span>
        FIGHT<em>CONTROL</em>
      </span>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      onLogin((await login(String(f.get("email")).trim(), String(f.get("password")))).user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-art" aria-hidden="true">
        <div className="grid-lines" />
        <p className="eyebrow">Gestão que acompanha seu ritmo</p>
        <h1>
          Sua academia.
          <br />
          <em>Sob controle.</em>
        </h1>
        <p className="art-copy">Alunos, presença, graduações e finanças em um só lugar.</p>
      </section>
      <section className="login-panel">
        <div className="login-inner">
          <Brand />
          <header className="login-heading">
            <span>Bem-vindo de volta</span>
            <h2>Acesse sua conta</h2>
            <p>Entre para gerenciar ou acompanhar sua jornada.</p>
          </header>
          <form className="login-form" onSubmit={submit}>
            <label>
              E-mail
              <div className="field">
                <Users size={18} />
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="seu@email.com"
                  required
                  disabled={busy}
                />
              </div>
            </label>
            <label>
              Senha
              <div className="field">
                <ShieldCheck size={18} />
                <input
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Sua senha"
                  required
                  maxLength={128}
                  disabled={busy}
                />
                <button
                  type="button"
                  onClick={() => setVisible(!visible)}
                  aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <Notice error={error} />
            <button className="primary" disabled={busy}>
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </form>
          <p className="login-help">Use o e-mail e a senha cadastrados pela academia.</p>
        </div>
        <small>Fight Control · Bonsai</small>
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
      <main className="startup" role="status">
        <Brand />
        <p>Conectando à academia…</p>
      </main>
    );
  if (!user)
    return (
      <>
        <Notice error={bootError} />
        <Login
          onLogin={(u) => {
            setUser(u);
            setError("");
            setBootError("");
          }}
        />
      </>
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
          <Brand />
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
