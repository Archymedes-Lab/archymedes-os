"use client";

import { DropdownMenu, Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessProfile, SessionInfo } from "@archymedes/engine/api-types";
import { browserBackend, cloudBackend, HOSTED } from "@/lib/backend";
import type { Backend } from "@/lib/backend";
import { EntProvider, ROLE, useEnt, useGet } from "@/lib/client";
import { clearLocalFiles } from "@/lib/files";
import { GuideSheet } from "./Guide";
import { Onboarding } from "./Onboarding";
import { AdvantagesPage } from "./pages/Advantages";
import { CompassPage } from "./pages/Compass";
import { DataPage } from "./pages/Data";
import { DecisionSheet, DecisionsPage } from "./pages/Decisions";
import { GoalsPage } from "./pages/Goals";
import { LearningPage } from "./pages/Learning";
import { SettingsPage } from "./pages/Settings";
import { TodayPage } from "./pages/Today";
import { TaskSheet } from "./pages/TaskSheet";

export type Page = "today" | "goals" | "decisions" | "compass" | "learning" | "advantages" | "data" | "settings";
export const NAV: { id: Page; label: string; idx: string }[] = [
  { id: "today", label: "Today", idx: "01" },
  { id: "goals", label: "Goals", idx: "02" },
  { id: "decisions", label: "Decisions", idx: "03" },
  { id: "compass", label: "Compass", idx: "04" },
  { id: "learning", label: "Learning", idx: "05" },
  { id: "advantages", label: "Advantages", idx: "06" },
  { id: "data", label: "Data", idx: "07" },
  { id: "settings", label: "Settings", idx: "08" },
];

export interface Nav {
  go(page: Page): void;
  openDecision(id: string): void;
  openTask(id: string): void;
}

function setHash(p: Page): void {
  window.location.hash = p;
}

function readPage(): Page {
  if (typeof window === "undefined") return "today";
  const h = window.location.hash.slice(1) as Page;
  return NAV.some((n) => n.id === h) ? h : "today";
}

/** Archymedes OS: the whole product, running against a browser or cloud backend. */
export function OsApp({ backend: injected }: { backend?: Backend }) {
  const backend = useMemo(() => injected ?? (HOSTED ? cloudBackend() : browserBackend(window.localStorage)), [injected]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => setSession(await backend.session()), [backend]);
  useEffect(() => {
    let live = true;
    void backend.session().then((s) => live && setSession(s));
    return () => {
      live = false;
    };
  }, [backend]);
  if (!session) return <div className="boot" aria-busy="true" />;
  const me = session.identities.find((i) => i.id === session.actorId);
  if (!me || creating)
    return (
      <Onboarding
        onCancel={session.identities.length ? () => setCreating(false) : undefined}
        onCreate={async (input) => {
          await backend.createWorkspace(input);
          setCreating(false);
          setHash("today");
          await load();
        }}
      />
    );
  return (
    <Tooltip.Provider>
      <EntProvider key={me.id} backend={backend} me={me}>
        <Shell
          identities={session.identities}
          onSwitch={async (id) => {
            await backend.selectIdentity(id);
            await load();
          }}
          onNewWorkspace={() => setCreating(true)}
          onReset={async () => {
            await backend.reset();
            await clearLocalFiles().catch(() => undefined);
            await load();
          }}
        />
      </EntProvider>
    </Tooltip.Provider>
  );
}

function Shell({ identities, onSwitch, onNewWorkspace, onReset }: { identities: SessionInfo["identities"]; onSwitch(id: string): void; onNewWorkspace(): void; onReset(): void }) {
  const { me, setCurrency, backend } = useEnt();
  const [page, setPage] = useState<Page>(readPage);
  const [decision, setDecision] = useState<string | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const [guide, setGuide] = useState(false);
  const info = useGet<{ profile: BusinessProfile; tenant: { name: string } }>("/me");
  useEffect(() => {
    if (info.data) setCurrency(info.data.profile.currency);
  }, [info.data, setCurrency]);
  useEffect(() => {
    const onHash = () => setPage(readPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const nav: Nav = {
    go: (p) => {
      setHash(p);
      setPage(p);
    },
    openDecision: setDecision,
    openTask: setTask,
  };
  const team = identities.filter((i) => i.workspaceId === me.workspaceId);
  const others = identities.filter((i) => i.workspaceId !== me.workspaceId);
  return (
    <div className="os">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <nav className="rail" aria-label="Primary">
        <a className="brand" href="/" aria-label="Archymedes home">
          A
        </a>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <button type="button" className={page === n.id ? "is-on" : ""} aria-current={page === n.id ? "page" : undefined} onClick={() => nav.go(n.id)}>
                <span className="rail-idx">{n.idx}</span>
                <span className="rail-label">{n.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="main">
        <header className="top">
          <div className="top-co">
            <b>{info.data?.tenant.name ?? me.tenantName}</b>
            <span className="muted">{backend.kind === "browser" ? "Saved in this browser" : "Team workspace"}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setGuide(true)}>
            How it works
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="who" aria-label={`Signed in as ${me.name}, ${ROLE[me.role]}. Switch person`}>
              <span className="avatar" aria-hidden>
                {me.name
                  .split(" ")
                  .map((x) => x[0])
                  .join("")
                  .slice(0, 2)}
              </span>
              <span className="who-t">
                <b>{me.name}</b>
                <small>{ROLE[me.role]}</small>
              </span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                <DropdownMenu.Label className="menu-label">{backend.kind === "browser" ? "View as" : "Switch identity"}</DropdownMenu.Label>
                {team.map((i) => (
                  <DropdownMenu.Item key={i.id} className={`menu-item ${i.id === me.id ? "is-me" : ""}`} onSelect={() => onSwitch(i.id)}>
                    <b>{i.name}</b> <small>{ROLE[i.role]}</small>
                  </DropdownMenu.Item>
                ))}
                {others.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
                {others.map((i) => (
                  <DropdownMenu.Item key={i.id} className="menu-item" onSelect={() => onSwitch(i.id)}>
                    <b>{i.tenantName}</b> <small>{i.name}</small>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item" onSelect={onNewWorkspace}>
                  New workspace…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </header>
        <main id="main" className="page" key={page} tabIndex={-1}>
          {page === "today" && <TodayPage nav={nav} />}
          {page === "goals" && <GoalsPage />}
          {page === "decisions" && <DecisionsPage nav={nav} />}
          {page === "compass" && <CompassPage nav={nav} />}
          {page === "learning" && <LearningPage nav={nav} />}
          {page === "advantages" && <AdvantagesPage />}
          {page === "data" && <DataPage />}
          {page === "settings" && <SettingsPage onReset={onReset} onNewWorkspace={onNewWorkspace} />}
        </main>
      </div>
      {decision && <DecisionSheet id={decision} onClose={() => setDecision(null)} nav={nav} />}
      {task && <TaskSheet id={task} onClose={() => setTask(null)} nav={nav} />}
      <GuideSheet open={guide} onOpenChange={setGuide} />
    </div>
  );
}
