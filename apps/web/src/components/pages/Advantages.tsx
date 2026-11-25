"use client";

import { useState } from "react";
import type { Defensibility, MoatAsset } from "@archymedes/engine/api-types";
import { MOAT_KINDS } from "@archymedes/engine/api-types";
import { minorDigits } from "@archymedes/engine/money";
import { money, pct, useAction, useEnt, useGet } from "@/lib/client";
import { Button, Chip, Empty, ErrorLine, Field, Figure, PageHead, Section, Sheet } from "../ui";
import { Compounding } from "../viz";

type Row = MoatAsset & { potentialMinor: number; decisionTitle: string };
const STAGES = ["proposed", "created", "verified", "realized"] as const;
const NEXT = { proposed: "created", created: "verified", verified: "realized", realized: null } as const;
const KIND = Object.fromEntries(MOAT_KINDS.map((k) => [k.kind, k.label]));

export function AdvantagesPage() {
  const { data } = useGet<{ moats: Row[]; defensibility: Defensibility }>("/moats");
  const { me, currency } = useEnt();
  const [advance, setAdvance] = useState<Row | null>(null);
  const moats = data?.moats ?? [];
  const def = data?.defensibility;
  const realized = moats.reduce((s, m) => s + (m.realizedMinor ?? 0), 0);
  return (
    <>
      <PageHead index="06" title="Advantages" lede="What each cycle leaves behind that competitors cannot easily copy. It compounds." />
      <div className="figs figs-4">
        <Figure label="Lasting assets" value={moats.length} sub={`${moats.filter((m) => m.stage === "verified" || m.stage === "realized").length} verified or realized`} />
        <Figure label="Realized value" value={money(realized, currency)} />
        <Figure label="Decision data" value={def?.decisionDataPairs ?? 0} sub="forecast-and-outcome pairs only you have" explain="Every reviewed outcome and debriefed task adds a pair. It makes the next forecast better and cannot be bought." />
        <Figure label="Kinds" value={Object.keys(def?.byKind ?? {}).length} sub="different sources of advantage" />
      </div>
      <Section title="Compounding over cycles">
        <Compounding cycles={def?.cycles ?? []} />
      </Section>
      <Section title="Register">
        {moats.length === 0 ? (
          <Empty>Nothing yet. Each reviewed outcome and debriefed task can leave an asset behind.</Empty>
        ) : (
          <ul className="rows">
            {moats.map((m) => (
              <li key={m.id} className="row row-static">
                <span className="row-main">
                  <b>{m.mechanism}</b>
                  <span className="muted">
                    {KIND[m.kind ?? "know_how"]} · {m.decisionTitle || "—"}
                    {m.evidence.filter(Boolean).length ? ` · ${m.evidence.filter(Boolean).join(" · ")}` : ""}
                  </span>
                </span>
                <span className="row-num">
                  {m.realizedMinor !== null ? money(m.realizedMinor, currency) : m.conditionalValueMinor ? money(m.potentialMinor, currency) : "—"}
                  <small>{m.realizedMinor !== null ? "realized" : m.conditionalValueMinor ? `${pct(m.pCreatedRetained)} likely` : "unvalued"}</small>
                </span>
                <span className="stages" aria-label={`Stage: ${m.stage}`}>
                  {STAGES.map((s) => (
                    <i key={s} className={STAGES.indexOf(s) <= STAGES.indexOf(m.stage) ? "on" : ""} />
                  ))}
                  <Chip tone={m.stage === "realized" ? "good" : m.stage === "verified" ? "accent" : "neutral"}>{m.stage}</Chip>
                </span>
                {NEXT[m.stage] && ["lead", "executive", "admin"].includes(me.role) && (
                  <Button size="sm" onClick={() => setAdvance(m)}>
                    Mark {NEXT[m.stage]}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {advance && <AdvanceSheet m={advance} onClose={() => setAdvance(null)} />}
    </>
  );
}

function AdvanceSheet({ m, onClose }: { m: Row; onClose(): void }) {
  const { call, currency } = useEnt();
  const { busy, error, run } = useAction();
  const [evidence, setEvidence] = useState("");
  const [value, setValue] = useState("");
  const next = NEXT[m.stage]!;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Mark ${next}`} description={m.mechanism}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => call("POST", `/moats/${m.id}/advance`, { evidence, ...(next === "realized" ? { realizedMinor: Math.round(Number(value) * 10 ** minorDigits(currency)) } : {}) }))) onClose();
        }}
      >
        <Field label="Evidence" htmlFor="a-ev" hint="Who uses it, where it is recorded, what it changed.">
          <textarea id="a-ev" className="input" rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        {next === "realized" && (
          <Field label={`Value realized (${currency})`} htmlFor="a-val">
            <input id="a-val" className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
        <ErrorLine error={error} />
        <Button type="submit" variant="primary" disabled={busy || !evidence.trim() || (next === "realized" && !value)}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}
