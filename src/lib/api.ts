import type { AuthResponse, ApiError } from "../types/contract";

const configured = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
export const apiBase = configured
  ? configured.endsWith("/api/v1")
    ? configured
    : `${configured}/api/v1`
  : "/api/v1";
let token: string | null = null;
let epoch = 0;
let refreshing: Promise<AuthResponse> | null = null;
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
async function response<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as ApiError | null;
    throw new HttpError(
      r.status,
      body?.error.code ?? "ERRO_INTERNO",
      body?.error.message ?? "Não foi possível conectar ao servidor.",
      body?.error.details,
    );
  }
  return r.status === 204 ? (undefined as T) : r.json();
}
async function sessionLock<T>(fn: () => Promise<T>): Promise<T> {
  // Serialize cookie rotation across tabs, where Web Locks is supported.
  return await (navigator.locks ? navigator.locks.request("bonsai-session", fn) : fn());
}
export function refresh() {
  if (!refreshing) {
    const started = epoch;
    refreshing = sessionLock(async () => {
      const value = await response<AuthResponse>(
        await fetch(`${apiBase}/auth/refresh`, { method: "POST", credentials: "include" }),
      );
      if (epoch === started) token = value.access_token;
      return value;
    }).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}
export async function login(email: string, password: string) {
  return sessionLock(async () => {
    const value = await response<AuthResponse>(
      await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    epoch++;
    token = value.access_token;
    return value;
  });
}
export async function logout() {
  await sessionLock(async () => {
    await response<void>(
      await fetch(`${apiBase}/auth/logout`, { method: "POST", credentials: "include" }),
    );
    epoch++;
    token = null;
  });
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    /** Corpo binário (ex.: foto); o Content-Type vem do próprio Blob. */
    raw?: Blob;
    signal?: AbortSignal;
    key?: string;
  } = {},
  retry = true,
): Promise<T> {
  const started = epoch;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.raw) headers["Content-Type"] = options.raw.type;
  else if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  const r = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers,
    credentials: "include",
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal,
  });
  if (r.status === 401 && retry) {
    if (started !== epoch) throw new HttpError(401, "NAO_AUTENTICADO", "A sessão foi alterada.");
    try {
      await refresh();
    } catch (error) {
      if (started === epoch) {
        epoch++;
        token = null;
        window.dispatchEvent(new Event("bonsai:unauthorized"));
      }
      throw error;
    }
    if (started !== epoch) throw new HttpError(401, "NAO_AUTENTICADO", "A sessão foi alterada.");
    return api<T>(path, options, false);
  }
  return response<T>(r);
}
export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : "Não foi possível concluir a operação.";
}
export async function streamPresence(signal: AbortSignal, onChange: () => void) {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      if (!token) await refresh();
      const r = await fetch(`${apiBase}/presencas/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
        signal,
      });
      if (r.status === 401) {
        await refresh();
        continue;
      }
      if (!r.ok || !r.body) throw new Error("Stream indisponível");
      onChange();
      delay = 1000;
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (event.includes("event: presenca")) onChange();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
    });
    delay = Math.min(delay * 2, 30000);
  }
}
