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
  /*
   * The landing hero asks the file system whether the consented fixture face is
   * in the repository (src/components/landing/fixture-face.ts). Every route in
   * this app is server rendered on demand, so that question is asked inside the
   * serverless function, and files under public/ are served from the CDN rather
   * than bundled into the function by default. This line puts that one file in
   * the function's trace, so the answer is the same in production as it is
   * locally. The pattern matching nothing (which is the state today) is not an
   * error.
   */
  outputFileTracingIncludes: {
    "/": ["./public/fixtures/landing-face.jpg"],
  },
};

export default nextConfig;
