import { LooksSkeleton } from "@/components/looks/LooksSkeleton";

/**
 * The loading state for /looks, wired to the route so it shows while the server
 * resolves the session. Static Basalt skeletons in the shape of a look, no
 * shimmer, no spinner (docs/02-design-system.md, SkeletonRow).
 */
export default function LooksLoading() {
  return <LooksSkeleton />;
}
