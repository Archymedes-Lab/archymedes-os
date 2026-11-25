import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { browserBackend, STATE_KEY, tenantSlices } from "@/lib/backend";
import { OsApp } from "@/components/Shell";
import { LoopDemo } from "@/components/LoopDemo";

const now = () => "2026-11-25T08:00:00.000Z";
function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
const input = { companyName: "Placeholder Co", businessModel: "services" as const, currency: "EUR", timezone: "UTC", fiscalYearStartMonth: 1, admin: { name: "Alex Admin", title: "" }, sampleData: true };

describe("loop demo", () => {
  it("multiplies the three factors and names the weakest", async () => {
    render(<LoopDemo />);
    expect(screen.getByText("19%")).toBeInTheDocument();
    expect(screen.getByText(/Weakest link:/)).toHaveTextContent("continuous learning");
  });
});

describe("onboarding", () => {
  it("requires a company and a name before creating", async () => {
    const user = userEvent.setup();
    render(<OsApp backend={browserBackend(memory(), now)} />);
    const create = await screen.findByRole("button", { name: "Create workspace" });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("Company"), "Placeholder Co");
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("Your name"), "Alex Admin");
    expect(create).toBeEnabled();
  });

  it("creates a workspace and lands on Today with the winning figures", async () => {
    const user = userEvent.setup();
    const store = memory();
    render(<OsApp backend={browserBackend(store, now)} />);
    await user.type(await screen.findByLabelText("Company"), "Placeholder Co");
    await user.type(screen.getByLabelText("Your name"), "Alex Admin");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("heading", { name: "Today", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /^Loop strength \d+%/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Next in Compass" })).toBeInTheDocument();
    expect(store.m.has(STATE_KEY)).toBe(true);
  });
});

describe("browser backend", () => {
  it("persists across reloads and exports only its own tenant", async () => {
    const store = memory();
    const a = browserBackend(store, now);
    await a.createWorkspace(input);
    await a.createWorkspace({ ...input, companyName: "Other Co", admin: { name: "Bo", title: "" } });
    const b = browserBackend(store, now);
    const s = await b.session();
    expect(s.identities.filter((i) => i.role === "admin").map((i) => i.tenantName).sort()).toEqual(["Other Co", "Placeholder Co"]);
    const exp = (await b.exportTenant())!;
    const tid = exp.slices.tenant.id;
    for (const [k, v] of Object.entries(exp.slices)) if (Array.isArray(v)) for (const x of v as { tenantId?: string }[]) expect(x.tenantId, k).toBe(tid);
    expect(exp.slices.members.find((m) => m.id === exp.adminMemberId)?.role).toBe("admin");
    const raw = JSON.parse(store.m.get(STATE_KEY)!);
    expect(tenantSlices(raw.state, tid).decisions.length).toBeGreaterThan(0);
  });
});

describe("Compass in the app", () => {
  it("adds a task from the Compass page and opens it", async () => {
    const user = userEvent.setup();
    const backend = browserBackend(memory(), now);
    await backend.createWorkspace(input);
    window.location.hash = "compass";
    render(<OsApp backend={backend} />);
    expect(await screen.findByRole("heading", { name: "Compass", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await user.type(within(dialog).getByRole("textbox", { name: "Task" }), "Call the top ten accounts");
    await user.click(within(dialog).getByRole("button", { name: "Add task" }));
    expect(await screen.findByRole("dialog", { name: /Call the top ten accounts/ })).toBeInTheDocument();
  });
});
