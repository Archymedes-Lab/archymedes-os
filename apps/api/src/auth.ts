import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";

/** A signed-in person, as AuthKit vouched for them. */
export interface User {
  sub: string;
  email: string | null;
  name: string | null;
}

export interface SessionClaims extends User {
  exp: number;
}

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** payload.signature, HMAC-SHA256 over the base64url JSON payload. */
export async function signValue(value: unknown, key: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(value)));
  return `${payload}.${await hmac(key, payload)}`;
}

export async function readValue<T>(token: string | null | undefined, key: string): Promise<T | null> {
  if (!token || token.length > 8192) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, await hmac(key, payload))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(payload))) as T;
  } catch {
    return null;
  }
}

export function signSession(s: SessionClaims, key: string): Promise<string> {
  return signValue(s, key);
}

export async function readSession(token: string | null | undefined, key: string, nowSec = Math.floor(Date.now() / 1000)): Promise<SessionClaims | null> {
  const s = await readValue<SessionClaims>(token, key);
  if (!s || typeof s.sub !== "string" || typeof s.exp !== "number" || s.exp < nowSec) return null;
  return s;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge };
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verifies an AuthKit ID token: signature (issuer JWKS), issuer, audience = our client id, expiry. */
export async function verifyIdToken(token: string, opts: { issuer: string; clientId: string; jwks?: JSONWebKeySet }): Promise<User> {
  let keys = opts.jwks ? createLocalJWKSet(opts.jwks) : remoteSets.get(opts.issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${opts.issuer}/oauth2/jwks`));
    remoteSets.set(opts.issuer, keys as ReturnType<typeof createRemoteJWKSet>);
  }
  const { payload } = await jwtVerify(token, keys, { issuer: opts.issuer, audience: opts.clientId });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("token has no subject");
  const name = typeof payload.name === "string" ? payload.name : [payload.given_name, payload.family_name].filter((x) => typeof x === "string").join(" ") || null;
  return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : null, name };
}
