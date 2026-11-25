"use client";

import { useState } from "react";
import type { AuditEvent, BusinessProfile, Member, PolicyVersion } from "@archymedes/engine/api-types";
import { minorDigits } from "@archymedes/engine/money";
import { date, ROLE, useAction, useEnt, useGet } from "@/lib/client";
import { Button, ErrorLine, Facts, Field, PageHead, Section, Select, Sheet } from "../ui";

const ROLES: Member["role"][] = ["executive", "lead", "operator", "finance", "auditor", "admin"];
const ROLE_HELP: Record<Member["role"], string> = { admin: "configures the workspace", executive: "approves decisions, reviews results", lead: "proposes decisions, owns goals", operator: "does the work, proves delivery", finance: "approves spend, verifies results", auditor: "reads everything, changes nothing" };

export function SettingsPage({ onReset, onNewWorkspace }: { onReset(): void; onNewWorkspace(): void }) {
  const info = useGet<{ profile: BusinessProfile; policy: PolicyVersion }>("/me");
  const members = useGet<{ members: Member[] }>("/members");
  const { me, call, backend, workspaceId } = useEnt();
  const audit = useGet<{ events: AuditEvent[] }>(["auditor", "admin", "finance"].includes(me.role) ? "/audit?limit=500" : null);
  const { busy, error, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [profile, setProfile] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const p = info.data?.policy;
  const cur = info.data?.profile.currency ?? "USD";
  const unit = 10 ** minorDigits(cur);
  const admin = me.role === "admin";
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const d = draft ?? (p ? { maxLoss: String(Math.round(p.evaluation.maxLossProbability * 100)), maxSpend: String(p.evaluation.maxSpendMinor / unit), maxDown: String(p.evaluation.maxDownsideExposureMinor / unit), finance: String(p.financeApprovalOverMinor / unit), rankBy: p.evaluation.rankBy ?? "p_win" } : null);
  const exportAudit = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(audit.data?.events ?? [], null, 2)], { type: "application/json" }));
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  return (
    <>
      <PageHead index="08" title="Settings" lede="Company, rules for decisions, and who does what. Rule changes apply from now on as a new version." />
      <div className="cols">
        <div>
          <Section title="Company" aside={admin && <Button size="sm" onClick={() => setProfile(true)}>Edit</Button>}>
            {info.data && (
              <Facts
                rows={[
                  ["Name", info.data.profile.name],
                  ["Business", info.data.profile.businessModel],
                  ["Currency", info.data.profile.currency],
                  ["Timezone", info.data.profile.timezone],
                  ["Gross margin", info.data.profile.grossMarginBps === null ? "—" : `${info.data.profile.grossMarginBps / 100}%`],
                  ["Stored", backend.kind === "browser" ? "In this browser only" : "Team workspace"],
                ]}
              />
            )}
          </Section>
          <Section title={`Decision rules · v${p?.version ?? "…"}`}>
            {d && (
              <form
                className="form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => call("POST", "/policy", { maxLossProbability: Number(d.maxLoss) / 100, maxSpendMinor: Math.round(Number(d.maxSpend) * unit), maxDownsideExposureMinor: Math.round(Number(d.maxDown) * unit), financeApprovalOverMinor: Math.round(Number(d.finance) * unit), rankBy: d.rankBy }))) setDraft(null);
                }}
              >
                <Field label="Recommend the option with the highest">
                  <Select label="Ranking rule" value={d.rankBy} onValueChange={(v) => setDraft({ ...d, rankBy: v })} options={[{ value: "p_win", label: "Chance of meeting the goal" }, { value: "expected_profit", label: "Expected profit gain" }]} />
                </Field>
                <div className="grid-2">
                  <Field label="Highest acceptable chance of losing money (%)" htmlFor="p-loss">
                    <input id="p-loss" className="input" type="number" min={0} max={100} disabled={!admin} value={d.maxLoss} onChange={(e) => setDraft({ ...d, maxLoss: e.target.value })} />
                  </Field>
                  <Field label={`Budget per action (${cur})`} htmlFor="p-spend">
                    <input id="p-spend" className="input" type="number" disabled={!admin} value={d.maxSpend} onChange={(e) => setDraft({ ...d, maxSpend: e.target.value })} />
                  </Field>
                  <Field label={`Largest acceptable loss (${cur})`} htmlFor="p-down">
                    <input id="p-down" className="input" type="number" disabled={!admin} value={d.maxDown} onChange={(e) => setDraft({ ...d, maxDown: e.target.value })} />
                  </Field>
                  <Field label={`Finance must also approve above (${cur})`} htmlFor="p-fin">
                    <input id="p-fin" className="input" type="number" disabled={!admin} value={d.finance} onChange={(e) => setDraft({ ...d, finance: e.target.value })} />
                  </Field>
                </div>
                {admin && (
                  <Button type="submit" variant="primary" disabled={busy || !draft}>
                    Save as v{(p?.version ?? 0) + 1}
                  </Button>
                )}
                <ErrorLine error={error} />
              </form>
            )}
          </Section>
        </div>
        <div>
          <Section title="Team" aside={admin && <Button size="sm" onClick={() => setAdding(true)}>Add person</Button>}>
            <ul className="rows rows-tight">
              {(members.data?.members ?? []).map((m) => (
                <li key={m.id} className="row row-static">
                  <span className="row-main">
                    <b>{m.name}</b>
                    <span className="muted">
                      {ROLE[m.role]} — {ROLE_HELP[m.role]}
                    </span>
                  </span>
                  {admin && backend.kind === "cloud" && backend.invite && m.id !== me.id && (
                    <Button size="sm" variant="ghost" onClick={() => run(async () => setInvite((await backend.invite!(workspaceId, m.id)).url))}>
                      Invite link
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {invite && (
              <p className="ok" role="status">
                Single-use link, valid 14 days: <code>{invite}</code>
              </p>
            )}
            {backend.kind === "browser" && <p className="note">In the browser edition, use the menu at top right to see the app as any person.</p>}
          </Section>
          {audit.data && (
            <Section title="Audit trail" aside={<Button size="sm" variant="ghost" onClick={exportAudit}>Export</Button>}>
              <ul className="rows rows-tight audit">
                {[...audit.data.events].reverse().slice(0, 30).map((e) => (
                  <li key={e.id} className="row row-static">
                    <span className="row-main">
                      <b>{e.action}</b>
                      <span className="muted">
                        {date(e.at)} · {members.data?.members.find((m) => m.id === e.actorId)?.name ?? e.actorId}
                        {e.detail ? ` · ${e.detail}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Workspace">
            <div className="actions">
              <Button onClick={onNewWorkspace}>New workspace</Button>
              {!confirmReset ? (
                <Button variant="danger" onClick={() => setConfirmReset(true)}>
                  {backend.kind === "browser" ? "Delete everything in this browser" : "Sign out"}
                </Button>
              ) : (
                <>
                  <Button variant="danger" onClick={onReset}>
                    Yes, delete
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                    Keep it
                  </Button>
                </>
              )}
            </div>
          </Section>
        </div>
      </div>
      <AddPerson open={adding} onClose={() => setAdding(false)} />
      {info.data && <ProfileSheet open={profile} onClose={() => setProfile(false)} profile={info.data.profile} />}
    </>
  );
}

function AddPerson({ open, onClose }: { open: boolean; onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>("lead");
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Add person" description="Roles decide who can propose, approve, deliver, review and audit.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => call("POST", "/members", { name, title: "", role, department: "" }))) {
            setName("");
            onClose();
          }
        }}
      >
        <Field label="Name" htmlFor="ap-name">
          <input id="ap-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role" hint={ROLE_HELP[role as Member["role"]]}>
          <Select label="Role" value={role} onValueChange={setRole} options={ROLES.map((r) => ({ value: r, label: ROLE[r] }))} />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Add
        </Button>
      </form>
    </Sheet>
  );
}

function ProfileSheet({ open, onClose, profile }: { open: boolean; onClose(): void; profile: BusinessProfile }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [name, setName] = useState(profile.name);
  const [tz, setTz] = useState(profile.timezone);
  const [margin, setMargin] = useState(profile.grossMarginBps === null ? "" : String(profile.grossMarginBps / 100));
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Company" description="Currency is fixed for a workspace.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => call("POST", "/profile", { name: name.trim(), timezone: tz.trim(), grossMarginBps: margin === "" ? null : Math.round(Number(margin) * 100) }))) onClose();
        }}
      >
        <Field label="Name" htmlFor="pf-name">
          <input id="pf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Timezone" htmlFor="pf-tz">
          <input id="pf-tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)} />
        </Field>
        <Field label="Gross margin (%)" htmlFor="pf-m" hint="Used to turn extra revenue into profit when an option does not say.">
          <input id="pf-m" className="input" type="number" min={0} max={100} value={margin} onChange={(e) => setMargin(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}
