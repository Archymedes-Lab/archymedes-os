"use client";

import { useState } from "react";
import type { Member, TaskView, WorkView } from "@archymedes/engine/api-types";
import { MOAT_KINDS } from "@archymedes/engine/api-types";
import { date, useAction, useEnt, useGet } from "@/lib/client";
import { sha256Hex } from "@/lib/files";
import type { Nav } from "../Shell";
import { Button, Chip, ErrorLine, Facts, Field, Section, Select, Sheet } from "../ui";
import { STATUS_LABEL, statusTone } from "./Compass";
import { Attachments } from "./Data";

export function TaskSheet({ id, onClose, nav }: { id: string; onClose(): void; nav: Nav }) {
  const { data } = useGet<{ tasks: TaskView[] }>("/tasks");
  const t = data?.tasks.find((x) => x.id === id);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={t ? `${t.key} · ${t.title}` : "Task"} description={t ? `${STATUS_LABEL[t.status]} · ${t.ownerName ?? "Unassigned"}${t.dueAt ? ` · due ${date(t.dueAt)}` : ""}` : "Loading"}>
      {t && <TaskBody t={t} nav={nav} />}
    </Sheet>
  );
}

const IMPACT = ["small", "modest", "medium", "large", "very large"];

function TaskBody({ t, nav }: { t: TaskView; nav: Nav }) {
  const { call, me } = useEnt();
  const members = useGet<{ members: Member[] }>("/members");
  const { busy, error, run } = useAction();
  const [blocker, setBlocker] = useState("");
  const [proof, setProof] = useState("");
  const [actual, setActual] = useState("");
  const [lesson, setLesson] = useState("");
  const [asset, setAsset] = useState("");
  const [assetKind, setAssetKind] = useState(t.moat?.kind ?? "know_how");
  const canEdit = me.role !== "auditor" && (me.role !== "operator" || !t.ownerId || t.ownerId === me.id);
  const update = (body: Record<string, unknown>) => run(() => call("POST", `/tasks/${t.id}`, body));

  return (
    <div className="taskd">
      <div className="actions">
        <Chip tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Chip>
        {t.reasons.map((r) => (
          <span key={r} className="reason">
            {r}
          </span>
        ))}
      </div>
      {t.decisionTitle && t.decisionId && (
        <p className="note">
          Delivers the approved decision{" "}
          <button type="button" className="link" onClick={() => nav.openDecision(t.decisionId!)}>
            {t.decisionTitle}
          </button>
          .
        </p>
      )}

      {canEdit && t.status !== "done" && (
        <Section title="Status">
          <div className="seg" role="group" aria-label="Status">
            {(["todo", "doing", "blocked"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={t.status === s} disabled={busy} onClick={() => update({ status: s })}>
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <div className="grid-2">
            <Field label="Owner">
              <Select label="Owner" value={t.ownerId ?? ""} onValueChange={(v) => update({ ownerId: v })} options={(members.data?.members ?? []).map((m) => ({ value: m.id, label: m.name }))} />
            </Field>
            <Field label="Due" htmlFor="t-due">
              <input id="t-due" className="input" type="date" defaultValue={t.dueAt?.slice(0, 10) ?? ""} onBlur={(e) => e.target.value && update({ dueAt: e.target.value })} />
            </Field>
          </div>
        </Section>
      )}

      {t.doneWhen.length > 0 && (
        <Section title="Done when">
          <ul className="donewhen">
            {t.doneWhen.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Blockers">
        {t.blockers.length === 0 && <p className="note">None.</p>}
        <ul className="rows">
          {t.blockers.map((b) => (
            <li key={b.id} className="row row-static">
              <span className="row-main">
                <b className={b.resolvedAt ? "struck" : ""}>{b.text}</b>
                <span className="muted">{b.resolvedAt ? `resolved ${date(b.resolvedAt)}` : `since ${date(b.createdAt)}`}</span>
              </span>
              {!b.resolvedAt && canEdit && (
                <Button size="sm" disabled={busy} onClick={() => run(() => call("POST", `/tasks/${t.id}/blockers/${b.id}/resolve`, {}))}>
                  Resolve
                </Button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && t.status !== "done" && (
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => call("POST", `/tasks/${t.id}/blockers`, { text: blocker }))) setBlocker("");
            }}
          >
            <input className="input" aria-label="New blocker" placeholder="What is in the way?" value={blocker} onChange={(e) => setBlocker(e.target.value)} />
            <Button type="submit" size="sm" disabled={busy || !blocker.trim()}>
              Add blocker
            </Button>
          </form>
        )}
      </Section>

      {t.status !== "done" && canEdit && (t.workId ? <Delivery t={t} /> : (
        <Section title="Finish">
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(() => call("POST", `/tasks/${t.id}/done`, { evidenceNote: proof }));
            }}
          >
            <Field label="Proof of delivery" htmlFor="t-proof" hint="Where someone can check it was done: a link, a document, a number.">
              <textarea id="t-proof" className="input" rows={2} value={proof} onChange={(e) => setProof(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={busy || !proof.trim()}>
              Mark done
            </Button>
          </form>
        </Section>
      ))}

      {t.status === "done" && (
        <Section title="Aftermath">
          <Facts
            rows={[
              ["Proof", t.evidenceNote ?? "—"],
              ["Predicted impact", `${t.impact} — ${IMPACT[t.impact - 1]}`],
              ["Actual impact", t.debrief ? `${t.debrief.actualImpact} — ${IMPACT[t.debrief.actualImpact - 1]}` : "not yet debriefed"],
              ["Lesson", t.debrief?.lesson || "—"],
              ["Left behind", t.debrief?.assetLeft ?? "—"],
            ]}
          />
          {!t.debrief && canEdit && (
            <form
              className="form"
              onSubmit={async (e) => {
                e.preventDefault();
                await run(() => call("POST", `/tasks/${t.id}/debrief`, { actualImpact: Number(actual), lesson, ...(asset.trim() ? { assetLeft: asset.trim(), assetKind } : {}) }));
              }}
            >
              <Field label="How big was the impact, really?">
                <Select label="Actual impact" value={actual} onValueChange={setActual} options={[1, 2, 3, 4, 5].map((v) => ({ value: String(v), label: `${v} — ${IMPACT[v - 1]}` }))} />
              </Field>
              <Field label="Lesson for next time" htmlFor="t-lesson">
                <textarea id="t-lesson" className="input" rows={2} value={lesson} onChange={(e) => setLesson(e.target.value)} />
              </Field>
              <div className="grid-2">
                <Field label="What it left behind (optional)" htmlFor="t-asset">
                  <input id="t-asset" className="input" value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="e.g. Reusable onboarding checklist" />
                </Field>
                <Field label="Kind">
                  <Select label="Kind of advantage" value={assetKind} onValueChange={(v) => setAssetKind(v as typeof assetKind)} options={MOAT_KINDS.map((k) => ({ value: k.kind, label: k.label }))} />
                </Field>
              </div>
              <Button type="submit" variant="primary" disabled={busy || !actual}>
                Save debrief
              </Button>
            </form>
          )}
        </Section>
      )}
      <ErrorLine error={error} />
      <Attachments kind="task" id={t.id} />
    </div>
  );
}

/** Decision work: delivery is proved with evidence and verified by an independent reviewer. */
function Delivery({ t }: { t: TaskView }) {
  const { call, me } = useEnt();
  const work = useGet<{ work: WorkView[] }>("/work");
  const w = work.data?.work.find((x) => x.id === t.workId);
  const { busy, error, run } = useAction();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const reviewer = ["finance", "executive"].includes(me.role);
  if (!w) return null;
  return (
    <Section title="Delivery">
      {w.evidence.length > 0 && (
        <ul className="rows">
          {w.evidence.map((e) => (
            <li key={e.id} className="row row-static">
              <span className="row-main">
                <b>{e.title}</b>
                <span className="muted">
                  {date(e.capturedAt)} · {e.status}
                  {e.reviewNote ? ` · ${e.reviewNote}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {(w.state === "linked" || w.state === "in_review") && ["operator", "lead", "admin"].includes(me.role) && (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(async () => call("POST", `/work/${w.id}/evidence`, { title: note.slice(0, 200), kind: "note", digest: await sha256Hex(note), sensitivity: "internal" }))) setNote("");
          }}
        >
          <Field label="Evidence of delivery" htmlFor="d-note" hint="A reviewer other than you will verify it.">
            <textarea id="d-note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy || !note.trim()}>
            Submit for review
          </Button>
        </form>
      )}
      {w.state === "in_review" && reviewer && (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <Field label="Review note" htmlFor="d-reason">
            <textarea id="d-reason" className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="actions">
            <Button variant="primary" disabled={busy || !reason.trim()} onClick={() => run(() => call("POST", `/work/${w.id}/delivery-review`, { verdict: "verify", reason }))}>
              Verify delivery
            </Button>
            <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => run(() => call("POST", `/work/${w.id}/delivery-review`, { verdict: "reject", reason }))}>
              Send back
            </Button>
          </div>
        </form>
      )}
      {w.state === "sync_pending" && <p className="note">Creating the Compass task…</p>}
      <ErrorLine error={error} />
    </Section>
  );
}
