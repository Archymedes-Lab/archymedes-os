import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const SHOTS = "e2e-results/shots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

async function onboard(page: Page, opts: { company?: string; empty?: boolean } = {}) {
  await page.goto("/app/");
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  await page.getByLabel("Company").fill(opts.company ?? "Placeholder Co");
  await page.getByLabel("Your name").fill("Alex Admin");
  if (opts.empty) await page.getByRole("radio", { name: "An empty workspace" }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
}

async function viewAs(page: Page, name: string) {
  await page.getByRole("button", { name: /^Signed in as/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^Signed in as ${name}`) })).toBeVisible();
}

async function go(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("heading", { name: label, level: 1 })).toBeVisible();
}

test("landing explains the product and the live formula", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Make measurable progress on your goals.");
  await expect(page.getByRole("heading", { name: /Winning = Good decisions × Effective execution × Continuous learning/ })).toBeVisible();
  const total = page.locator(".demo-total b");
  await expect(total).toHaveText("19%"); // 80% × 80% × 30%
  const learning = page.getByRole("slider", { name: "Continuous learning" });
  await learning.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await expect(total).toHaveText("26%"); // 80 × 80 × 40
  await shot(page, "00-landing");
  await axe(page, "landing");
  await page.getByRole("link", { name: "Start now" }).first().click();
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
});

test("a company starts with sample data and sees its chance of winning and its weakest link", async ({ page }) => {
  await onboard(page);
  await expect(page.getByText("Placeholder Co")).toBeVisible();
  await expect(page.locator(".win-p").first()).toHaveText(/^\d{1,3}%$/);
  await expect(page.getByRole("img", { name: /^Loop strength \d+%/ })).toBeVisible();
  await expect(page.getByText(/^Weakest link:/)).toBeVisible();
  await shot(page, "01-today");
  await axe(page, "today");
  for (const p of ["Goals", "Decisions", "Compass", "Learning", "Advantages", "Data", "Settings"]) {
    await go(page, p);
    await shot(page, `02-${p.toLowerCase()}`);
    await axe(page, p);
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});

test("an independent executive approves a decision and Compass gets the work", async ({ page }) => {
  await onboard(page);
  await viewAs(page, "Morgan Ellis");
  await go(page, "Decisions");
  await page.getByRole("region", { name: "Awaiting approval" }).getByRole("button").first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/Orion recommends/)).toBeVisible();
  await expect(sheet.getByRole("list", { name: "Chance the goal is met, by option" })).toBeVisible();
  await shot(page, "03-decision");
  await axe(page, "decision sheet");
  await sheet.getByRole("button", { name: "Approve" }).click();
  await sheet.getByLabel("Reason").fill("Within our risk limits.");
  await sheet.getByRole("button", { name: "Confirm approval" }).click();
  await expect(sheet.getByTestId("lifecycle-current")).toContainText("In progress");
  await page.keyboard.press("Escape");
  await go(page, "Compass");
  await expect(page.getByRole("list", { name: "Tasks" }).getByText("From an approved decision").first()).toBeVisible();
});

test("Compass: create, block, unblock, finish with proof, debrief, and the advantage is recorded", async ({ page }) => {
  await onboard(page);
  await go(page, "Compass");
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("textbox", { name: "Task" }).fill("Write the pricing FAQ");
  await page.getByLabel("Done when (one per line)").fill("FAQ published\nLinked from pricing page");
  await page.getByRole("button", { name: "Add task" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: /Write the pricing FAQ/ })).toBeVisible();
  await sheet.getByLabel("New blocker").fill("Waiting on legal review");
  await sheet.getByRole("button", { name: "Add blocker" }).click();
  await expect(sheet.getByText("Blocked").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Resolve" }).click();
  await sheet.getByLabel("Proof of delivery").fill("Live at /pricing#faq");
  await sheet.getByRole("button", { name: "Mark done" }).click();
  await sheet.getByRole("combobox", { name: "Actual impact" }).click();
  await page.getByRole("option", { name: "4 — large" }).click();
  await sheet.getByLabel("Lesson for next time").fill("Legal review first saves a week.");
  await sheet.getByLabel("What it left behind (optional)").fill("Pricing FAQ that answers sales objections");
  await sheet.getByRole("button", { name: "Save debrief" }).click();
  await expect(sheet.getByText("4 — large")).toBeVisible();
  await shot(page, "04-task-debrief");
  await page.keyboard.press("Escape");
  await go(page, "Advantages");
  await expect(page.getByText("Pricing FAQ that answers sales objections")).toBeVisible();
});

test("Data: a CSV is mapped automatically, previewed, and imported once; documents upload and download", async ({ page }) => {
  await onboard(page, { empty: true });
  await go(page, "Data");
  await page.getByRole("button", { name: "Upload CSV" }).first().click();
  await page.getByLabel("CSV file").setInputFiles({ name: "billing.csv", mimeType: "text/csv", buffer: Buffer.from("Invoice Number,Date Paid,Amount Paid\nB-1,2026-11-20,100.00\nB-1,2026-11-20,100.00\nB-2,not a date,5\nB-3,2026-11-21,40.50\n") });
  await expect(page.getByRole("combobox", { name: "Amount column" })).toContainText("Amount Paid");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("list", { name: "Rows that will be skipped" })).toContainText("Line 3");
  await shot(page, "05-csv-preview");
  await page.getByRole("button", { name: /^Import 2 rows$/ }).click();
  await expect(page.getByRole("status")).toContainText("Imported 2 rows");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("button", { name: /^Import 0 rows$/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByLabel("Upload documents").setInputFiles({ name: "board-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Board notes: focus on retention this quarter.") });
  await expect(page.getByText("board-notes.txt")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).first().click()]);
  expect(download.suggestedFilename()).toBe("board-notes.txt");
});

test("an empty workspace walks the company through its first cycle", async ({ page }) => {
  await onboard(page, { empty: true });
  const cycle = page.getByRole("region", { name: "Your first cycle" });
  await expect(cycle.getByRole("listitem")).toHaveCount(7);
  await expect(cycle).toContainText("Connect your data");
  await go(page, "Compass");
  await expect(page.getByRole("list", { name: "Tasks" }).getByRole("listitem")).toHaveCount(4);
  await go(page, "Goals");
  await expect(page.getByText(/Needs .*data/)).toBeVisible();
  await shot(page, "06-empty-goals");
});

test("@mobile the landing page and Today fit a phone without sideways scrolling", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await onboard(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await shot(page, "07-mobile-today");
});
