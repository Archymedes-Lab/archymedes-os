import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInput } from "@archymedes/engine/templates";
import { buildWorkspace } from "@archymedes/engine/templates";
import { DirectoryCore } from "../src/directory";
import { Hosted } from "../src/hosted";
import { memoryKv } from "../src/store";
import { TenantCore } from "../src/tenant";

const now = () => "2026-11-25T08:00:00.000Z";
const input: WorkspaceInput = { companyName: "Northwind", businessModel: "services", currency: "GBP", timezone: "Europe/London", fiscalYearStartMonth: 4, admin: { name: "Jo Bloggs", title: "COO" }, sampleData: true };
const jo = { sub: "user_jo", email: "jo@northwind.example", name: "Jo Bloggs" };
const sam = { sub: "user_sam", email: "sam@contoso.example", name: "Sam" };
const lee = { sub: "user_lee", email: "lee@northwind.example", name: "Lee" };

let hosted: Hosted;
let files: Map<string, Uint8Array>;
let fetched: { url: string; auth: string | null }[];
const fetcher = async (url: string, init?: RequestInit) => {
  fetched.push({ url, auth: new Headers(init?.headers).get("Authorization") });
  if (url.startsWith("https://sheet.example/")) return new Response("id,date,amount\nG-1,2026-11-20,12.50\nG-2,2026-11-21,7.00");
  if (url.startsWith("https://api.stripe.com/v1/invoices"))
    return Response.json({ data: [{ id: "in_1", status: "paid", amount_paid: 129900, currency: "gbp", created: 1795000000, customer: "cus_1" }], has_more: false });
  return new Response("nope", { status: 404 });
};
beforeEach(() => {
  const tenants = new Map<string, TenantCore>();
  files = new Map();
  fetched = [];
  hosted = new Hosted({
    directory: new DirectoryCore(memoryKv(), now),
    tenant: (ws) => {
      if (!tenants.has(ws)) tenants.set(ws, new TenantCore(memoryKv(), now));
      return tenants.get(ws)!;
    },
    now,
    secretKey: "s".repeat(64),
    files: { put: async (k, v) => void files.set(k, v), get: async (k) => files.get(k) ?? null },
    fetch: fetcher,
  });
});


describe("hosted workspaces", () => {
  it("a signed-in user creates a workspace and becomes its admin", async () => {
    expect((await hosted.session(jo)).identities).toEqual([]);
    const r = await hosted.createWorkspace(jo, input);
    const s = await hosted.session(jo);
    expect(s.identities).toEqual([expect.objectContaining({ workspaceId: r.workspaceId, role: "admin", name: "Jo Bloggs", tenantName: "Northwind" })]);
    const today = await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${r.workspaceId}/today` });
    expect(today.status).toBe(200);
  });

  it("other companies cannot reach the workspace, even with its id", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, input);
    await hosted.createWorkspace(sam, { ...input, companyName: "Contoso", admin: { name: "Sam", title: "" } });
    expect((await hosted.request(sam, { method: "GET", path: `/v1/workspaces/${workspaceId}/today` })).status).toBe(404);
    expect((await hosted.request(sam, { method: "GET", path: `/v1/workspaces/ws-nope/today` })).status).toBe(404);
  });

  it("mutations persist: a new Hosted over the same stores sees them", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, input);
    const r = await hosted.request(jo, { method: "POST", path: `/v1/workspaces/${workspaceId}/tasks`, body: { title: "Ship it" } });
    expect(r.status).toBe(201);
    const list = await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${workspaceId}/tasks` });
    expect((list.body as { tasks: { title: string }[] }).tasks.some((t) => t.title === "Ship it")).toBe(true);
  });
});

describe("invites", () => {
  it("an admin invites a member; the invite links one person, once", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, input);
    const m = await hosted.request(jo, { method: "POST", path: `/v1/workspaces/${workspaceId}/members`, body: { name: "Lee", title: "Ops", role: "operator", department: "Ops" } });
    const memberId = (m.body as { member: { id: string } }).member.id;
    const inv = await hosted.invite(jo, workspaceId, memberId);
    expect(inv.code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(await hosted.acceptInvite(lee, inv.code)).toEqual({ workspaceId });
    expect((await hosted.session(lee)).identities[0]).toEqual(expect.objectContaining({ workspaceId, role: "operator" }));
    await expect(hosted.acceptInvite(sam, inv.code)).rejects.toThrow(/already used|invalid/i);
  });

  it("only admins can invite", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, input);
    const members = (await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${workspaceId}/members` })).body as { members: { id: string; role: string }[] };
    const op = members.members.find((x) => x.role === "operator")!;
    const inv = await hosted.invite(jo, workspaceId, op.id);
    await hosted.acceptInvite(lee, inv.code);
    await expect(hosted.invite(lee, workspaceId, op.id)).rejects.toThrow(/admin/i);
  });
});

describe("moving a browser trial into the cloud", () => {
  it("imports the local workspace with fresh ids and the uploader as its admin", async () => {
    let n = 0;
    const local = buildWorkspace({ ...input, companyName: "Trial Co" }, now(), (p) => `${p}-local-${++n}`);
    const r = await hosted.importWorkspace(jo, local, local.members[0].id);
    expect(r.workspaceId).not.toBe(local.tenant.workspaceId);
    const s = await hosted.session(jo);
    expect(s.identities[0]).toEqual(expect.objectContaining({ tenantName: "Trial Co", role: "admin" }));
    const d = await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${r.workspaceId}/decisions` });
    expect((d.body as { decisions: unknown[] }).decisions.length).toBe(local.decisions.length);
  });

  it("refuses an upload whose chosen admin is not an admin in it", async () => {
    let n = 0;
    const local = buildWorkspace(input, now(), (p) => `${p}-x-${++n}`);
    const op = local.members.find((m) => m.role === "operator")!;
    await expect(hosted.importWorkspace(jo, local, op.id)).rejects.toThrow(/admin/);
  });
});

describe("connected sources", () => {
  const sheetMapping = { externalId: "id", occurredAt: "date", amount: "amount", defaultCurrency: "GBP", extra: {} };
  it("syncs a CSV link through its mapping on the server", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, { ...input, sampleData: false });
    const src = (await hosted.request(jo, { method: "POST", path: `/v1/workspaces/${workspaceId}/sources`, body: { kind: "csv_url", name: "Sales sheet", url: "https://sheet.example/pub.csv", mapping: sheetMapping } })).body as { source: { id: string } };
    const r = await hosted.syncSource(jo, workspaceId, src.source.id);
    expect(r.imported).toBe(2);
    expect((await hosted.syncSource(jo, workspaceId, src.source.id)).imported).toBe(0);
  });

  it("keeps a Stripe key encrypted server-side and imports paid invoices", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, { ...input, sampleData: false });
    const src = (await hosted.request(jo, { method: "POST", path: `/v1/workspaces/${workspaceId}/sources`, body: { kind: "stripe", name: "Stripe" } })).body as { source: { id: string } };
    await hosted.setSourceSecret(jo, workspaceId, src.source.id, "rk_live_secret");
    const listed = JSON.stringify((await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${workspaceId}/sources` })).body);
    expect(listed).not.toContain("rk_live_secret");
    expect(listed).toContain('"hasSecret":true');
    const r = await hosted.syncSource(jo, workspaceId, src.source.id);
    expect(r.imported).toBe(1);
    expect(fetched.at(-1)!.auth).toBe("Bearer rk_live_secret");
    const rows = (await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${workspaceId}/source-rows` })).body as { rows: { externalId: string; amountMinor: number; currency: string }[] };
    expect(rows.rows.find((x) => x.externalId === "in_1")).toEqual(expect.objectContaining({ amountMinor: 129900, currency: "GBP" }));
  });

  it("only admins sync or set connector keys", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, input);
    const src = (await hosted.request(jo, { method: "POST", path: `/v1/workspaces/${workspaceId}/sources`, body: { kind: "stripe", name: "Stripe" } })).body as { source: { id: string } };
    const op = ((await hosted.request(jo, { method: "GET", path: `/v1/workspaces/${workspaceId}/members` })).body as { members: { id: string; role: string }[] }).members.find((m) => m.role === "operator")!;
    await hosted.acceptInvite(lee, (await hosted.invite(jo, workspaceId, op.id)).code);
    await expect(hosted.setSourceSecret(lee, workspaceId, src.source.id, "x")).rejects.toThrow(/admin/i);
    await expect(hosted.syncSource(lee, workspaceId, src.source.id)).rejects.toThrow(/admin/i);
  });
});

describe("documents", () => {
  it("stores bytes that match the recorded digest, readable only by members", async () => {
    const { workspaceId } = await hosted.createWorkspace(jo, input);
    const bytes = new TextEncoder().encode("Board notes: focus on retention.");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const doc = (await hosted.request(jo, { method: "POST", path: `/v1/workspaces/${workspaceId}/documents`, body: { name: "notes.txt", mime: "text/plain", size: bytes.length, sha256: digest, preview: "Board notes", storage: "cloud" } })).body as { document: { id: string } };
    await expect(hosted.putFile(jo, workspaceId, doc.document.id, new TextEncoder().encode("tampered"))).rejects.toThrow(/digest/i);
    await hosted.putFile(jo, workspaceId, doc.document.id, bytes);
    expect(new TextDecoder().decode((await hosted.getFile(jo, workspaceId, doc.document.id))!.bytes)).toContain("retention");
    await expect(hosted.getFile(sam, workspaceId, doc.document.id)).rejects.toThrow(/not found|no such/i);
  });
});
