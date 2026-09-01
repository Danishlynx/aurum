import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Linting is a separate gate (npm run lint) so a build failure always means a build problem.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  /*
   * Product thumbnails only, per docs/03-architecture.md "Deployment": image
   * optimization is used for product thumbnails and renders, not for the
   * person's own face, which is rendered from the bytes the browser already has
   * or from a short lived signed URL.
   *
   * The same list, with the same wildcards, lives in
   * src/components/ui/remote-image.ts so a card can tell whether a listing
   * thumbnail will render before it asks for it. A test fails when they drift.
   */
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "serpapi.com" },
      { protocol: "https", hostname: "**.serpapi.com" },
      { protocol: "https", hostname: "**.gstatic.com" },
      { protocol: "https", hostname: "**.googleusercontent.com" },
      { protocol: "https", hostname: "**.ggpht.com" },
    ],
  },
};

export default nextConfig;
