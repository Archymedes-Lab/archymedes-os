"use client";

import { useRef, useState } from "react";
import type { AttachKind, DocumentRecord, Source, StoredRow } from "@archymedes/engine/api-types";
import { parseCsv } from "@archymedes/engine/csv-import";
import { suggestMapping } from "@archymedes/engine/sources";
import type { ImportMapping, ImportPreview } from "@archymedes/engine/types";
import { ago, date, useAction, useEnt, useGet } from "@/lib/client";
import { getLocalFile, putLocalFile, sha256Hex, textPreview } from "@/lib/files";
import { Button, Chip, Empty, ErrorLine, Field, Figure, PageHead, Section, Select, Sheet } from "../ui";

const NONE = "__none";

export function DataPage() {
  const { me, backend } = useEnt();
  const rows = useGet<{ total: number; rows: StoredRow[]; imports: { id: string; source: string; createdAt: string; imported: number; duplicates: number }[] }>("/source-rows");
  const sources = useGet<{ sources: Source[] }>("/sources");
  const docs = useGet<{ documents: (DocumentRecord & { uploadedByName: string })[] }>("/documents");
  const [upload, setUpload] = useState(false);
  const [link, setLink] = useState(false);
  const admin = me.role === "admin";
  const last = rows.data?.imports.at(-1);
  return (
    <>
      <PageHead index="07" title="Data" lede="Bring in the records that measure your goals, and the documents behind your decisions." actions={admin && <Button variant="primary" onClick={() => setUpload(true)}>Upload CSV</Button>} />
      <div className="figs figs-3">
        <Figure label="Records" value={(rows.data?.total ?? 0).toLocaleString("en-US")} sub={last ? `last import ${ago(last.createdAt)}` : "none yet"} />
        <Figure label="Sources" value={sources.data?.sources.length ?? 0} />
        <Figure label="Documents" value={docs.data?.documents.length ?? 0} />
      </div>

      <Section title="Connect">
        <div className="connect">
          <article className="conn">
            <b>CSV file</b>
            <p>Billing, CRM, orders or accounting export. Columns are matched automatically; you confirm before anything is saved.</p>
            <Button disabled={!admin} onClick={() => setUpload(true)}>
              Upload CSV
            </Button>
          </article>
          <article className="conn">
            <b>CSV link or Google Sheet</b>
            <p>Any https link to a CSV. For Google Sheets: File → Share → Publish to web → CSV.</p>
            <Button disabled={!admin} onClick={() => setLink(true)}>
              Connect a link
            </Button>
          </article>
          <article className="conn">
            <b>Stripe</b>
            <p>Paid invoices, imported on demand. The key is encrypted and stays on the server.</p>
            {backend.kind === "cloud" ? <StripeConnect disabled={!admin} /> : <span className="muted">Available with team workspaces.</span>}
          </article>
        </div>
      </Section>

      <Section title="Sources">
        {(sources.data?.sources ?? []).length === 0 ? <Empty>No connected sources.</Empty> : <ul className="rows">{sources.data!.sources.map((s) => <SourceRow key={s.id} s={s} admin={admin} />)}</ul>}
      </Section>

      <Section title="Imports">
        {(rows.data?.imports ?? []).length === 0 ? (
          <Empty>Nothing imported yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-tight">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>When</th>
                  <th className="num">Imported</th>
                  <th className="num">Skipped duplicates</th>
                </tr>
              </thead>
              <tbody>
                {[...rows.data!.imports].reverse().map((i) => (
                  <tr key={i.id}>
                    <td>{i.source}</td>
                    <td>{date(i.createdAt)}</td>
                    <td className="num">{i.imported.toLocaleString("en-US")}</td>
                    <td className="num">{i.duplicates}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Documents">
        <DocUpload />
        <DocList docs={docs.data?.documents ?? []} />
      </Section>
      {upload && <UploadCsv onClose={() => setUpload(false)} />}
      {link && <ConnectLink onClose={() => setLink(false)} />}
    </>
  );
}

// ---- CSV upload with column mapping ----

function MappingFields({ header, mapping, setMapping, currency }: { header: string[]; mapping: ImportMapping; setMapping(m: ImportMapping): void; currency: string }) {
  const opts = header.map((h) => ({ value: h, label: h }));
  const pick = (k: "externalId" | "occurredAt" | "amount") => (v: string) => setMapping({ ...mapping, [k]: v });
  return (
    <div className="grid-2">
      <Field label="Unique id (invoice, order…)">
        <Select label="Unique id column" value={mapping.externalId} onValueChange={pick("externalId")} options={opts} />
      </Field>
      <Field label="Date">
        <Select label="Date column" value={mapping.occurredAt} onValueChange={pick("occurredAt")} options={opts} />
      </Field>
      <Field label="Amount">
        <Select label="Amount column" value={mapping.amount} onValueChange={pick("amount")} options={opts} />
      </Field>
      <Field label="Currency" hint={`Blank rows use ${currency}.`}>
        <Select label="Currency column" value={mapping.currency ?? NONE} onValueChange={(v) => setMapping({ ...mapping, currency: v === NONE ? undefined : v })} options={[{ value: NONE, label: `All in ${currency}` }, ...opts]} />
      </Field>
    </div>
  );
}

function initialMapping(header: string[], currency: string): ImportMapping {
  const s = suggestMapping(header);
  return { externalId: s.externalId ?? "", occurredAt: s.occurredAt ?? "", amount: s.amount ?? "", currency: s.currency ?? undefined, defaultCurrency: currency, extra: s.extra };
}

function Preview({ p }: { p: ImportPreview }) {
  const issues = [...p.duplicates.map((x) => ({ ...x, k: "Duplicate" })), ...p.missing.map((x) => ({ ...x, k: "Missing" })), ...p.invalid.map((x) => ({ ...x, k: "Invalid" }))].sort((a, b) => a.line - b.line);
  return (
    <>
      <div className="figs figs-4">
        <Figure label="Ready" value={p.rows.length} />
        <Figure label="Duplicates" value={p.duplicates.length} />
        <Figure label="Missing" value={p.missing.length} />
        <Figure label="Invalid" value={p.invalid.length} />
      </div>
      {issues.length > 0 && (
        <ul className="rows rows-tight" aria-label="Rows that will be skipped">
          {issues.slice(0, 50).map((x) => (
            <li key={`${x.k}${x.line}`} className="row row-static">
              <Chip tone={x.k === "Invalid" ? "bad" : "warn"}>{x.k}</Chip>
              <span className="row-main">
                <span>
                  Line {x.line}: {x.reason}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function UploadCsv({ onClose }: { onClose(): void }) {
  const { call, currency } = useEnt();
  const { busy, error, run, setError } = useAction();
  const [csv, setCsv] = useState("");
  const [name, setName] = useState("upload.csv");
  const [header, setHeader] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [remember, setRemember] = useState(true);
  const [done, setDone] = useState<number | null>(null);
  const load = (text: string, fileName?: string) => {
    setCsv(text);
    setPreview(null);
    setDone(null);
    if (fileName) setName(fileName.slice(0, 120));
    const h = parseCsv(text.split(/\r?\n/).slice(0, 2).join("\n"))[0] ?? [];
    setHeader(h);
    setMapping(h.length ? initialMapping(h, currency) : null);
    if (!h.length) setError("That file has no header row.");
  };
  const ready = mapping && mapping.externalId && mapping.occurredAt && mapping.amount;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Upload CSV" description="Nothing is saved until you press Import. Rows already imported are skipped." wide>
      <div className="form">
        <label className="drop">
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) load(await f.text(), f.name);
            }}
          />
          <b>Choose a CSV file</b>
          <span>or paste it below</span>
        </label>
        <Field label="CSV text" htmlFor="u-csv">
          <textarea id="u-csv" className="input mono" rows={4} value={csv} onChange={(e) => load(e.target.value)} spellCheck={false} />
        </Field>
        {mapping && <MappingFields header={header} mapping={mapping} setMapping={(m) => { setMapping(m); setPreview(null); }} currency={currency} />}
        {mapping && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this mapping as a source for the next upload
          </label>
        )}
        <div className="actions">
          <Button disabled={busy || !ready} onClick={() => run(async () => setPreview((await call<{ preview: ImportPreview }>("POST", "/imports", { csv, mapping, dryRun: true, source: name }, { idempotent: false })).preview))}>
            Preview
          </Button>
          <Button
            variant="primary"
            disabled={busy || !preview || preview.rows.length === 0}
            onClick={() =>
              run(async () => {
                const r = await call<{ imported: number }>("POST", "/imports", { csv, mapping, dryRun: false, source: name });
                if (remember) await call("POST", "/sources", { kind: "upload", name, mapping });
                setDone(r.imported);
                setPreview(null);
              })
            }
          >
            Import {preview ? preview.rows.length : ""} rows
          </Button>
        </div>
        <ErrorLine error={error} />
        {done !== null && (
          <p className="ok" role="status">
            Imported {done} rows. Goals using this data update now.
          </p>
        )}
        {preview && <Preview p={preview} />}
      </div>
    </Sheet>
  );
}

// ---- CSV link ----

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "text/csv, text/plain" } });
  if (!res.ok) throw new Error(`The link answered ${res.status}.`);
  return res.text();
}

function ConnectLink({ onClose }: { onClose(): void }) {
  const { call, currency, backend, workspaceId } = useEnt();
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [csv, setCsv] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [result, setResult] = useState<number | null>(null);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Connect a CSV link" description="Fetches the link, matches the columns, then imports through the same checks as an upload." wide>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          await run(async () => {
            const text = await fetchCsv(url).catch((err: Error) => {
              throw new Error(`${err.message} If the site blocks browser access, download the CSV and upload it instead.`);
            });
            const h = parseCsv(text.split(/\r?\n/).slice(0, 2).join("\n"))[0] ?? [];
            setCsv(text);
            setHeader(h);
            setMapping(initialMapping(h, currency));
          });
        }}
      >
        <div className="grid-2">
          <Field label="Name" htmlFor="l-name">
            <input id="l-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales sheet" />
          </Field>
          <Field label="https link" htmlFor="l-url">
            <input id="l-url" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </Field>
        </div>
        <Button type="submit" disabled={busy || !/^https:\/\//.test(url)}>
          Fetch columns
        </Button>
      </form>
      {mapping && csv !== null && (
        <div className="form">
          <MappingFields header={header} mapping={mapping} setMapping={setMapping} currency={currency} />
          <Button
            variant="primary"
            disabled={busy || !mapping.externalId || !mapping.occurredAt || !mapping.amount}
            onClick={() =>
              run(async () => {
                const s = await call<{ source: Source }>("POST", "/sources", { kind: "csv_url", name: name || "CSV link", url, mapping });
                const r = backend.kind === "cloud" && backend.syncSource ? await backend.syncSource(workspaceId, s.source.id) : await call<{ imported: number }>("POST", `/sources/${s.source.id}/ingest`, { csv });
                setResult(r.imported);
              })
            }
          >
            Connect and import
          </Button>
        </div>
      )}
      <ErrorLine error={error} />
      {result !== null && (
        <p className="ok" role="status">
          Connected. Imported {result} rows. Use Sync on the Data page to pull new rows.
        </p>
      )}
    </Sheet>
  );
}

function SourceRow({ s, admin }: { s: Source; admin: boolean }) {
  const { call, backend, workspaceId } = useEnt();
  const { busy, error, run } = useAction();
  const kind = { upload: "Upload mapping", csv_url: "CSV link", stripe: "Stripe" }[s.kind];
  const canSync = s.kind === "csv_url" || (s.kind === "stripe" && backend.kind === "cloud");
  return (
    <li className="row row-static">
      <span className="row-main">
        <b>{s.name}</b>
        <span className="muted">
          {kind}
          {s.url ? ` · ${new URL(s.url).hostname}` : ""} · {s.lastSyncAt ? `synced ${ago(s.lastSyncAt)}${s.lastResult ? `, ${s.lastResult.imported} new` : ""}` : "never synced"}
        </span>
        {(s.lastError || error) && <span className="error-inline">{error ?? s.lastError}</span>}
      </span>
      {admin && canSync && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (backend.kind === "cloud" && backend.syncSource) await backend.syncSource(workspaceId, s.id);
              else await call("POST", `/sources/${s.id}/ingest`, { csv: await fetchCsv(s.url!) });
            })
          }
        >
          Sync now
        </Button>
      )}
    </li>
  );
}

function StripeConnect({ disabled }: { disabled: boolean }) {
  const { call, backend, workspaceId } = useEnt();
  const { busy, error, run } = useAction();
  const [key, setKey] = useState("");
  const [done, setDone] = useState<number | null>(null);
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        await run(async () => {
          const s = await call<{ source: Source }>("POST", "/sources", { kind: "stripe", name: "Stripe" });
          await backend.setSourceSecret!(workspaceId, s.source.id, key);
          setKey("");
          setDone((await backend.syncSource!(workspaceId, s.source.id)).imported);
        });
      }}
    >
      <input className="input" type="password" autoComplete="off" aria-label="Stripe restricted key" placeholder="rk_live_… (read invoices)" value={key} onChange={(e) => setKey(e.target.value)} disabled={disabled} />
      <Button type="submit" size="sm" disabled={disabled || busy || !key.trim()}>
        Connect
      </Button>
      <ErrorLine error={error} />
      {done !== null && <span className="ok">Imported {done} invoices.</span>}
    </form>
  );
}

// ---- documents ----

async function storeDocument(file: File, backend: ReturnType<typeof useEnt>["backend"], call: ReturnType<typeof useEnt>["call"], workspaceId: string, attachedTo?: { kind: AttachKind; id: string }) {
  if (file.size > 25_000_000) throw new Error(`${file.name} is larger than 25 MB.`);
  const sha256 = await sha256Hex(await file.arrayBuffer());
  const storage = backend.kind === "cloud" ? "cloud" : "browser";
  const r = await call<{ document: DocumentRecord }>("POST", "/documents", { name: file.name, mime: file.type || "application/octet-stream", size: file.size, sha256, preview: await textPreview(file), storage, ...(attachedTo ? { attachedTo } : {}) });
  if (storage === "browser") await putLocalFile(r.document.id, file);
  else {
    const put = await fetch(`/api/files/${workspaceId}/${r.document.id}`, { method: "PUT", credentials: "same-origin", headers: { "X-Archymedes": "1", "Content-Type": "application/octet-stream" }, body: file });
    if (!put.ok) throw new Error("Upload failed.");
  }
}

function DocUpload({ attachedTo }: { attachedTo?: { kind: AttachKind; id: string } }) {
  const { call, backend, workspaceId, me } = useEnt();
  const { busy, error, run } = useAction();
  const ref = useRef<HTMLInputElement>(null);
  if (me.role === "auditor") return null;
  return (
    <div className="inline-form">
      <input
        ref={ref}
        type="file"
        multiple
        className="sr-only"
        aria-label="Upload documents"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.png,.jpg,.jpeg"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          void run(async () => {
            for (const f of files) await storeDocument(f, backend, call, workspaceId, attachedTo);
          });
          e.target.value = "";
        }}
      />
      <Button size="sm" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? "Uploading…" : attachedTo ? "Attach document" : "Upload documents"}
      </Button>
      <span className="muted">{backend.kind === "browser" ? "Stored in this browser." : "Stored privately for this workspace."}</span>
      <ErrorLine error={error} />
    </div>
  );
}

function DocList({ docs }: { docs: (DocumentRecord & { uploadedByName?: string })[] }) {
  const { workspaceId } = useEnt();
  const [err, setErr] = useState<string | null>(null);
  const open = async (d: DocumentRecord) => {
    setErr(null);
    const blob = d.storage === "browser" ? await getLocalFile(d.id) : await fetch(`/api/files/${workspaceId}/${d.id}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.blob() : null));
    if (!blob) return setErr(d.storage === "browser" ? "This file was added in another browser." : "File not found.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = d.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  if (!docs.length) return <p className="note">No documents.</p>;
  return (
    <>
      <ul className="rows rows-tight">
        {docs.map((d) => (
          <li key={d.id} className="row row-static">
            <span className="row-main">
              <b>{d.name}</b>
              <span className="muted">
                {(d.size / 1024).toFixed(0)} KB · {date(d.uploadedAt)}
                {d.uploadedByName ? ` · ${d.uploadedByName}` : ""}
                {d.attachedTo ? ` · on a ${d.attachedTo.kind}` : ""}
              </span>
              {d.preview && <span className="doc-preview">{d.preview.slice(0, 160)}…</span>}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void open(d)}>
              Download
            </Button>
          </li>
        ))}
      </ul>
      <ErrorLine error={err} />
    </>
  );
}

/** Documents on one goal, decision or task. */
export function Attachments({ kind, id }: { kind: AttachKind; id: string }) {
  const { data } = useGet<{ documents: DocumentRecord[] }>(`/documents?${kind}=${encodeURIComponent(id)}`);
  return (
    <Section title="Documents">
      <DocList docs={data?.documents ?? []} />
      <DocUpload attachedTo={{ kind, id }} />
    </Section>
  );
}

