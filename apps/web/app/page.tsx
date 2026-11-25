import { LoopDemo } from "@/components/LoopDemo";

const STEPS = [
  { n: "01", tool: "Orion", title: "Good decisions", body: "Compare options — always including doing nothing — against one measurable goal. Record what you expect before you act." },
  { n: "02", tool: "Compass", title: "Effective execution", body: "Every piece of work gets an owner, done-when criteria and a date. Blockers are visible. Delivery is proved, not claimed." },
  { n: "03", tool: "Learning", title: "Continuous learning", body: "Compare what happened with the forecast. Keep the lesson. The next decision starts smarter." },
];

export default function Home() {
  return (
    <div className="lp">
      <header className="lp-top">
        <a href="/" className="brand" aria-label="Archymedes home">
          A
        </a>
        <span className="lp-name">Archymedes OS</span>
        <nav aria-label="Sections" className="lp-nav">
          <a href="#loop">How it works</a>
          <a href="#math">The math</a>
          <a href="#moat">Advantage</a>
        </nav>
        <a className="btn btn-primary btn-md" href="/app/">
          Start now
        </a>
      </header>

      <main id="main">
        <section className="lp-hero" aria-labelledby="h">
          <p className="lp-kicker">For any company with a goal</p>
          <h1 id="h">Make measurable progress on your goals.</h1>
          <p className="lp-lede">Decide with Orion. Execute with Compass. Learn from every result. Free, no account — your workspace stays in your browser.</p>
          <div className="lp-cta">
            <a className="btn btn-primary btn-lg" href="/app/">
              Start now
            </a>
            <a className="btn btn-ghost btn-lg" href="#loop">
              How it works
            </a>
          </div>
        </section>

        <section className="lp-formula" id="loop" aria-labelledby="f">
          <h2 id="f" className="lp-eq">
            Winning <span>=</span> Good decisions <span>×</span> Effective execution <span>×</span> Continuous learning
          </h2>
          <div className="lp-split">
            <p className="lp-big">The multiplication is the point. A weak link limits the whole loop — so the app measures all three and shows you which one to fix.</p>
            <LoopDemo />
          </div>
        </section>

        <section className="lp-steps" aria-label="The loop">
          {STEPS.map((s) => (
            <article key={s.n}>
              <span className="lp-n">{s.n}</span>
              <span className="lp-tool">{s.tool}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </section>

        <section className="lp-math" id="math" aria-labelledby="m">
          <h2 id="m">The math</h2>
          <div className="lp-math-grid">
            <div>
              <p className="eq">
                P(Win | X) = f(x<sub>1</sub>, …, x<sub>n</sub>)
              </p>
              <p>Win is a measurable outcome by a deadline. X is everything that influences it. Each goal shows this chance, live.</p>
            </div>
            <div>
              <p className="eq">
                π* = argmax<sub>π ∈ Π</sub> P(Win | π, E)
              </p>
              <p>Orion recommends the option most likely to meet the goal, given the evidence — doing nothing included.</p>
            </div>
            <div>
              <p className="eq">P(D ∩ A ∩ L) = P(D) · P(A | D) · P(L | D, A)</p>
              <p>Loop strength, measured from your own history: decided well, then delivered, then learned from.</p>
            </div>
          </div>
        </section>

        <section className="lp-moat" id="moat" aria-labelledby="a">
          <h2 id="a">Advantage compounds.</h2>
          <p className="lp-big">Each cycle should leave something behind that is valuable and hard to copy: customer trust, a deeper integration, better decision data. The app asks for it, tracks it, and ranks work that builds it higher.</p>
          <ul className="lp-kinds">
            <li>Customer trust</li>
            <li>Deeper integrations</li>
            <li>Better decision data</li>
            <li>Repeatable process</li>
            <li>Proprietary data</li>
          </ul>
        </section>

        <section className="lp-bring" aria-labelledby="b">
          <h2 id="b">Bring what you have</h2>
          <ul className="lp-list">
            <li>
              <b>CSV</b> Billing, CRM, orders, accounting. Columns matched automatically.
            </li>
            <li>
              <b>Google Sheets</b> Any published sheet or CSV link, synced on demand.
            </li>
            <li>
              <b>Documents</b> Board packs, plans, research — attached to goals, decisions and tasks.
            </li>
            <li>
              <b>Stripe</b> Paid invoices, with team workspaces.
            </li>
          </ul>
        </section>

        <section className="lp-end" aria-labelledby="e">
          <h2 id="e">Start your first cycle in two minutes.</h2>
          <a className="btn btn-primary btn-lg" href="/app/">
            Start now
          </a>
        </section>
      </main>
      <footer className="lp-foot">
        <span>Archymedes OS · open source, Apache-2.0</span>
        <a href="https://github.com/Archymedes-Lab/archymedes-os">Source</a>
      </footer>
    </div>
  );
}
