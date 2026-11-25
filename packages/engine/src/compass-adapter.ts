import type { CompassTask, EnterpriseState, Task } from "./api-types";

export interface CreateTaskInput {
  projectId: string;
  actionId: string;
  title: string;
  doneWhen: string[];
  assignee: string;
  decisionId?: string;
  goalId?: string | null;
  workId?: string;
  dueAt?: string | null;
}

/**
 * The Compass work boundary (spec §3). Tasks carry the external action ID so a
 * timed-out write is reconciled before any retry. Compass runs inside the
 * workspace by default; a remote Compass can implement the same interface.
 */
export interface CompassAdapter {
  readonly kind: "built_in" | "remote";
  findTaskByActionId(workspace: string, actionId: string): Promise<CompassTask | null>;
  createTask(workspace: string, input: CreateTaskInput): Promise<CompassTask>;
  listTasks(workspace: string): Promise<CompassTask[]>;
}

export class CompassTimeout extends Error {
  constructor() {
    super("Compass did not answer in time");
  }
}

const toCompass = (t: Task, workspace: string): CompassTask => ({
  id: t.key,
  workspace,
  projectId: "default",
  actionId: t.actionId ?? "",
  title: t.title,
  doneWhen: t.doneWhen,
  assignee: t.ownerId ?? "",
  status: t.status === "done" ? "done" : t.status === "todo" ? "todo" : "doing",
  createdAt: t.createdAt,
});

/** Next Compass key for a tenant: CMP-0001, CMP-0002, … */
export function nextTaskKey(state: EnterpriseState, tenantId: string): string {
  const max = (state.tasks ?? []).filter((t) => t.tenantId === tenantId).reduce((m, t) => Math.max(m, Number(t.key.slice(4)) || 0), 0);
  return `CMP-${String(max + 1).padStart(4, "0")}`;
}

/** Compass inside the workspace: decision work becomes ordinary Compass tasks in the same store. */
export class BuiltInCompass implements CompassAdapter {
  readonly kind = "built_in" as const;
  private failure: "timeout_after_write" | "timeout_before_write" | null = null;
  private n = 0;

  constructor(
    private readonly state: () => EnterpriseState,
    private readonly now: () => string,
  ) {}

  /** Fault injection for tests: the next create times out, before or after it lands. */
  failNext(kind: "timeout_after_write" | "timeout_before_write"): void {
    this.failure = kind;
  }

  private tenantOf(workspace: string) {
    return this.state().tenants.find((t) => (t.compassWorkspace ?? t.workspaceId) === workspace);
  }

  private tasks(): Task[] {
    const st = this.state();
    st.tasks ??= [];
    return st.tasks;
  }

  taskCount(workspace: string): number {
    const t = this.tenantOf(workspace);
    return t ? this.tasks().filter((x) => x.tenantId === t.id && x.actionId).length : 0;
  }

  async findTaskByActionId(workspace: string, actionId: string): Promise<CompassTask | null> {
    const t = this.tenantOf(workspace);
    const task = t && this.tasks().find((x) => x.tenantId === t.id && x.actionId === actionId);
    return task ? toCompass(task, workspace) : null;
  }

  async listTasks(workspace: string): Promise<CompassTask[]> {
    const t = this.tenantOf(workspace);
    return t ? this.tasks().filter((x) => x.tenantId === t.id).map((x) => toCompass(x, workspace)) : [];
  }

  async createTask(workspace: string, input: CreateTaskInput): Promise<CompassTask> {
    const failure = this.failure;
    this.failure = null;
    if (failure === "timeout_before_write") throw new CompassTimeout();
    const tenant = this.tenantOf(workspace);
    if (!tenant) throw new Error("No such Compass workspace.");
    let task = this.tasks().find((x) => x.tenantId === tenant.id && x.actionId === input.actionId);
    if (!task) {
      const now = this.now();
      task = {
        id: `task-${Date.parse(now).toString(36)}-${(++this.n).toString(36)}`,
        key: nextTaskKey(this.state(), tenant.id),
        tenantId: tenant.id,
        title: input.title,
        description: "",
        status: "doing",
        ownerId: input.assignee || null,
        createdBy: "system",
        doneWhen: input.doneWhen,
        dueAt: input.dueAt ?? null,
        goalId: input.goalId ?? null,
        decisionId: input.decisionId ?? null,
        workId: input.workId ?? null,
        actionId: input.actionId,
        impact: 4,
        confidence: 0.6,
        effortDays: 5,
        moat: null,
        blockers: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: null,
        evidenceNote: null,
        debrief: null,
        revision: 1,
      };
      this.tasks().push(task);
    }
    if (failure === "timeout_after_write") throw new CompassTimeout();
    return toCompass(task, workspace);
  }
}
