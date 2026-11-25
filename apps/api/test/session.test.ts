import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { pkcePair, readSession, signSession, verifyIdToken } from "../src/auth";

const KEY = "k".repeat(64);
const NOW = 1_795_000_000;

describe("session cookie", () => {
  it("round-trips and rejects tampering or expiry", async () => {
    const c = await signSession({ sub: "user_1", email: "a@b.co", name: "A", exp: NOW + 60 }, KEY);
    expect(await readSession(c, KEY, NOW)).toEqual({ sub: "user_1", email: "a@b.co", name: "A", exp: NOW + 60 });
    expect(await readSession(c.slice(0, -2) + "xx", KEY, NOW)).toBeNull();
    expect(await readSession(c, "z".repeat(64), NOW)).toBeNull();
    expect(await readSession(c, KEY, NOW + 61)).toBeNull();
    expect(await readSession("garbage", KEY, NOW)).toBeNull();
  });
});

describe("PKCE", () => {
  it("derives an S256 challenge from a random verifier", async () => {
    const a = await pkcePair();
    const b = await pkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("AuthKit ID token", () => {
  it("accepts a token signed by the issuer for our client, and rejects the rest", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const jwks = { keys: [jwk] };
    const iss = "https://auth.example";
    const aud = "https://os.example/oauth/client.json";
    const sign = (claims: Record<string, unknown>, issuer = iss, audience = aud) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").setSubject("user_1").sign(privateKey);
    const ok = await verifyIdToken(await sign({ email: "a@b.co", name: "Ada" }), { issuer: iss, clientId: aud, jwks });
    expect(ok).toEqual({ sub: "user_1", email: "a@b.co", name: "Ada" });
    await expect(verifyIdToken(await sign({}, "https://evil.example"), { issuer: iss, clientId: aud, jwks })).rejects.toThrow();
    await expect(verifyIdToken(await sign({}, iss, "someone-else"), { issuer: iss, clientId: aud, jwks })).rejects.toThrow();
  });
});
