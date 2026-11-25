"use client";

import { useState } from "react";
import type { Member, Objective, TaskView } from "@archymedes/engine/api-types";
import { MOAT_KINDS } from "@archymedes/engine/api-types";
import { date, useAction, useEnt, useGet } from "@/lib/client";
import type { Nav } from "../Shell";
import { Button, Chip, Empty, ErrorLine, Field, Figure, PageHead, Select, Sheet, Tabs } from "../ui";

export const STATUS_LABEL = { todo: "To do", doing: "Doing", blocked: "Blocked", done: "Done" } as const;
export const statusTone = (s: TaskView["status"]) => (s === "blocked" ? "bad" : s === "doing" ? "accent" : s === "done" ? "good" : "neutral");

export function CompassPage({ nav }: { nav: Nav }) {
  const { data, error } = useGet<{ tasks: TaskView[]; calibration: { n: number; meanAbsError: number | null; bias: number | null } }>("/tasks");
  const { me } = useEnt();
  const [tab, setTab] = useState("open");
  const [creating, setCreating] = useState(false);
  if (error) return <ErrorLine error={error.message} />;
  const tasks = data?.tasks ?? [];
  const lists: Record<string, TaskView[]> = {
    open: tasks.filter((t) => t.status !== "done"),
    mine: tasks.filter((t) => t.status !== "done" && t.ownerId === me.id),
    blocked: tasks.filter((t) => t.status === "blocked"),
    done: tasks.filter((t) => t.status === "done"),
  };
  const shown = lists[tab];
  const cal = data?.calibration;
  return (
    <>
      <PageHead index="04" title="Compass" lede="Every piece of work has an owner, done-when criteria and proof of delivery. Ranked by impact, confidence, lasting advantage, effort and urgency." actions={me.role !== "auditor" && <Button variant="primary" onClick={() => setCreating(true)}>New task</Button>} />
      <div className="figs figs-4">
        <Figure label="Open" value={lists.open.length} />
        <Figure label="Blocked" value={lists.blocked.length} sub={lists.blocked.length ? "unblock these first" : "none"} />
        <Figure label="Done" value={lists.done.length} />
        <Figure label="Impact forecast error" value={cal?.meanAbsError == null ? "—" : cal.meanAbsError.toFixed(1)} sub={cal?.n ? `${cal.n} debriefed · ${cal.bias! > 0 ? "underestimates" : cal.bias! < 0 ? "overestimates" : "unbiased"}` : "debrief done tasks to learn"} explain="Average gap between predicted and actual impact (1–5) on debriefed tasks. Lower is better." />
      </div>
      <Tabs label="Filter tasks" value={tab} onValueChange={setTab} items={[{ value: "open", label: "Open", count: lists.open.length }, { value: "mine", label: "Mine", count: lists.mine.length }, { value: "blocked", label: "Blocked", count: lists.blocked.length }, { value: "done", label: "Done", count: lists.done.length }]} />
      {!data ? (
        <div className="loading">Loading…</div>
      ) : shown.length === 0 ? (
        <Empty>{tab === "done" ? "Nothing finished yet." : "Nothing here."}</Empty>
      ) : (
        <ol className="tasks" aria-label="Tasks">
          {shown.map((t, i) => (
            <li key={t.id}>
              <button type="button" className="task" onClick={() => nav.openTask(t.id)}>
                <span className="task-rank">{tab === "done" ? "✓" : i + 1}</span>
                <span className="task-key">{t.key}</span>
                <span className="task-main">
                  <b>{t.title}</b>
                  <span className="task-reasons">
                    {t.reasons.map((r) => (
                      <span key={r} className="reason">
                        {r}
                      </span>
                    ))}
                    {t.goalName && <span className="reason reason-goal">{t.goalName}</span>}
                  </span>
                </span>
                <span className="task-owner">{t.ownerName ?? "Unassigned"}</span>
                <span className="task-due">{t.dueAt ? date(t.dueAt) : ""}</span>
                <Chip tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Chip>
              </button>
            </li>
          ))}
        </ol>
      )}
      <NewTask open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); nav.openTask(id); }} />
    </>
  );
}

export function NewTask({ open, onClose, onCreated, preset }: { open: boolean; onClose(): void; onCreated(id: string): void; preset?: { goalId?: string; title?: string } }) {
  const { call, me } = useEnt();
  const members = useGet<{ members: Member[] }>("/members");
  const goals = useGet<{ objectives: Objective[] }>("/objectives");
  const { busy, error, run } = useAction();
  const [title, setTitle] = useState(preset?.title ?? "");
  const [owner, setOwner] = useState(me.id);
  const [due, setDue] = useState("");
  const [goal, setGoal] = useState(preset?.goalId ?? "");
  const [impact, setImpact] = useState("3");
  const [effort, setEffort] = useState("1");
  const [doneWhen, setDoneWhen] = useState("");
  const [moatKind, setMoatKind] = useState("");
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="New task" description="What needs doing, who owns it, and how you will know it is done.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          await run(async () => {
            const r = await call<{ task: { id: string } }>("POST", "/tasks", { title, ownerId: owner || undefined, dueAt: due || undefined, goalId: goal || undefined, impact: Number(impact), effortDays: Number(effort) || 1, doneWhen: doneWhen.split("\n").map((x) => x.trim()).filter(Boolean), ...(moatKind ? { moat: { kind: moatKind, note: "", strength: 3 } } : {}) });
            setTitle("");
            setDoneWhen("");
            onCreated(r.task.id);
          });
        }}
      >
        <Field label="Task" htmlFor="nt-title">
          <input id="nt-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Start with a verb: Ship…, Call…, Fix…" />
        </Field>
        <div className="grid-2">
          <Field label="Owner">
            <Select label="Owner" value={owner} onValueChange={setOwner} options={(members.data?.members ?? []).map((m) => ({ value: m.id, label: m.name }))} />
          </Field>
          <Field label="Due" htmlFor="nt-due">
            <input id="nt-due" className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        <Field label="Goal it moves">
          <Select label="Goal it moves" value={goal} onValueChange={setGoal} options={(goals.data?.objectives ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="None" />
        </Field>
        <div className="grid-2">
          <Field label="Expected impact">
            <Select label="Expected impact" value={impact} onValueChange={setImpact} options={["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: `${v} — ${["small", "modest", "medium", "large", "very large"][Number(v) - 1]}` }))} />
          </Field>
          <Field label="Effort (days)" htmlFor="nt-effort">
            <input id="nt-effort" className="input" type="number" min={0.5} step={0.5} value={effort} onChange={(e) => setEffort(e.target.value)} />
          </Field>
        </div>
        <Field label="Done when (one per line)" htmlFor="nt-dw">
          <textarea id="nt-dw" className="input" rows={3} value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} />
        </Field>
        <Field label="Leaves a lasting advantage?" hint="Ranked higher: work that compounds.">
          <Select label="Lasting advantage" value={moatKind} onValueChange={setMoatKind} options={MOAT_KINDS.map((k) => ({ value: k.kind, label: k.label }))} placeholder="No" />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
          Add task
        </Button>
      </form>
    </Sheet>
  );
}
