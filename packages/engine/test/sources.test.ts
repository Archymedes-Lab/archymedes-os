import { describe, expect, it } from "vitest";
import { EnterpriseApi } from "../src/api";
import { suggestMapping } from "../src/sources";
import { CO_A, seedState } from "./fixture-seed";

const now = () => "2026-11-20T08:00:00.000Z";
const p = (x: string) => `/v1/workspaces/${CO_A.ws}${x}`;

describe("column mapping suggestions", () => {
  it("recognises common billing, CRM and shop exports", () => {
    expect(suggestMapping(["Invoice Number", "Date Paid", "Amount Paid", "Currency", "Customer"])).toEqual(expect.objectContaining({ externalId: "Invoice Number", occurredAt: "Date Paid", amount: "Amount Paid", currency: "Currency" }));
    expect(suggestMapping(["order_id", "created_at", "total_price", "segment"])).toEqual(expect.objectContaining({ externalId: "order_id", occurredAt: "created_at", amount: "total_price" }));
    expect(suggestMapping(["id", "when", "value"])).toEqual(expect.objectContaining({ externalId: "id", occurredAt: "when", amount: "value" }));
    expect(suggestMapping(["foo", "bar"]).externalId).toBeNull();
  });
});

describe("data sources and documents", () => {
  it("an admin registers a source, ingests a CSV through its mapping, and replays import nothing twice", async () => {
    const api = new EnterpriseApi(seedState(now()), { now });
    const mapping = { externalId: "id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} };
    expect((await api.handle(CO_A.lead, { method: "POST", path: p("/sources"), body: { kind: "csv_url", name: "Sheet", url: "https://example.com/x.csv", mapping } })).status).toBe(403);
    const s = await api.handle(CO_A.admin, { method: "POST", path: p("/sources"), body: { kind: "csv_url", name: "Sheet", url: "https://example.com/x.csv", mapping } });
    expect(s.status).toBe(201);
    const id = (s.body as { source: { id: string } }).source.id;
    expect((await api.handle(CO_A.admin, { method: "POST", path: p("/sources"), body: { kind: "csv_url", name: "Bad", url: "http://insecure.example/x.csv", mapping } })).status).toBe(400);
    const csv = "id,date,amount\nS-1,2026-11-19,10.00\nS-2,2026-11-19,5.00";
    const r1 = await api.handle(CO_A.admin, { method: "POST", path: p(`/sources/${id}/ingest`), body: { csv } });
    expect((r1.body as { imported: number }).imported).toBe(2);
    const r2 = await api.handle(CO_A.admin, { method: "POST", path: p(`/sources/${id}/ingest`), body: { csv } });
    expect((r2.body as { imported: number }).imported).toBe(0);
    const list = (await api.handle(CO_A.lead, { method: "GET", path: p("/sources") })).body as { sources: { id: string; lastSyncAt: string; lastResult: { duplicates: number } }[] };
    expect(list.sources.find((x) => x.id === id)).toEqual(expect.objectContaining({ lastSyncAt: now(), lastResult: expect.objectContaining({ duplicates: 2 }) }));
  });

  it("documents are recorded with a digest and can be attached to a goal, decision or task", async () => {
    const api = new EnterpriseApi(seedState(now()), { now });
    const meta = { name: "Q3 board pack.pdf", mime: "application/pdf", size: 120_000, sha256: "a".repeat(64), preview: "", storage: "cloud", attachedTo: { kind: "goal", id: CO_A.objective } };
    const r = await api.handle(CO_A.lead, { method: "POST", path: p("/documents"), body: meta });
    expect(r.status).toBe(201);
    expect((await api.handle(CO_A.lead, { method: "POST", path: p("/documents"), body: { ...meta, sha256: "nope" } })).status).toBe(400);
    expect((await api.handle(CO_A.lead, { method: "POST", path: p("/documents"), body: { ...meta, attachedTo: { kind: "goal", id: "obj-b" } } })).status).toBe(404);
    const docs = (await api.handle(CO_A.auditor, { method: "GET", path: p(`/documents?goal=${CO_A.objective}`) })).body as { documents: { name: string }[] };
    expect(docs.documents.map((d) => d.name)).toEqual(["Q3 board pack.pdf"]);
    expect((await api.handle(CO_A.auditor, { method: "POST", path: p("/documents"), body: meta })).status).toBe(403);
  });
});
