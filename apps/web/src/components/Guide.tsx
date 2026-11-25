"use client";

import { Sheet } from "./ui";

export const LOOP = [
  { k: "D", title: "Good decisions", tool: "Orion", body: "Compare options — always including doing nothing — against one measurable goal, and record what you expect before acting." },
  { k: "A", title: "Effective execution", tool: "Compass", body: "Give the chosen work an owner, clear done-when criteria and a due date. Clear blockers. Prove delivery." },
  { k: "L", title: "Continuous learning", tool: "Learning", body: "Compare what happened with the forecast. Keep the lesson, and what the cycle left behind." },
];

export const GLOSSARY: [string, string][] = [
  ["Chance of winning", "P(Win | X): the chance the goal is met by its deadline, from the data trend plus the expected effect of approved work, discounted by how reliably the team delivers."],
  ["Chance of winning if we do this", "P(Win | π, E) for one option. Orion recommends the eligible option with the highest value: π* = argmax P(Win | π, E)."],
  ["Loop strength", "P(D) × P(A | D) × P(L | D, A): how often decisions are made well, then delivered, then learned from. Measured from your own history; a weak link limits the whole loop."],
  ["Expected profit gain", "The extra profit an option is likely to add after its own cost, compared with doing nothing — the likelihood-weighted average of its outcomes."],
  ["Chance of losing money", "How likely an option is to cost more than it brings in. Your policy sets the highest chance you accept."],
  ["Lasting advantage", "Something valuable and hard to copy that a cycle leaves behind: customer trust, a deeper integration, better decision data. Shown apart from the money figures."],
  ["Policy checks", "Hard limits: budget per action, acceptable chance of loss, worst case and data freshness. Options that fail one cannot be chosen."],
  ["Forecast accuracy", "How close past forecasts were to what happened (Brier score, lower is better), compared with guessing the average."],
  ["Orion", "The decision engine: a fixed, auditable calculation, so the same inputs always give the same answer."],
  ["Compass", "The task system: owners, blockers, proof of delivery and a short debrief when work is done."],
];

export function GuideSheet({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="How it works" description="Winning = Good decisions × Effective execution × Continuous learning.">
      <ol className="steps steps-col">
        {LOOP.map((s) => (
          <li key={s.k}>
            <span className="steps-k">{s.tool}</span>
            <b>{s.title}</b>
            <span>{s.body}</span>
          </li>
        ))}
      </ol>
      <p className="note">The multiplication is the point: a weak link limits the whole loop. Advantage compounds when each cycle leaves something hard to copy behind.</p>
      <h3 className="h-mini">What the numbers mean</h3>
      <dl className="facts glossary">
        {GLOSSARY.map(([t, d]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
