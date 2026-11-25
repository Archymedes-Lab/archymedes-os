"use client";

import { RadioGroup } from "radix-ui";
import { useState } from "react";
import type { BusinessModel } from "@archymedes/engine/api-types";
import { BUSINESS_TEMPLATES } from "@archymedes/engine/templates";
import type { WorkspaceInput } from "@archymedes/engine/templates";
import { Button, ErrorLine, Field } from "./ui";

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "INR", "SGD", "HKD", "BRL", "MXN", "ZAR", "NGN", "KES", "AED"];

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** One screen: who you are and how you make money. Everything else has defaults you can change later. */
export function Onboarding({ onCreate, onCancel }: { onCreate(input: WorkspaceInput): Promise<void>; onCancel?: () => void }) {
  const [company, setCompany] = useState("");
  const [model, setModel] = useState<BusinessModel>("subscription");
  const [currency, setCurrency] = useState("USD");
  const [name, setName] = useState("");
  const [start, setStart] = useState<"empty" | "sample">("sample");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = company.trim() && name.trim();
  return (
    <div className="ob">
      <header className="ob-head">
        <a href="/" className="brand" aria-label="Archymedes home">
          A
        </a>
        <span className="muted">Archymedes OS</span>
      </header>
      <main className="ob-main" id="main">
        <h1>Set up your workspace</h1>
        <p className="ob-lede">Two minutes. No account. Your workspace is saved in this browser.</p>
        <form
          className="ob-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ready) return;
            setBusy(true);
            setError(null);
            try {
              await onCreate({ companyName: company.trim(), businessModel: model, currency, timezone: localTimezone(), fiscalYearStartMonth: 1, admin: { name: name.trim(), title: "" }, sampleData: start === "sample" });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          <div className="ob-row">
            <Field label="Company" htmlFor="ob-company">
              <input id="ob-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name" autoComplete="organization" />
            </Field>
            <Field label="Your name" htmlFor="ob-name">
              <input id="ob-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoComplete="name" />
            </Field>
            <Field label="Currency" htmlFor="ob-currency">
              <select id="ob-currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset className="ob-set">
            <legend>How you make money</legend>
            <RadioGroup.Root className="cards" value={model} onValueChange={(v) => setModel(v as BusinessModel)} aria-label="Business model">
              {BUSINESS_TEMPLATES.map((t) => (
                <RadioGroup.Item key={t.model} value={t.model} className="card-opt" aria-label={t.label}>
                  <b>{t.label}</b>
                  <span>{t.description}</span>
                  <small>Goal · {t.objectiveName}</small>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </fieldset>
          <fieldset className="ob-set">
            <legend>Start with</legend>
            <RadioGroup.Root className="cards cards-2" value={start} onValueChange={(v) => setStart(v as "empty" | "sample")} aria-label="Start with">
              <RadioGroup.Item value="sample" className="card-opt" aria-label="Sample data">
                <b>Sample data</b>
                <span>Six months of records, a sample team, decisions and tasks in every stage.</span>
              </RadioGroup.Item>
              <RadioGroup.Item value="empty" className="card-opt" aria-label="An empty workspace">
                <b>An empty workspace</b>
                <span>Bring your own CSV. A short checklist takes you through the first cycle.</span>
              </RadioGroup.Item>
            </RadioGroup.Root>
          </fieldset>
          <ErrorLine error={error} />
          <div className="actions">
            <Button variant="primary" type="submit" disabled={!ready || busy}>
              Create workspace
            </Button>
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
