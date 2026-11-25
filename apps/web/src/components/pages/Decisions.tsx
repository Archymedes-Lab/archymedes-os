"use client";

import { useMemo, useState } from "react";
import type { DecisionDetail, DecisionSummary, Evaluation, Objective, TodayView } from "@archymedes/engine/api-types";
import { minorDigits } from "@archymedes/engine/money";
import { exampleAlternatives, templateFor } from "@archymedes/engine/templates";
import type { AlternativeInput, AlternativeResult } from "@archymedes/engine/types";
import { ago, date, money, pct, STATE_LABEL, stateTone, useAction, useEnt, useGet } from "@/lib/client";
import type { Nav } from "../Shell";
import { Button, Chip, Empty, ErrorLine, Facts, Field, Figure, PageHead, Section, Select, Sheet, Tabs } from "../ui";
import { LifecycleRail, Meter, PredictedVsMeasured, RangeStrip, ScenarioChart, Tornado, WinBars } from "../viz";
import { Attachments } from "./Data";

const DECIDE = ["lead", "executive", "admin"];
const GATE: Record<string, string> = { max_spend: "Over budget", max_loss_probability: "Too likely to lose money", max_downside_exposure: "Worst case too large", data_freshness: "Data out of date" };
const ORDER = ["Draft", "NeedsEvidence", "Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring", "Debriefed", "Rejected", "Cancelled"];

export function DecisionsPage({ nav }: { nav: Nav }) {
  const { data, error } = useGet<{ decisions: DecisionSummary[] }>("/decisions");
  const { me, currency } = useEnt();
  const [filter, setFilter] = useState("open");
  const [creating, setCreating] = useState(false);
  const list = (data?.decisions ?? []).filter((d) => filter === "all" || !["Debriefed", "Cancelled", "Rejected"].includes(d.state));
  const groups = useMemo(() => {
    const g = new Map<string, DecisionSummary[]>();
    for (const d of list) g.set(d.state, [...(g.get(d.state) ?? []), d]);
    return ORDER.filter((s) => g.has(s)).map((s) => [s, g.get(s)!] as const);
  }, [list]);
  if (error) return <ErrorLine error={error.message} />;
  return (
    <>
      <PageHead
        index="03"
        title="Decisions"
        lede="Orion compares each option with doing nothing and recommends the one most likely to meet the goal."
        actions={
          <>
            <Tabs label="Show" value={filter} onValueChange={setFilter} items={[{ value: "open", label: "Open" }, { value: "all", label: "All" }]} />
            {DECIDE.includes(me.role) && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New decision
              </Button>
            )}
          </>
        }
      />
      {!data ? (
        <div className="loading">Loading…</div>
      ) : groups.length === 0 ? (
        <Empty action={DECIDE.includes(me.role) ? <Button variant="primary" onClick={() => setCreating(true)}>Compare your first options</Button> : undefined}>No decisions yet.</Empty>
      ) : (
        <div className="board">
          {groups.map(([state, items]) => (
            <section key={state} className="board-col" aria-label={STATE_LABEL[state]}>
              <header>
                <Chip tone={stateTone(state)}>{STATE_LABEL[state]}</Chip>
                <span className="muted">{items.length}</span>
              </header>
              {items.map((d) => (
                <button key={d.id} type="button" className="card" onClick={() => nav.openDecision(d.id)}>
                  <b>{d.title}</b>
                  <span className="muted">{d.objectiveName}</span>
                  <span className="card-figs">
                    <span>{money(d.evContributionMinor, currency)}</span>
                    <span>{d.pGoal !== null ? `${pct(d.pGoal)} chance of target` : ""}</span>
                  </span>
                  <span className="muted">
                    {d.ownerName} · {ago(d.updatedAt)}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
      {creating && <NewDecision onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); nav.openDecision(id); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------

export function DecisionSheet({ id, onClose, nav }: { id: string; onClose(): void; nav: Nav }) {
  const { data, error } = useGet<DecisionDetail>(`/decisions/${id}`);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={data?.decision.title ?? "Decision"} description={data ? `${STATE_LABEL[data.decision.state]} · revision ${data.decision.revision} · ${data.objective.name}` : "Loading"} wide>
      <ErrorLine error={error?.message} />
      {data && <DecisionBody detail={data} nav={nav} />}
    </Sheet>
  );
}

type Confirm = "approve" | "reject" | "request_evidence" | null;

function DecisionBody({ detail, nav }: { detail: DecisionDetail; nav: Nav }) {
  const { me, call } = useEnt();
  const d = detail.decision;
  const ev: Evaluation | undefined = detail.evaluations.find((e) => e.id === d.latestEvaluationId);
  const result = ev?.result ?? null;
  const currency = ev?.snapshot.currency ?? "USD";
  const { busy, error, run } = useAction();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const canDecide = DECIDE.includes(me.role);
  const chosen = result?.alternatives.find((a) => a.id === (d.chosenAlternativeId ?? result.recommendationId));
  const base = result?.alternatives.find((a) => a.isBaseline);
  const candidates = result?.alternatives.filter((a) => !a.isBaseline) ?? [];
  const ranked = candidates.filter((a) => a.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const lo = Math.min(0, ...candidates.flatMap((a) => (a.range ? [a.range.minMinor] : [])));
  const hi = Math.max(0, ...candidates.flatMap((a) => (a.range ? [a.range.maxMinor] : [])));
  const outcome = detail.outcomes[0];
  const rec = result?.alternatives.find((a) => a.id === result.recommendationId);

  return (
    <div className="dec">
      <LifecycleRail state={d.state} history={d.history} />
      {d.hypothesis && <p className="lede-l">{d.hypothesis}</p>}

      {result && result.status !== "failed" && (
        <div className="verdict">
          {rec && !rec.isBaseline ? (
            <p>
              <span className="muted">Orion recommends</span> <b>{rec.name}</b>
              {rec.pWin !== null && base?.pWin != null ? (
                <>
                  : <b>{pct(rec.pWin)}</b> chance of meeting the goal, against {pct(base.pWin)} if you do nothing.
                </>
              ) : (
                <>: highest expected profit gain among options that pass your policy.</>
              )}
            </p>
          ) : rec?.isBaseline ? (
            <p>
              <span className="muted">Orion recommends</span> <b>doing nothing</b>: no option beats the current course.
            </p>
          ) : (
            <p>
              <b>No option can be recommended.</b> {result.status === "needs_evidence" ? "Some figures are missing." : "Every option fails a policy check."}
            </p>
          )}
        </div>
      )}

      <div className="figs figs-6">
        <Figure label={d.chosenAlternativeId ? "Chosen" : "Recommended"} value={chosen?.name ?? "—"} size="s" />
        <Figure label="Chance of winning" value={pct(chosen?.pWin ?? null)} sub={base?.pWin != null ? `${pct(base.pWin)} if nothing changes` : "needs a goal forecast"} explain="P(Win | π, E): chance the goal is met by its date if this option is taken, allowing for the team's delivery record." size="l" />
        <Figure label="Expected profit gain" value={money(chosen?.evContributionMinor, currency)} sub={`over ${d.horizonDays} days, after cost`} explain="The likelihood-weighted average extra profit against doing nothing, after the option's own cost." />
        <Figure label="Chance of losing money" value={pct(chosen?.pLoss ?? null)} sub={`limit ${pct(detail.policy.evaluation.maxLossProbability)}`} />
        <Figure label="Expected revenue" value={money(chosen?.evRevenueMinor, currency)} sub="extra vs doing nothing" />
        <Figure label="Lasting advantage" value={money(chosen?.moatPotentialMinor ?? null, currency)} sub="kept apart from money" explain="Chance the asset is created and kept × its value. Shown separately so it never inflates the money figures." />
      </div>

      <div className="actions">
        {canDecide && ["Draft", "NeedsEvidence", "Evaluated"].includes(d.state) && (
          <Button variant={d.state === "Evaluated" ? "secondary" : "primary"} disabled={busy} onClick={() => run(() => call("POST", `/decisions/${d.id}/evaluations`, {}))}>
            {d.state === "Evaluated" ? "Recalculate" : "Compare options"}
          </Button>
        )}
        {detail.canApprove && !confirm && (
          <>
            <Button variant="primary" onClick={() => setConfirm("approve")}>
              Approve
            </Button>
            <Button onClick={() => setConfirm("request_evidence")}>Ask for evidence</Button>
            <Button variant="danger" onClick={() => setConfirm("reject")}>
              Reject
            </Button>
          </>
        )}
        {d.state === "AwaitingApproval" && !detail.canApprove && <span className="muted">Waiting for an independent executive or finance approver.</span>}
        {detail.work.length > 0 && (
          <Button variant="ghost" onClick={() => nav.go("compass")}>
            Open in Compass
          </Button>
        )}
      </div>

      {confirm && ev && (
        <form
          className="confirm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => call("POST", `/decisions/${d.id}/approvals`, { evaluationId: ev.id, verdict: confirm, reason }, { ifRevision: d.revision }))) {
              setConfirm(null);
              setReason("");
            }
          }}
        >
          <p>
            {confirm === "approve" ? "Approve" : confirm === "reject" ? "Reject" : "Ask for evidence on"} <b>{chosen?.name}</b>, revision {d.revision}. {confirm === "approve" && "Approval creates a Compass task with an owner and done-when criteria."}
          </p>
          <Field label="Reason" htmlFor="c-reason">
            <textarea id="c-reason" className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="actions">
            <Button type="submit" variant={confirm === "reject" ? "danger" : "primary"} disabled={busy || !reason.trim()}>
              {confirm === "approve" ? "Confirm approval" : confirm === "reject" ? "Confirm rejection" : "Send request"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ErrorLine error={error} />

      {d.state === "Evaluated" && canDecide && result?.status === "complete" && (
        <form
          className="confirm"
          onSubmit={async (e) => {
            e.preventDefault();
            await run(() => call("POST", `/decisions/${d.id}/choose`, { alternativeId: choice ?? result.recommendationId, rationale }, { ifRevision: d.revision }));
          }}
        >
          <p>
            <b>Submit a choice for approval.</b> The forecast is recorded now, before anything happens.
          </p>
          <div className="choices" role="radiogroup" aria-label="Option">
            {candidates.map((a) => (
              <label key={a.id} className={`choice ${!a.eligible ? "is-gated" : ""}`}>
                <input type="radio" name="choice" disabled={!a.eligible} checked={(choice ?? result.recommendationId) === a.id} onChange={() => setChoice(a.id)} />
                <span>{a.name}</span>
                {a.id === result.recommendationId && <Chip tone="accent">Recommended</Chip>}
                {!a.eligible && <Chip tone="bad">Fails a policy check</Chip>}
              </label>
            ))}
          </div>
          <Field label="Why" htmlFor="c-why" hint={(choice ?? result.recommendationId) !== result.recommendationId ? "You are overriding the recommendation; your reason is recorded." : undefined}>
            <textarea id="c-why" className="input" rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !rationale.trim() || !(choice ?? result.recommendationId)}>
            Submit for approval
          </Button>
        </form>
      )}

      {result && result.status !== "failed" && (
        <>
          {result.alternatives.some((a) => a.pWin !== null) && (
            <Section title="Chance of meeting the goal, by option">
              <WinBars options={result.alternatives.filter((a) => a.pWin !== null).map((a) => ({ id: a.id, name: a.isBaseline ? "Do nothing" : a.name, pWin: a.pWin!, isBaseline: a.isBaseline, recommended: a.id === result.recommendationId, eligible: a.eligible }))} />
              <p className="note">Orion picks the option most likely to meet the goal: π* = argmax P(Win | π, E). Expected profit, risk and lasting advantage are shown alongside.</p>
            </Section>
          )}
          <Section title="Options side by side" aside={result.closeCall ? <Chip tone="warn">Close call</Chip> : null}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Option</th>
                    <th className="num">Chance of winning</th>
                    <th className="num">Expected profit</th>
                    <th>Chance of loss</th>
                    <th>Range</th>
                    <th className="num">Lasting advantage</th>
                    <th>Policy</th>
                  </tr>
                </thead>
                <tbody>
                  {result.alternatives.map((a) => (
                    <AltRow key={a.id} a={a} currency={currency} lo={lo} hi={hi} limit={detail.policy.evaluation.maxLossProbability} recommended={a.id === result.recommendationId} />
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title="What could happen">
            <ScenarioChart alternatives={result.alternatives} currency={currency} />
            <p className="note">Each column is one outcome: width is how likely, height is profit gained (blue) or lost (red) against doing nothing. The line is the expected value.</p>
          </Section>
          {ranked[0] && result.sensitivities.length > 0 && (
            <Section title="What would change the recommendation">
              <Tornado items={result.sensitivities} ev={ranked[0].evContributionMinor!} runnerUp={ranked[1]?.evContributionMinor ?? 0} currency={currency} />
            </Section>
          )}
          {result.questions.length > 0 && (
            <Section title="Open questions">
              <ol className="qlist">
                {result.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </Section>
          )}
        </>
      )}

      <Section title="Aftermath">
        {outcome ? (
          <>
            <PredictedVsMeasured
              currency={currency}
              rows={[
                {
                  label: "Revenue gained",
                  predicted: { ev: outcome.predicted.evRevenueMinor, ...(chosen?.scenarios.length ? { min: Math.min(...chosen.scenarios.map((s) => s.deltaRevenueMinor)), max: Math.max(...chosen.scenarios.map((s) => s.deltaRevenueMinor)) } : {}) },
                  measured: { value: outcome.measurement.incrementalTotalMinor, low: outcome.measurement.ci95 ? outcome.measurement.ci95.lowMinor * outcome.measurement.treatedN : null, high: outcome.measurement.ci95 ? outcome.measurement.ci95.highMinor * outcome.measurement.treatedN : null },
                },
              ]}
            />
            <Facts
              rows={[
                ["Forecast before acting", `${money(outcome.predicted.evRevenueMinor, currency)} · ${pct(outcome.predicted.pGoal)} chance of the action target`],
                ["What happened", `${money(outcome.measurement.incrementalTotalMinor, currency, { signed: true })} · ${outcome.goalMet ? "target met" : "target missed"}`],
                ["How it was measured", outcome.measurement.confidenceLabel],
                ["Lesson", outcome.reviewRationale ?? "Awaiting review"],
                ["Next", outcome.next ?? "—"],
              ]}
            />
          </>
        ) : (
          <p className="note">{["Executing", "DeliveryReview", "Measuring"].includes(d.state) ? "The forecast is locked in. Once delivery is verified, measure the result in Learning and compare it here." : "After approval and delivery, what actually happened is compared with this forecast."}</p>
        )}
      </Section>

      {ev && (
        <Section title="Record">
          <Facts
            rows={[
              ["Forecast fingerprint", <code key="h">{ev.inputHash.slice(0, 16)}…</code>],
              ["Calculated", `${date(ev.completedAt ?? ev.createdAt)} · ${ev.evaluatorVersion} · ranked by ${result?.rankedBy === "p_win" ? "chance of winning" : "expected profit"}`],
              ["Approvals", detail.approvals.length ? detail.approvals.map((a) => `${a.verdict.replace("_", " ")} by ${a.role}${a.active ? "" : " (superseded)"}`).join(" · ") : "—"],
              ["Compass", detail.work.length ? detail.work.map((w) => `${w.compassTaskId ?? "syncing"} · ${w.state.replace("_", " ")}`).join(" · ") : "—"],
            ]}
          />
        </Section>
      )}
      <Attachments kind="decision" id={d.id} />
    </div>
  );
}

function AltRow({ a, currency, lo, hi, limit, recommended }: { a: AlternativeResult; currency: string; lo: number; hi: number; limit: number; recommended: boolean }) {
  return (
    <tr className={recommended ? "is-rec" : a.isBaseline ? "is-base" : ""}>
      <td>
        <b>{a.isBaseline ? "Do nothing" : a.name}</b>
        {recommended && !a.isBaseline && <Chip tone="accent">Recommended</Chip>}
      </td>
      <td className="num">{pct(a.pWin)}</td>
      <td className="num">{money(a.evContributionMinor, currency)}</td>
      <td>{a.pLoss !== null && !a.isBaseline ? <Meter value={a.pLoss} limit={limit} label="Chance of losing money" /> : "—"}</td>
      <td>{a.range && !a.isBaseline ? <RangeStrip min={a.range.minMinor} max={a.range.maxMinor} ev={a.evContributionMinor!} lo={lo} hi={hi} currency={currency} /> : "—"}</td>
      <td className="num">{money(a.moatPotentialMinor, currency)}</td>
      <td>
        {a.isBaseline ? "—" : a.gates.every((g) => g.passed) && a.complete ? <Chip tone="good">Passes</Chip> : a.gates.filter((g) => !g.passed).map((g) => <Chip key={g.key} tone="bad" title={g.detail}>{GATE[g.key]}</Chip>)}
        {!a.complete && <Chip tone="warn">Missing figures</Chip>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

interface Draft {
  name: string;
  hypothesis: string;
  cost: string;
  p: [string, string, string];
  inc: [string, string, string];
  moat: string;
}

const blank = (): Draft => ({ name: "", hypothesis: "", cost: "", p: ["25", "50", "25"], inc: ["", "", ""], moat: "" });

function NewDecision({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const { call, currency } = useEnt();
  const objectives = useGet<{ objectives: Objective[] }>("/objectives");
  const me = useGet<TodayView>("/today");
  const { busy, error, run } = useAction();
  const unit = 10 ** minorDigits(currency);
  const template = templateFor(me.data?.profile.businessModel ?? "subscription");
  const active = (objectives.data?.objectives ?? []).filter((o) => o.status === "active");
  const [title, setTitle] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [cands, setCands] = useState<Draft[]>([blank()]);
  const upd = (i: number, patch: Partial<Draft>) => setCands(cands.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const useExamples = () => {
    const alts = exampleAlternatives(template, new Date().toISOString(), Math.log10(unit)).filter((a) => !a.isBaseline).slice(0, 2);
    setTitle(`${template.objectiveName}: which option?`);
    setCands(alts.map((a) => ({ name: a.name, hypothesis: a.hypothesis ?? "", cost: String((a.scenarios[0].actionCostMinor ?? 0) / unit), p: a.scenarios.map((s) => String(Math.round((s.probability ?? 0) * 100))) as Draft["p"], inc: a.scenarios.map((s) => String((s.revenueMinor ?? 0) / unit)) as Draft["inc"], moat: a.moat?.mechanism ?? "" })));
  };
  const submit = async () => {
    const asOf = new Date().toISOString();
    const base = exampleAlternatives(template, asOf, Math.log10(unit), [])[0];
    const labels = ["Downside", "Base", "Upside"];
    const alternatives: AlternativeInput[] = [
      base,
      ...cands.map((c, i) => ({
        id: `alt-${i + 1}`,
        name: c.name || `Option ${i + 1}`,
        isBaseline: false,
        hypothesis: c.hypothesis,
        spendMinor: Math.round(Number(c.cost || 0) * unit),
        timeToEffectDays: 21,
        assumptions: [{ key: "estimate", label: "Outcomes and chances", value: `${c.inc.join(" / ")} at ${c.p.join(" / ")}%`, provenance: { source: "decision author", asOf, origin: "estimated" as const } }],
        ...(c.moat.trim() ? { moat: { mechanism: c.moat.trim(), pCreatedRetained: 0.5, conditionalValueMinor: 0, horizonMonths: 12 } } : {}),
        scenarios: base.scenarios.map((s, k) => ({ key: s.key, label: labels[k], probability: c.p[k] === "" ? null : Number(c.p[k]) / 100, revenueMinor: c.inc[k] === "" ? null : Math.round(Number(c.inc[k]) * unit), actionCostMinor: c.cost === "" ? null : Math.round(Number(c.cost) * unit) })),
      })),
    ];
    await run(async () => {
      const r = await call<{ decision: { id: string } }>("POST", "/decisions", { objectiveId, title, hypothesis: cands[0]?.hypothesis ?? "", horizonDays: 90, cohortSize: 100, alternatives });
      await call("POST", `/decisions/${r.decision.id}/evaluations`, {});
      onCreated(r.decision.id);
    });
  };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="New decision" description="List what you could do. Doing nothing is always included. Leave a figure blank if unknown — Orion will ask for it." wide>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="actions">
          <Button variant="ghost" size="sm" onClick={useExamples}>
            Fill with {template.label.toLowerCase()} examples
          </Button>
        </div>
        <Field label="Decision" htmlFor="nd-title">
          <input id="nd-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are you deciding?" />
        </Field>
        <Field label="Goal it serves" hint={active.length ? undefined : "Finish a goal's setup first (Goals)."}>
          <Select label="Goal it serves" value={objectiveId} onValueChange={setObjectiveId} options={active.map((o) => ({ value: o.id, label: o.name }))} />
        </Field>
        {cands.map((c, i) => (
          <fieldset key={i} className="option">
            <legend>Option {i + 1}</legend>
            <div className="grid-2">
              <Field label="Name" htmlFor={`nd-n${i}`}>
                <input id={`nd-n${i}`} className="input" value={c.name} onChange={(e) => upd(i, { name: e.target.value })} />
              </Field>
              <Field label={`Cost (${currency})`} htmlFor={`nd-c${i}`}>
                <input id={`nd-c${i}`} className="input" type="number" inputMode="decimal" value={c.cost} onChange={(e) => upd(i, { cost: e.target.value })} />
              </Field>
            </div>
            <table className="table table-tight">
              <thead>
                <tr>
                  <th>If it goes</th>
                  <th>Chance (%)</th>
                  <th>Extra revenue ({currency})</th>
                </tr>
              </thead>
              <tbody>
                {["Badly", "As expected", "Well"].map((label, k) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>
                      <input className="input" type="number" aria-label={`Option ${i + 1} ${label} chance`} value={c.p[k]} onChange={(e) => upd(i, { p: c.p.map((x, j) => (j === k ? e.target.value : x)) as Draft["p"] })} />
                    </td>
                    <td>
                      <input className="input" type="number" aria-label={`Option ${i + 1} ${label} extra revenue`} value={c.inc[k]} onChange={(e) => upd(i, { inc: c.inc.map((x, j) => (j === k ? e.target.value : x)) as Draft["inc"] })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Field label="What it leaves behind (optional)" htmlFor={`nd-m${i}`} hint="Something hard to copy: customer trust, an integration, better data.">
              <input id={`nd-m${i}`} className="input" value={c.moat} onChange={(e) => upd(i, { moat: e.target.value })} />
            </Field>
          </fieldset>
        ))}
        <div className="actions">
          {cands.length < 4 && <Button onClick={() => setCands([...cands, blank()])}>Add option</Button>}
          <Button type="submit" variant="primary" disabled={busy || !title.trim() || !objectiveId}>
            Compare in Orion
          </Button>
        </div>
        <ErrorLine error={error} />
      </form>
    </Sheet>
  );
}
