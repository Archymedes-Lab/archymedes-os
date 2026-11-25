"use client";

import { useState } from "react";
import type { DecisionSummary, Outcome, TaskView, TodayView } from "@archymedes/engine/api-types";
import { MOAT_KINDS } from "@archymedes/engine/api-types";
import { minorDigits } from "@archymedes/engine/money";
import { date, money, pct, useAction, useEnt, useGet } from "@/lib/client";
import type { Nav } from "../Shell";
import { Button, Chip, Empty, ErrorLine, Facts, Field, Figure, PageHead, Section, Select, Sheet } from "../ui";
import { Calibration, ImpactScatter, PredictedVsMeasured } from "../viz";

type OutcomeRow = Outcome & { decisionTitle: string };

export function LearningPage({ nav }: { nav: Nav }) {
  const out = useGet<{ outcomes: OutcomeRow[] }>("/outcomes");
  const decisions = useGet<{ decisions: DecisionSummary[] }>("/decisions");
  const today = useGet<TodayView>("/today");
  const tasks = useGet<{ tasks: TaskView[] }>("/tasks");
  const { me, currency } = useEnt();
  const [register, setRegister] = useState<DecisionSummary | null>(null);
  const [review, setReview] = useState<OutcomeRow | null>(null);
  const outcomes = out.data?.outcomes ?? [];
  const measuring = (decisions.data?.decisions ?? []).filter((d) => d.state === "Measuring" && !outcomes.some((o) => o.decisionId === d.id && o.status === "pending_review"));
  const pending = outcomes.filter((o) => o.status === "pending_review");
  const debriefed = (tasks.data?.tasks ?? []).filter((t) => t.debrief).map((t) => ({ title: t.title, predicted: t.impact, actual: t.debrief!.actualImpact }));
  const cal = today.data?.calibration;
  const canMeasure = ["lead", "executive", "admin"].includes(me.role);
  const canReview = ["finance", "executive"].includes(me.role);
  return (
    <>
      <PageHead index="05" title="Learning" lede="Compare what happened with what was forecast, keep the lesson, and note what each cycle left behind." />
      <div className="figs figs-4">
        <Figure label="Forecast error" value={cal?.score == null ? "—" : cal.score.toFixed(3)} sub={`Brier, ${cal?.n ?? 0} forecasts · lower is better`} explain="Average squared gap between forecast chances and what happened. 0 is perfect; 0.25 is a coin flip." />
        <Figure label="Better than guessing" value={cal?.skill == null ? "—" : `${cal.skill >= 0 ? "+" : ""}${Math.round(cal.skill * 100)}%`} sub="vs always predicting the average" />
        <Figure label="To measure" value={measuring.length} sub="delivered, not yet measured" />
        <Figure label="To review" value={pending.length} sub="measured, not yet reviewed" />
      </div>

      {(measuring.length > 0 || pending.length > 0) && (
        <Section title="Close the loop">
          <ul className="rows">
            {measuring.map((d) => (
              <li key={d.id} className="row row-static">
                <span className="row-main">
                  <b>{d.title}</b>
                  <span className="muted">Delivered · measure the result against a comparison group</span>
                </span>
                {canMeasure && (
                  <Button size="sm" variant="primary" onClick={() => setRegister(d)}>
                    Measure
                  </Button>
                )}
              </li>
            ))}
            {pending.map((o) => (
              <li key={o.id} className="row row-static">
                <span className="row-main">
                  <b>{o.decisionTitle}</b>
                  <span className="muted">
                    Measured {money(o.measurement.incrementalTotalMinor, currency, { signed: true })} vs forecast {money(o.predicted.evRevenueMinor, currency)} · {o.measurement.confidenceLabel}
                  </span>
                </span>
                {canReview ? (
                  <Button size="sm" variant="primary" onClick={() => setReview(o)}>
                    Review
                  </Button>
                ) : (
                  <span className="muted">Finance or an executive reviews</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Forecast against what happened">
        {outcomes.length === 0 ? (
          <Empty>No measured outcomes yet.</Empty>
        ) : (
          <>
            <PredictedVsMeasured currency={currency} rows={outcomes.map((o) => ({ label: o.decisionTitle, predicted: { ev: o.predicted.evRevenueMinor }, measured: { value: o.measurement.incrementalTotalMinor, low: o.measurement.ci95 ? o.measurement.ci95.lowMinor * o.measurement.treatedN : null, high: o.measurement.ci95 ? o.measurement.ci95.highMinor * o.measurement.treatedN : null } }))} />
            <ul className="rows">
              {outcomes.map((o) => (
                <li key={o.id}>
                  <button type="button" className="row" onClick={() => nav.openDecision(o.decisionId)}>
                    <span className="row-main">
                      <b>{o.decisionTitle}</b>
                      <span className="muted">{o.reviewRationale ?? o.measurement.confidenceLabel}</span>
                    </span>
                    <span className="row-num">{money(o.measurement.incrementalTotalMinor, currency, { signed: true })}</span>
                    <Chip tone={o.status === "verified" ? "good" : o.status === "disputed" ? "bad" : "warn"}>{o.status === "pending_review" ? "To review" : o.status === "verified" ? "Verified" : "Disputed"}</Chip>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <div className="cols">
        <Section title="How accurate decision forecasts are">
          {cal && cal.points.length ? <Calibration points={cal.points} /> : <Empty>Reviewed outcomes build this up.</Empty>}
          <p className="note">Dots: individual forecasts. Line: how often forecasts of each chance came true. The diagonal is perfect calibration.</p>
        </Section>
        <Section title="How accurate task estimates are">
          <ImpactScatter points={debriefed} />
        </Section>
      </div>
      {register && <MeasureSheet decision={register} onClose={() => setRegister(null)} />}
      {review && <ReviewSheet outcome={review} onClose={() => setReview(null)} />}
    </>
  );
}

function values(text: string, unit: number): number[] | null {
  const xs = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => Math.round(Number(x) * unit));
  return xs.length && xs.every(Number.isSafeInteger) ? xs : null;
}

function MeasureSheet({ decision, onClose }: { decision: DecisionSummary; onClose(): void }) {
  const { call, currency } = useEnt();
  const { busy, error, run } = useAction();
  const unit = 10 ** minorDigits(currency);
  const [method, setMethod] = useState("random_holdout");
  const [treated, setTreated] = useState("");
  const [control, setControl] = useState("");
  const [start, setStart] = useState(() => new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const t = values(treated, unit);
  const c = values(control, unit);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Measure the result" description={decision.title}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => call("POST", `/decisions/${decision.id}/outcomes`, { method, treatedValues: t, comparisonValues: c, windowStart: start, windowEnd: end }))) onClose();
        }}
      >
        <Field label="Compared against" hint="A random holdout gives a causal answer; before/after is descriptive only.">
          <Select label="Comparison" value={method} onValueChange={setMethod} options={[{ value: "random_holdout", label: "Random holdout group" }, { value: "matched_cohort", label: "Matched similar accounts" }, { value: "pre_post", label: "Before and after" }]} />
        </Field>
        <div className="grid-2">
          <Field label="From" htmlFor="m-start">
            <input id="m-start" className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="m-end">
            <input id="m-end" className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label={`Revenue per account that got the change (${currency})`} htmlFor="m-t" hint={t ? `${t.length} accounts` : "Paste numbers separated by commas or spaces."}>
          <textarea id="m-t" className="input mono" rows={3} value={treated} onChange={(e) => setTreated(e.target.value)} />
        </Field>
        <Field label={`Revenue per account that did not (${currency})`} htmlFor="m-c" hint={c ? `${c.length} accounts` : undefined}>
          <textarea id="m-c" className="input mono" rows={3} value={control} onChange={(e) => setControl(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" variant="primary" disabled={busy || !t || !c}>
          Record result
        </Button>
      </form>
    </Sheet>
  );
}

function ReviewSheet({ outcome, onClose }: { outcome: OutcomeRow; onClose(): void }) {
  const { call, currency } = useEnt();
  const { busy, error, run } = useAction();
  const [lesson, setLesson] = useState("");
  const [next, setNext] = useState("expand");
  const [asset, setAsset] = useState("");
  const [kind, setKind] = useState("decision_data");
  const send = (verdict: "verified" | "disputed") => run(() => call("POST", `/outcomes/${outcome.id}/review`, { verdict, rationale: lesson, next, revisitOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), ...(asset.trim() ? { assetLeft: asset.trim(), assetKind: kind } : {}) })).then((ok) => ok && onClose());
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Review the result" description={outcome.decisionTitle}>
      <Facts
        rows={[
          ["Forecast", `${money(outcome.predicted.evRevenueMinor, currency)} · ${pct(outcome.predicted.pGoal)} chance of the target`],
          ["What happened", money(outcome.measurement.incrementalTotalMinor, currency, { signed: true })],
          ["Per account", `${money(outcome.measurement.liftPerUnitMinor, currency, { signed: true })}${outcome.measurement.ci95 ? ` (95%: ${money(outcome.measurement.ci95.lowMinor, currency)} to ${money(outcome.measurement.ci95.highMinor, currency)})` : ""}`],
          ["Strength of evidence", outcome.measurement.confidenceLabel],
          ["Window", `${date(outcome.windowStart)} – ${date(outcome.windowEnd)}`],
        ]}
      />
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Lesson" htmlFor="r-lesson">
          <textarea id="r-lesson" className="input" rows={2} value={lesson} onChange={(e) => setLesson(e.target.value)} />
        </Field>
        <Field label="Next">
          <Select label="Next" value={next} onValueChange={setNext} options={[{ value: "expand", label: "Expand it" }, { value: "revise", label: "Revise it" }, { value: "stop", label: "Stop it" }]} />
        </Field>
        <div className="grid-2">
          <Field label="What this cycle left behind" htmlFor="r-asset" hint="Advantage compounds when each cycle leaves something hard to copy.">
            <input id="r-asset" className="input" value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="e.g. Labelled churn-reason dataset" />
          </Field>
          <Field label="Kind">
            <Select label="Kind of advantage" value={kind} onValueChange={setKind} options={MOAT_KINDS.map((k) => ({ value: k.kind, label: k.label }))} />
          </Field>
        </div>
        <ErrorLine error={error} />
        <div className="actions">
          <Button variant="primary" disabled={busy || !lesson.trim()} onClick={() => send("verified")}>
            Verify result
          </Button>
          <Button variant="danger" disabled={busy || !lesson.trim()} onClick={() => send("disputed")}>
            Dispute
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
