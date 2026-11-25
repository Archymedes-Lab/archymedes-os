import { describe, expect, it } from "vitest";
import { emptyState } from "@archymedes/engine/host";
import { loadState, memoryKv, saveState } from "../src/store";

describe("chunked state storage", () => {
  it("round-trips large state across many small values and drops stale chunks", async () => {
    const kv = memoryKv();
    const st = emptyState();
    for (let i = 0; i < 5000; i++) st.rows.push({ id: `r${i}`, tenantId: "t", importId: "i", externalId: `E-${i}`, occurredAt: "2026-01-01T00:00:00.000Z", currency: "USD", amountMinor: i, fields: { note: "x".repeat(200) } });
    await saveState(kv, st, 64 * 1024);
    expect(kv.size()).toBeGreaterThan(10);
    expect(Math.max(...kv.sizes())).toBeLessThanOrEqual(64 * 1024 + 1024);
    expect(await loadState(kv)).toEqual(st);
    st.rows.length = 10;
    await saveState(kv, st, 64 * 1024);
    expect(await loadState(kv)).toEqual(st);
    expect(kv.size()).toBeLessThan(5);
  });
  it("loads nothing from an empty store", async () => {
    expect(await loadState(memoryKv())).toBeNull();
  });
});

import fc from "fast-check";
import type { EnterpriseState } from "@archymedes/engine/api-types";

describe("chunked storage invariant", () => {
  it("round-trips arbitrary arrays at any chunk size, and never leaves stale chunks behind", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ id: fc.string(), n: fc.integer(), note: fc.string({ maxLength: 400 }) }), { maxLength: 300 }), fc.array(fc.record({ id: fc.string() }), { maxLength: 50 }), fc.integer({ min: 256, max: 20_000 }), async (rows, tasks, max) => {
        const kv = memoryKv();
        const big = { ...emptyState(), rows, tasks } as unknown as EnterpriseState;
        await saveState(kv, big, max);
        expect(await loadState(kv)).toEqual(big);
        const small = { ...emptyState(), rows: rows.slice(0, 1), tasks: [] } as unknown as EnterpriseState;
        await saveState(kv, small, max);
        expect(await loadState(kv)).toEqual(small);
        expect(kv.size()).toBeLessThanOrEqual(1 + Object.keys(emptyState()).length + 2);
      }),
      { numRuns: 60 },
    );
  });
});
