"use client";

import dynamic from "next/dynamic";

// The engine runs in the browser and reads local storage, so the app renders on the client only.
const OsApp = dynamic(() => import("@/components/Shell").then((m) => m.OsApp), { ssr: false, loading: () => <div className="boot" aria-busy="true" /> });

export default function AppPage() {
  return <OsApp />;
}
