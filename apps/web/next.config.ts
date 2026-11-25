import type { NextConfig } from "next";

/** Static export: the Cloudflare Worker serves these files and the API on one origin. */
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  transpilePackages: ["@archymedes/engine"],
  images: { unoptimized: true },
  poweredByHeader: false,
};
export default config;
