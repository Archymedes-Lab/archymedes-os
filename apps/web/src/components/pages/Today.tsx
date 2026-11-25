"use client";

import type { TodayView } from "@archymedes/engine/api-types";
import { metricValue, money, pct, STATE_LABEL, stateTone, useEnt, useGet } from "@/lib/client";
import type { Nav, Page } from "../Shell";
import { Button, Chip, Empty, ErrorLine, Explain, PageHead, Progress, Section } from "../ui";
import { Compounding, GoalBullet, LoopChain } from "../viz";

const STEP_PAGE: Record<string, Page> = { data: "data", goal: "goals", team: "settings", compare: "decisions", approve: "decisions", deliver: "compass", learn: "learning" };
const WEAK_ACTION: Record<string, { text: string; page: Page; button: string }> = {
  decisions: { text: "Compare options against a measurable goal and record the forecast before approving.", page: "decisions", button: "Open decisions" },
  execution: { text: "Approved work is not being delivered with proof. Clear blockers and close tasks with evidence.", page: "compass", button: "Open Compass" },
  learning: { text: "Delivered work is not being reviewed. Compare outcomes with forecasts and record the lesson.", page: "learning", button: "Open learning" },
};

export function TodayPage({ nav }: { nav: Nav }) {
  const { data, error } = useGet<TodayView>("/today");
  const { me } = useEnt();
  if (error) return <ErrorLine error={error.message} />;
  if (!data) return <div className="loading">Loading…</div>;
  const cur = data.profile.currency;
  const steps = data.gettingStarted;
  const doneSteps = steps.filter((s) => s.done).length;
  const loop = data.winning.loop;
  const goals = data.winning.goals;
  const weak = WEAK_ACTION[loop.weakest];
  return (
    <>
      <PageHead index="01" title="Today" lede={`${data.attention.length} decision${data.attention.length === 1 ? "" : "s"} and ${data.tasks.filter((t) => t.ownerId === me.id).length} task${data.tasks.filter((t) => t.ownerId === me.id).length === 1 ? "" : "s"} waiting on you.`} />

      <section className="win" aria-labelledby="win-h">
        <h2 id="win-h" className="sr-only">
          Chance of winning
        </h2>
        {data.kpis.map((k) => {
          const g = goals.find((x) => x.objectiveId === k.objectiveId);
          return (
            <article key={k.objectiveId} className="win-goal">
              <span className="win-name">{k.name}</span>
              <Explain text="P(Win | X): the chance this goal is met by its deadline — the data trend plus approved work, discounted by how reliably your team delivers.">
                <button type="button" className="win-p" aria-label={`Chance of winning ${g?.pWin == null ? "unknown" : pct(g.pWin)}. What does this mean?`}>
                  {g?.pWin === null || g?.pWin === undefined ? "—" : pct(g.pWin)}
                </button>
              </Explain>
              <span className="win-sub">{k.status === "draft" ? "Goal not ready — finish setup to measure it" : g?.initiatives ? `chance of winning · ${g.initiatives} initiative${g.initiatives === 1 ? "" : "s"} counted · trend alone ${pct(g.pWinTrendOnly)}` : "chance of winning on the current trend"}</span>
              {k.status === "active" && <GoalBullet baseline={k.baseline?.value ?? null} target={k.target.value} actual={k.actual} forecast={k.forecast} format={(v) => metricValue(v, k.unit, cur, true)} direction={k.direction} />}
              <span className="win-foot">
                <span>Now {metricValue(k.actual, k.unit, cur, true)}</span>
                <span>Target {metricValue(k.target.value, k.unit, cur, true)}</span>
              </span>
            </article>
          );
        })}
      </section>

      <Section title="Winning = Good decisions × Effective execution × Continuous learning" id="loop-h" className="sec-loop">
        <LoopChain pD={loop.pD} pA={loop.pAgivenD} pL={loop.pLgivenDA} weakest={loop.weakest} />
        <div className="callout">
          <p>
            <b>Weakest link: {loop.weakest}.</b> {weak.text}
          </p>
          <Button variant="primary" size="sm" onClick={() => nav.go(weak.page)}>
            {weak.button}
          </Button>
        </div>
      </Section>

      {doneSteps < steps.length && (
        <Section title="Your first cycle" aside={<span className="muted">{doneSteps} of {steps.length} done</span>}>
          <Progress value={doneSteps / steps.length} label="First cycle progress" />
          <ol className="checklist">
            {steps.map((s, i) => (
              <li key={s.key} className={s.done ? "is-done" : ""}>
                <span className="check-n" aria-hidden>
                  {s.done ? "✓" : String(i + 1).padStart(2, "0")}
                </span>
                <span className="check-t">
                  <b>{s.label}</b>
                  <span>{s.hint}</span>
                </span>
                {!s.done && (
                  <Button size="sm" onClick={() => nav.go(STEP_PAGE[s.key])}>
                    Start
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <div className="cols">
        <div>
          <Section title="Next in Compass" aside={<Button variant="ghost" size="sm" onClick={() => nav.go("compass")}>All tasks</Button>}>
            {data.tasks.length === 0 ? (
              <Empty>No open tasks.</Empty>
            ) : (
              <ul className="rows">
                {data.tasks.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="row" onClick={() => nav.openTask(t.id)}>
                      <span className="row-key">{t.key}</span>
                      <span className="row-main">
                        <b>{t.title}</b>
                        <span className="muted">{[t.ownerName ?? "Unassigned", ...t.reasons.slice(0, 2)].join(" · ")}</span>
                      </span>
                      <Chip tone={t.status === "blocked" ? "bad" : t.status === "doing" ? "accent" : "neutral"}>{t.status === "todo" ? "To do" : t.status === "doing" ? "Doing" : t.status === "blocked" ? "Blocked" : "Done"}</Chip>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Decisions waiting on you">
            {data.attention.length === 0 ? (
              <Empty>Nothing waiting on you.</Empty>
            ) : (
              <ul className="rows">
                {data.attention.map((d) => (
                  <li key={d.id}>
                    <button type="button" className="row" onClick={() => nav.openDecision(d.id)}>
                      <span className="row-main">
                        <b>{d.title}</b>
                        <span className="muted">
                          {d.why} · {d.ownerName}
                        </span>
                      </span>
                      <span className="row-num">{money(d.evContributionMinor, cur)}</span>
                      <Chip tone={stateTone(d.state)}>{STATE_LABEL[d.state]}</Chip>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div>
          <Section title="Advantage compounding" aside={<Button variant="ghost" size="sm" onClick={() => nav.go("advantages")}>Advantages</Button>}>
            <Compounding cycles={data.defensibility.cycles} />
            <p className="note">
              {data.defensibility.assets} lasting asset{data.defensibility.assets === 1 ? "" : "s"} · {data.defensibility.decisionDataPairs} forecast-and-outcome pairs of your own decision data.
            </p>
          </Section>
          {data.blockers.length > 0 && (
            <Section title="Blockers">
              <ul className="bullets">
                {data.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
