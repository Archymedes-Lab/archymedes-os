"use client";

import { Slider } from "radix-ui";
import { useState } from "react";

const FACTORS = [
  { key: "d", label: "Good decisions", sym: "P(D)" },
  { key: "a", label: "Effective execution", sym: "P(A | D)" },
  { key: "l", label: "Continuous learning", sym: "P(L | D, A)" },
] as const;

/** Drag any factor: the product never exceeds the weakest one. */
export function LoopDemo() {
  const [v, setV] = useState({ d: 80, a: 80, l: 30 });
  const product = (v.d / 100) * (v.a / 100) * (v.l / 100);
  const weakest = FACTORS.reduce((a, b) => (v[b.key] < v[a.key] ? b : a));
  return (
    <div className="demo">
      {FACTORS.map((f, i) => (
        <div key={f.key} className="demo-row">
          <span className="demo-label">
            {f.label} <span className="muted">{f.sym}</span>
          </span>
          <Slider.Root className="slider" value={[v[f.key]]} min={0} max={100} step={1} onValueChange={([x]) => setV({ ...v, [f.key]: x })} aria-label={f.label}>
            <Slider.Track className="slider-track">
              <Slider.Range className="slider-range" />
            </Slider.Track>
            <Slider.Thumb className="slider-thumb" aria-label={f.label} />
          </Slider.Root>
          <span className="demo-v">{v[f.key]}%</span>
          {i < 2 && (
            <span className="demo-op" aria-hidden>
              ×
            </span>
          )}
        </div>
      ))}
      <div className="demo-total">
        <span>Winning</span>
        <b aria-live="polite">{Math.round(product * 100)}%</b>
      </div>
      <p className="demo-note">
        Weakest link: <b>{weakest.label.toLowerCase()}</b>. Raising it lifts the whole loop most.
      </p>
    </div>
  );
}
