import { DurableObject } from "cloudflare:workers";
import type { EntRequest } from "@archymedes/engine/api-types";
import type { WorkspaceInput, WorkspaceSlices } from "@archymedes/engine/templates";
import { pkcePair, randomToken, readSession, readValue, signSession, signValue, verifyIdToken } from "./auth";
import type { User } from "./auth";
import { DirectoryCore } from "./directory";
import { Hosted, HostedError } from "./hosted";
import type { DirectoryLike, TenantLike } from "./hosted";
import type { Kv } from "./store";
import { TenantCore } from "./tenant";

export interface Env {
  ASSETS: Fetcher;
  TENANTS: DurableObjectNamespace<TenantStore>;
  DIRECTORY: DurableObjectNamespace<DirectoryStore>;
  SESSION_KEY: string;
  CONNECTOR_KEY: string;
  /** Optional until R2 is enabled on the account. */
  DOCS?: R2Bucket;
  AUTHKIT_ISSUER: string;
  PUBLIC_ORIGIN: string;
}

const now = () => new Date().toISOString();
const SESSION_HOURS = 12;

function storageKv(storage: DurableObjectStorage): Kv {
  return {
    get: (k) => storage.get<string>(k),
    put: (entries) => storage.put(entries),
    delete: async (keys) => {
      await storage.delete(keys);
    },
  };
}

/** One Durable Object per company workspace. */
export class TenantStore extends DurableObject<Env> implements TenantLike {
  private core = new TenantCore(storageKv(this.ctx.storage), now);
  init(w: WorkspaceSlices) {
    return this.core.init(w);
  }
  setSecret(sourceId: string, sealed: string) {
    return this.core.setSecret(sourceId, sealed);
  }
  getSecret(sourceId: string) {
    return this.core.getSecret(sourceId);
  }
  identity(memberId: string) {
    return this.core.identity(memberId);
  }
  handle(memberId: string, req: EntRequest) {
    return this.core.handle(memberId, req);
  }
}

/** The single directory of people → workspaces, and invites. */
export class DirectoryStore extends DurableObject<Env> implements DirectoryLike {
  private core = new DirectoryCore(storageKv(this.ctx.storage), now);
  memberships(sub: string) {
    return this.core.memberships(sub);
  }
  addMembership(sub: string, m: { workspaceId: string; memberId: string }) {
    return this.core.addMembership(sub, m);
  }
  memberIn(sub: string, ws: string) {
    return this.core.memberIn(sub, ws);
  }
  lastUsed(sub: string) {
    return this.core.lastUsed(sub);
  }
  setLastUsed(sub: string, memberId: string) {
    return this.core.setLastUsed(sub, memberId);
  }
  createInvite(ws: string, memberId: string, by: string) {
    return this.core.createInvite(ws, memberId, by);
  }
  redeem(code: string, sub: string) {
    return this.core.redeem(code, sub);
  }
}

// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.authkit.app",
};

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) r.headers.set(k, v);
  return r;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => withHeaders(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } }));
const err = (status: number, message: string, code = "error") => json({ error: { code, message } }, status);

function cookie(req: Request, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("Cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}
const setCookie = (name: string, value: string, maxAge: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function clientId(env: Env): string {
  return `${env.PUBLIC_ORIGIN}/oauth/client.json`;
}

async function currentUser(req: Request, env: Env): Promise<User | null> {
  const s = await readSession(cookie(req, "__Host-session"), env.SESSION_KEY);
  return s ? { sub: s.sub, email: s.email, name: s.name } : null;
}

/** Mutations must come from our own pages: same Origin and a custom header no form can send. */
function sameOrigin(req: Request, env: Env): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("Origin");
  return (!origin || origin === env.PUBLIC_ORIGIN) && req.headers.get("X-Archymedes") === "1";
}

function hosted(env: Env): Hosted {
  return new Hosted({
    directory: env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")) as unknown as DirectoryLike,
    tenant: (ws) => env.TENANTS.get(env.TENANTS.idFromName(ws)) as unknown as TenantLike,
    now,
    secretKey: env.CONNECTOR_KEY,
    files: env.DOCS
      ? {
          put: async (key, bytes) => void (await env.DOCS!.put(key, bytes)),
          get: async (key) => {
            const o = await env.DOCS!.get(key);
            return o ? new Uint8Array(await o.arrayBuffer()) : null;
          },
        }
      : undefined,
    fetch: (url, init) => fetch(url, init),
  });
}

async function body<T>(req: Request): Promise<T> {
  const len = Number(req.headers.get("Content-Length") ?? 0);
  if (len > 25_000_000) throw new HostedError(413, "Request too large.");
  try {
    return (await req.json()) as T;
  } catch {
    throw new HostedError(400, "Body must be JSON.");
  }
}

async function login(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const back = url.searchParams.get("return") ?? "/app/";
  const ret = back.startsWith("/") && !back.startsWith("//") ? back : "/app/";
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(18);
  const flow = await signValue({ state, verifier, ret, exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_KEY);
  const a = new URL(`${env.AUTHKIT_ISSUER}/oauth2/authorize`);
  a.search = new URLSearchParams({ response_type: "code", client_id: clientId(env), redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`, scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return withHeaders(new Response(null, { status: 302, headers: { Location: a.toString(), "Set-Cookie": setCookie("__Host-oauth", flow, 600) } }));
}

async function callback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const flow = await readValue<{ state: string; verifier: string; ret: string; exp: number }>(cookie(req, "__Host-oauth"), env.SESSION_KEY);
  if (!flow || flow.exp < Date.now() / 1000 || url.searchParams.get("state") !== flow.state) return err(400, "Sign-in expired or was tampered with. Please try again.");
  const iss = url.searchParams.get("iss");
  if (iss && iss !== env.AUTHKIT_ISSUER) return err(400, "Unexpected sign-in issuer.");
  const code = url.searchParams.get("code");
  if (!code) return err(400, url.searchParams.get("error_description") ?? "Sign-in was cancelled.");
  const tok = await fetch(`${env.AUTHKIT_ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${env.PUBLIC_ORIGIN}/auth/callback`, client_id: clientId(env), code_verifier: flow.verifier }),
  });
  if (!tok.ok) return err(502, "Sign-in could not be completed. Please try again.");
  const t = (await tok.json()) as { id_token?: string };
  if (!t.id_token) return err(502, "Sign-in returned no identity.");
  const user = await verifyIdToken(t.id_token, { issuer: env.AUTHKIT_ISSUER, clientId: clientId(env) });
  const session = await signSession({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 }, env.SESSION_KEY);
  const headers = new Headers({ Location: flow.ret });
  headers.append("Set-Cookie", setCookie("__Host-session", session, SESSION_HOURS * 3600));
  headers.append("Set-Cookie", setCookie("__Host-oauth", "", 0));
  return withHeaders(new Response(null, { status: 302, headers }));
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/config") return json({ hosted: true, signIn: "/auth/login" });
  const user = await currentUser(req, env);
  if (!user) return err(401, "Sign in to continue.", "signed_out");
  if (!sameOrigin(req, env)) return err(403, "Cross-site request refused.", "csrf");
  const h = hosted(env);
  if (path === "/api/me" && req.method === "GET") return json({ user });
  if (path === "/api/session" && req.method === "GET") return json(await h.session(user));
  if (path === "/api/session" && req.method === "POST") {
    await h.selectIdentity(user, (await body<{ memberId: string }>(req)).memberId);
    return json({ ok: true });
  }
  if (path === "/api/workspaces" && req.method === "POST") return json(await h.createWorkspace(user, (await body<{ input: WorkspaceInput }>(req)).input), 201);
  if (path === "/api/workspaces/import" && req.method === "POST") {
    const b = await body<{ slices: WorkspaceSlices; adminMemberId: string }>(req);
    return json(await h.importWorkspace(user, b.slices, b.adminMemberId), 201);
  }
  if (path === "/api/invites" && req.method === "POST") {
    const b = await body<{ workspaceId: string; memberId: string }>(req);
    const { code } = await h.invite(user, b.workspaceId, b.memberId);
    return json({ code, url: `${env.PUBLIC_ORIGIN}/join/?code=${code}` }, 201);
  }
  const accept = /^\/api\/invites\/([A-Za-z0-9_-]+)\/accept$/.exec(path);
  if (accept && req.method === "POST") {
    try {
      return json(await h.acceptInvite(user, accept[1]));
    } catch (e) {
      return err(400, e instanceof Error ? e.message : "Invite failed.");
    }
  }
  const file = /^\/api\/files\/([\w-]+)\/([\w-]+)$/.exec(path);
  if (file && req.method === "PUT") {
    if (Number(req.headers.get("Content-Length") ?? 0) > 25_000_000) return err(413, "Files up to 25 MB.");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > 25_000_000) return err(413, "Files up to 25 MB.");
    await h.putFile(user, file[1], file[2], bytes);
    return json({ ok: true });
  }
  if (file && req.method === "GET") {
    const f = await h.getFile(user, file[1], file[2]);
    if (!f) return err(404, "File not found.", "not_found");
    return withHeaders(new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${f.name.replace(/[^\w.\- ]/g, "_")}"`, "Cache-Control": "private, no-store" } }));
  }
  const source = /^\/api\/sources\/([\w-]+)\/([\w-]+)\/(sync|secret)$/.exec(path);
  if (source && source[3] === "sync" && req.method === "POST") return json(await h.syncSource(user, source[1], source[2]));
  if (source && source[3] === "secret" && req.method === "PUT") {
    await h.setSourceSecret(user, source[1], source[2], String((await body<{ secret: string }>(req)).secret ?? ""));
    return json({ ok: true });
  }
  if (path.startsWith("/api/v1/workspaces/") && ["GET", "POST", "PATCH"].includes(req.method)) {
    const url = new URL(req.url);
    const b = req.method === "GET" ? undefined : await body<unknown>(req);
    const entReq: EntRequest = {
      method: req.method as EntRequest["method"],
      path: path.slice(4) + url.search,
      ...(b === undefined ? {} : { body: b }),
      ...(req.headers.get("Idempotency-Key") ? { idempotencyKey: req.headers.get("Idempotency-Key")!.slice(0, 200) } : {}),
      ...(req.headers.get("If-Match") ? { ifRevision: Number(req.headers.get("If-Match")) } : {}),
    };
    const res = await h.request(user, entReq);
    return json(res.body, res.status);
  }
  return err(404, "Not found.", "not_found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/oauth/client.json")
        return json({ client_id: clientId(env), client_name: "Archymedes OS", client_uri: env.PUBLIC_ORIGIN, redirect_uris: [`${env.PUBLIC_ORIGIN}/auth/callback`], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "openid email profile" }, 200, { "Cache-Control": "public, max-age=300" });
      if (path === "/auth/login") return await login(req, env);
      if (path === "/auth/callback") return await callback(req, env);
      if (path === "/auth/logout") return withHeaders(new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": setCookie("__Host-session", "", 0) } }));
      if (path.startsWith("/api/")) return await api(req, env, path);
      return withHeaders(await env.ASSETS.fetch(req));
    } catch (e) {
      if (e instanceof HostedError) return err(e.status, e.message);
      console.error(e);
      return err(500, "Something went wrong.", "internal");
    }
  },
} satisfies ExportedHandler<Env>;
