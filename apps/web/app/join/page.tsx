"use client";

import { useEffect, useState } from "react";
import { HOSTED } from "@/lib/backend";

export default function JoinPage() {
  const [msg, setMsg] = useState(HOSTED ? "Joining…" : "Team invites open when team workspaces are switched on.");
  useEffect(() => {
    if (!HOSTED) return;
    const code = new URLSearchParams(window.location.search).get("code") ?? "";
    void (async () => {
      const me = await fetch("/api/me", { credentials: "same-origin" });
      if (me.status === 401) {
        window.location.href = `/auth/login?return=${encodeURIComponent(`/join/?code=${code}`)}`;
        return;
      }
      const r = await fetch(`/api/invites/${encodeURIComponent(code)}/accept`, { method: "POST", credentials: "same-origin", headers: { "X-Archymedes": "1", "Content-Type": "application/json" }, body: "{}" });
      if (r.ok) window.location.href = "/app/";
      else setMsg(((await r.json()) as { error?: { message: string } }).error?.message ?? "This invite could not be used.");
    })();
  }, []);
  return (
    <main className="ob" id="main">
      <div className="ob-main">
        <h1>Join a workspace</h1>
        <p className="ob-lede" role="status">
          {msg}
        </p>
        <a className="btn btn-secondary btn-md" href="/">
          Home
        </a>
      </div>
    </main>
  );
}
