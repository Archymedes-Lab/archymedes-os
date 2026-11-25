"use client";

import { Dialog, Progress as RProgress, Select as RSelect, ToggleGroup, Tooltip } from "radix-ui";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Tone } from "@/lib/client";

/** Page title in the Swiss manner: index, title, one line of purpose, actions. */
export function PageHead({ index, title, lede, actions }: { index: string; title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ph">
      <span className="ph-idx" aria-hidden>
        {index}
      </span>
      <div className="ph-main">
        <h1>{title}</h1>
        {lede && <p className="ph-lede">{lede}</p>}
      </div>
      {actions && <div className="ph-actions">{actions}</div>}
    </header>
  );
}

export function Section({ title, id, aside, children, className = "" }: { title: string; id?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  const hid = id ?? `s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={`sec ${className}`} aria-labelledby={hid}>
      <div className="sec-head">
        <h2 id={hid}>{title}</h2>
        {aside && <div className="sec-aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Button({ variant = "secondary", size = "md", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest} />;
}

/** A status label: always a glyph plus words, never color alone. */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  const glyph = { neutral: "○", good: "✓", warn: "!", bad: "×", accent: "●" }[tone];
  return (
    <span className={`chip chip-${tone}`} title={title}>
      <span aria-hidden className="chip-g">
        {glyph}
      </span>
      {children}
    </span>
  );
}

/** Explains a figure in one sentence on hover or focus. */
export function Explain({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={200}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" sideOffset={6} collisionPadding={12}>
          {text}
          <Tooltip.Arrow className="tip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Figure({ label, value, sub, explain, size = "m" }: { label: string; value: ReactNode; sub?: ReactNode; explain?: string; size?: "s" | "m" | "l" | "xl" }) {
  return (
    <div className="fig">
      <span className="fig-label">
        {label}
        {explain && (
          <Explain text={explain}>
            <button type="button" className="fig-q" aria-label={`What is ${label.toLowerCase()}?`}>
              ?
            </button>
          </Explain>
        )}
      </span>
      <span className={`fig-v fig-${size}`}>{value}</span>
      {sub && <span className="fig-sub">{sub}</span>}
    </div>
  );
}

/** Right-hand sliding panel (Radix Dialog). */
export function Sheet({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange(open: boolean): void; title: string; description?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className={`sheet ${wide ? "sheet-wide" : ""}`} aria-describedby={description ? undefined : undefined}>
          <div className="sheet-head">
            <div>
              <Dialog.Title className="sheet-title">{title}</Dialog.Title>
              {description ? <Dialog.Description className="sheet-desc">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
            <Dialog.Close className="btn btn-ghost btn-sm" aria-label="Close">
              Close
            </Dialog.Close>
          </div>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Select({ value, onValueChange, options, label, id, placeholder }: { value: string; onValueChange(v: string): void; options: { value: string; label: string }[]; label: string; id?: string; placeholder?: string }) {
  return (
    <RSelect.Root value={value || undefined} onValueChange={onValueChange}>
      <RSelect.Trigger className="select" aria-label={label} id={id}>
        <RSelect.Value placeholder={placeholder ?? "Choose…"} />
        <RSelect.Icon className="select-icon" aria-hidden>
          ▾
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="select-menu" position="popper" sideOffset={4}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="select-item">
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/** A single-choice filter bar (Radix ToggleGroup): filters, not tab panels. */
export function Tabs({ value, onValueChange, items, label }: { value: string; onValueChange(v: string): void; items: { value: string; label: string; count?: number }[]; label: string }) {
  return (
    <ToggleGroup.Root type="single" className="tabs" aria-label={label} value={value} onValueChange={(v) => v && onValueChange(v)}>
      {items.map((i) => (
        <ToggleGroup.Item key={i.value} value={i.value} className="tab" aria-label={i.count !== undefined ? `${i.label}, ${i.count}` : i.label}>
          {i.label}
          {i.count !== undefined && <span className="tab-n">{i.count}</span>}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <RProgress.Root className="progress" value={Math.round(value * 100)} aria-label={label}>
      <RProgress.Indicator className="progress-bar" style={{ transform: `translateX(-${100 - Math.round(value * 100)}%)` }} />
    </RProgress.Root>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
