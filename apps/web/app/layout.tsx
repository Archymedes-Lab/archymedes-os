import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Archymedes OS — make measurable progress on your goals",
  description: "Decide with Orion, execute with Compass, learn from every result. Winning = Good decisions × Effective execution × Continuous learning.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f5f5f2" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
