# Archymedes OS

**Winning = Good decisions × Effective execution × Continuous learning.**

Archymedes OS helps any company make measurable progress on its goals:

1. **Good decisions — Orion.** Compare options, always including doing nothing, against one measurable goal, and record the forecast before acting. Orion recommends π* = argmax P(Win | π, E): the option most likely to meet the goal.
2. **Effective execution — Compass.** Every piece of work has an owner, done-when criteria, visible blockers and proof of delivery. Tasks are ranked by impact, confidence, lasting advantage, effort and urgency, with the reasons shown.
3. **Continuous learning.** Compare what happened with the forecast, keep the lesson, and record what the cycle left behind.

Each goal shows **P(Win | X)**, its chance of being met by the deadline. The workspace shows its **loop strength**, P(D) · P(A | D) · P(L | D, A), measured from its own history. The weakest link is flagged, because it limits the whole loop. **Advantage compounds**: each cycle can leave behind something valuable and hard to copy (customer trust, deeper integrations, better decision data), and the app tracks it.

Live at **https://os.archymedes.xyz**. No account is needed; the workspace runs and is saved in your browser.

## Repository

| Path | What |
| --- | --- |
| `packages/engine` | Pure TypeScript engine: Orion reference evaluator, the winning model, Compass, outcome measurement, calibration, templates, CSV import, the Enterprise API. No Node or browser dependencies. |
| `apps/web` | Next.js app (static export), Radix UI and hand-built SVG charts. Runs the engine in the browser. |
| `apps/api` | Cloudflare Worker: serves the app and the hosted API. Durable Object per workspace, R2 for documents, AuthKit sign-in, encrypted connector keys. Hosted accounts are built and tested but switched off (`NEXT_PUBLIC_HOSTED`). |

## Develop

```bash
bun install
bun run test          # engine, api and web unit tests
cd apps/web && bun run e2e   # Playwright journeys with axe accessibility checks
bun run build         # static web build into apps/web/out
bun run deploy        # build, then wrangler deploy (apps/api)
```

The engine's maths is pinned by property-based tests (`packages/engine/test/invariants.test.ts`) and by the worked example used as its calculator fixture (`evaluator.test.ts`).

## License

Apache-2.0.
