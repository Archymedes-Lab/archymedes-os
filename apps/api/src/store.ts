import type { EnterpriseState } from "@archymedes/engine/api-types";

/** The slice of Durable Object storage this app uses. */
export interface Kv {
  get(key: string): Promise<string | undefined>;
  put(entries: Record<string, string>): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

/** In-memory Kv for tests and local runs. */
export function memoryKv(): Kv & { size(): number; sizes(): number[] } {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k);
    },
    async put(entries) {
      for (const [k, v] of Object.entries(entries)) m.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) m.delete(k);
    },
    size: () => m.size,
    sizes: () => [...m.values()].map((v) => v.length),
  };
}

interface Meta {
  v: 1;
  rest: Record<string, unknown>;
  chunks: Record<string, number>;
}

/**
 * Saves the state as one meta value plus every array split into chunks of at
 * most `maxBytes` of JSON, so no single value approaches storage limits.
 */
export async function saveState(kv: Kv, state: EnterpriseState, maxBytes = 512 * 1024): Promise<void> {
  const prev = await kv.get("meta");
  const prevChunks: Record<string, number> = prev ? (JSON.parse(prev) as Meta).chunks : {};
  const rest: Record<string, unknown> = {};
  const chunks: Record<string, number> = {};
  const entries: Record<string, string> = {};
  for (const [field, value] of Object.entries(state)) {
    if (!Array.isArray(value)) {
      rest[field] = value;
      continue;
    }
    let buf: string[] = [];
    let size = 2;
    let n = 0;
    const flush = () => {
      entries[`c:${field}:${n++}`] = `[${buf.join(",")}]`;
      buf = [];
      size = 2;
    };
    for (const item of value) {
      const s = JSON.stringify(item);
      if (buf.length && size + s.length + 1 > maxBytes) flush();
      buf.push(s);
      size += s.length + 1;
    }
    if (buf.length) flush();
    chunks[field] = n;
  }
  const meta: Meta = { v: 1, rest, chunks };
  entries.meta = JSON.stringify(meta);
  const keys = Object.keys(entries);
  for (let i = 0; i < keys.length; i += 100) await kv.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
  const stale: string[] = [];
  for (const [field, count] of Object.entries(prevChunks)) for (let i = chunks[field] ?? 0; i < count; i++) stale.push(`c:${field}:${i}`);
  for (let i = 0; i < stale.length; i += 100) await kv.delete(stale.slice(i, i + 100));
}

export async function loadState(kv: Kv): Promise<EnterpriseState | null> {
  const raw = await kv.get("meta");
  if (!raw) return null;
  const meta = JSON.parse(raw) as Meta;
  const state: Record<string, unknown> = { ...meta.rest };
  for (const [field, count] of Object.entries(meta.chunks)) {
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) items.push(...(JSON.parse((await kv.get(`c:${field}:${i}`)) ?? "[]") as unknown[]));
    state[field] = items;
  }
  return state as unknown as EnterpriseState;
}
