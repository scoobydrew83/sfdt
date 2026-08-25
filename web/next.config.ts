import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do NOT set output: 'export'. This app needs Edge routes (banners, D1 later).
  // sfdt-site stays static; this workspace is the Worker-backed surface.
  transpilePackages: ["@sfdt/flow-core"],
};

export default nextConfig;
