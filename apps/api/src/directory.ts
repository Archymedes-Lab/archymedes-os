import { randomToken } from "./auth";
import type { Kv } from "./store";

export interface Membership {
  workspaceId: string;
  memberId: string;
}

interface Invite {
  workspaceId: string;
  memberId: string;
  createdBy: string;
  expiresAt: string;
  usedBy: string | null;
}

const INVITE_DAYS = 14;

/** Who belongs to which workspace, and single-use invite codes. */
export class DirectoryCore {
  constructor(
    private readonly kv: Kv,
    private readonly now: () => string,
  ) {}

  private async read<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.kv.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  }

  async memberships(sub: string): Promise<Membership[]> {
    return this.read<Membership[]>(`u:${sub}`, []);
  }

  async addMembership(sub: string, m: Membership): Promise<void> {
    const list = await this.memberships(sub);
    if (list.some((x) => x.workspaceId === m.workspaceId)) throw new Error("You are already a member of this workspace.");
    await this.kv.put({ [`u:${sub}`]: JSON.stringify([...list, m]) });
  }

  async memberIn(sub: string, workspaceId: string): Promise<string | null> {
    return (await this.memberships(sub)).find((m) => m.workspaceId === workspaceId)?.memberId ?? null;
  }

  async lastUsed(sub: string): Promise<string | null> {
    return (await this.kv.get(`last:${sub}`)) ?? null;
  }

  async setLastUsed(sub: string, memberId: string): Promise<void> {
    await this.kv.put({ [`last:${sub}`]: memberId });
  }

  async createInvite(workspaceId: string, memberId: string, createdBy: string): Promise<string> {
    const code = randomToken(24);
    const inv: Invite = { workspaceId, memberId, createdBy, expiresAt: new Date(Date.parse(this.now()) + INVITE_DAYS * 86_400_000).toISOString(), usedBy: null };
    await this.kv.put({ [`i:${code}`]: JSON.stringify(inv) });
    return code;
  }

  async redeem(code: string, sub: string): Promise<Membership> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) throw new Error("This invite is invalid.");
    const inv = await this.read<Invite | null>(`i:${code}`, null);
    if (!inv) throw new Error("This invite is invalid.");
    if (inv.usedBy) throw new Error("This invite was already used.");
    if (Date.parse(inv.expiresAt) < Date.parse(this.now())) throw new Error("This invite has expired.");
    await this.addMembership(sub, { workspaceId: inv.workspaceId, memberId: inv.memberId });
    inv.usedBy = sub;
    await this.kv.put({ [`i:${code}`]: JSON.stringify(inv) });
    return { workspaceId: inv.workspaceId, memberId: inv.memberId };
  }
}
