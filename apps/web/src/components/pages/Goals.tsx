"use client";

import { useState } from "react";
import type { KpiCard, Member, MetricDefinition, Objective, TodayView } from "@archymedes/engine/api-types";
import { minorDigits } from "@archymedes/engine/money";
import { date, metricValue, pct, ROLE, useAction, useEnt, useGet } from "@/lib/client";
import { Button, Chip, Empty, ErrorLine, Field, Figure, PageHead, Select, Sheet } from "../ui";
import { TrendChart } from "../viz";
import { Attachments } from "./Data";

const NEEDS: Record<string, string> = { owner: "an owner", source: "data (import a CSV in Data)", baselinePeriod: "a baseline", deadline: "a target date", target: "a target" };

export function GoalsPage() {
  const { data, error } = useGet<{ objectives: Objective[]; kpis: KpiCard[] }>("/objectives");
  const today = useGet<TodayView>("/today");
  const { me } = useEnt();
  const [setup, setSetup] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (error) return <ErrorLine error={error.message} />;
  if (!data) return <div className="loading">Loading…</div>;
  const admin = me.role === "admin";
  return (
    <>
      <PageHead index="02" title="Goals" lede="One measurable target each. A goal steers decisions once it has an owner, data, a baseline, a target and a date." actions={admin && <Button variant="primary" onClick={() => setCreating(true)}>New goal</Button>} />
      {data.kpis.length === 0 && <Empty>No goals yet.</Empty>}
      <div className="goals">
        {data.kpis.map((k, i) => {
          const o = data.objectives.find((x) => x.id === k.objectiveId)!;
          const g = today.data?.winning.goals.find((x) => x.objectiveId === k.objectiveId);
          const fmt = (v: number) => metricValue(v, k.unit, k.currency, true);
          const bandHalf = k.forecast ? (k.forecast.high - k.forecast.value) / (k.unit === "money" ? Math.max(1, k.projection.length) : 1) : 0;
          return (
            <article key={k.objectiveId} className="goal" aria-labelledby={`g-${k.objectiveId}`}>
              <span className="goal-idx" aria-hidden>
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="goal-body">
                <div className="goal-head">
                  <h2 id={`g-${k.objectiveId}`}>{k.name}</h2>
                  {k.status === "active" ? <Chip tone="good">Steering decisions</Chip> : <Chip tone="warn">Needs {o.missing.map((m) => NEEDS[m]?.replace(/ \(.*\)$/, "") ?? m).join(", ")}</Chip>}
                  {admin && (
                    <Button size="sm" variant={k.status === "draft" ? "primary" : "secondary"} onClick={() => setSetup(o.id)}>
                      {k.status === "draft" ? "Finish setup" : "Edit"}
                    </Button>
                  )}
                </div>
                <div className="figs figs-5">
                  <Figure label="Chance of winning" value={g?.pWin == null ? "—" : pct(g.pWin)} explain="P(Win | X): chance of meeting the target by the date, from the trend plus approved work." size="l" />
                  <Figure label="Now" value={metricValue(k.actual, k.unit, k.currency, true)} sub={k.unit === "money" ? "last 13 weeks" : "latest week"} />
                  <Figure label="Target" value={metricValue(k.target.value, k.unit, k.currency, true)} sub={`by ${date(k.target.deadline)}`} />
                  <Figure label="Baseline" value={metricValue(k.baseline?.value ?? null, k.unit, k.currency, true)} sub={k.baseline?.label ?? "not set"} />
                  <Figure label="Forecast" value={metricValue(k.forecast?.value ?? null, k.unit, k.currency, true)} sub={k.forecast ? `80% range ${fmt(k.forecast.low)} – ${fmt(k.forecast.high)}` : "needs 8 weeks of data"} explain="A straight-line trend of weekly data, projected to the date. A planning aid, not a promise." />
                </div>
                {k.series.length > 1 ? (
                  <TrendChart label={`${k.metricName} by week`} series={k.series} projection={k.projection} bandHalf={bandHalf} format={fmt} guide={k.unit === "money" ? { value: k.target.value / 13, label: `weekly pace needed ${fmt(k.target.value / 13)}` } : { value: k.target.value, label: `target ${fmt(k.target.value)}` }} />
                ) : (
                  <Empty>No data yet. Import a CSV in Data to measure this goal.</Empty>
                )}
                <dl className="goal-meta">
                  <div>
                    <dt>Measured by</dt>
                    <dd>
                      {k.metricName} · {k.source} · v{k.metricVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{k.ownerName ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Guardrails</dt>
                    <dd>{o.guardrails.join(" · ") || "—"}</dd>
                  </div>
                  <div>
                    <dt>Leading signals</dt>
                    <dd>{o.leadingIndicators.join(" · ") || "—"}</dd>
                  </div>
                </dl>
                <Attachments kind="goal" id={o.id} />
              </div>
            </article>
          );
        })}
      </div>
      {setup && data.objectives.find((o) => o.id === setup) && <GoalSetup objective={data.objectives.find((o) => o.id === setup)!} kpi={data.kpis.find((k) => k.objectiveId === setup)!} onClose={() => setSetup(null)} />}
      <NewGoal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function GoalSetup({ objective, kpi, onClose }: { objective: Objective; kpi: KpiCard; onClose(): void }) {
  const { call } = useEnt();
  const members = useGet<{ members: Member[] }>("/members");
  const { busy, error, run } = useAction();
  const unit = kpi.unit === "money" ? 10 ** minorDigits(kpi.currency) : kpi.unit === "ratio" ? 0.01 : 1;
  const [target, setTarget] = useState(objective.targetValue ? String(objective.targetValue / unit) : "");
  const [deadline, setDeadline] = useState(objective.deadline?.slice(0, 10) ?? "");
  const [owner, setOwner] = useState(objective.ownerId ?? "");
  const [weeks, setWeeks] = useState("13");
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={objective.name} description={objective.missing.length ? `Still needs ${objective.missing.map((m) => NEEDS[m] ?? m).join(", ")}.` : "Ready. Changes create a new version."}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => call("POST", `/objectives/${objective.id}`, { ...(target !== "" ? { targetValue: Number(target) * unit } : {}), ...(deadline ? { deadline } : {}), ownerId: owner || null, ...(kpi.series.length ? { baselineFromData: { weeks: Math.max(1, Math.min(104, Math.round(Number(weeks) || 13))) } } : {}) }))) onClose();
        }}
      >
        <Field label={`Target${kpi.unit === "money" ? ` (${kpi.currency}, total for the period)` : kpi.unit === "ratio" ? " (%)" : ""}`} htmlFor="gs-target">
          <input id="gs-target" className="input" type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label="Target date" htmlFor="gs-date">
          <input id="gs-date" className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        <Field label="Owner">
          <Select label="Owner" value={owner} onValueChange={setOwner} options={(members.data?.members ?? []).map((m) => ({ value: m.id, label: `${m.name} · ${ROLE[m.role]}` }))} />
        </Field>
        {kpi.series.length > 0 ? (
          <Field label="Baseline: last how many weeks of data" htmlFor="gs-weeks" hint="Computed from your imported records.">
            <input id="gs-weeks" className="input" type="number" min={1} max={104} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
          </Field>
        ) : (
          <p className="note">The baseline is computed from your data. Import a CSV in Data first.</p>
        )}
        <ErrorLine error={error} />
        <Button variant="primary" type="submit" disabled={busy}>
          Save goal
        </Button>
      </form>
    </Sheet>
  );
}

function NewGoal({ open, onClose }: { open: boolean; onClose(): void }) {
  const { call } = useEnt();
  const metrics = useGet<{ metrics: MetricDefinition[] }>("/metrics");
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [metricId, setMetricId] = useState("");
  const [direction, setDirection] = useState("increase");
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="New goal" description="Name it and pick what measures it. Finish target, date and owner next.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => call("POST", "/objectives", { name, metricId, direction, targetValue: 0 }))) {
            setName("");
            onClose();
          }
        }}
      >
        <Field label="Goal" htmlFor="ng-name">
          <input id="ng-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Grow revenue 10% this quarter" />
        </Field>
        <Field label="Measured by">
          <Select label="Measured by" value={metricId} onValueChange={setMetricId} options={(metrics.data?.metrics ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.unit})` }))} />
        </Field>
        <Field label="Direction">
          <Select label="Direction" value={direction} onValueChange={setDirection} options={[{ value: "increase", label: "Increase" }, { value: "decrease", label: "Decrease" }]} />
        </Field>
        <ErrorLine error={error} />
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !metricId}>
          Create goal
        </Button>
      </form>
    </Sheet>
  );
}
