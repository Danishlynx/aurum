import { HairSkeleton } from "@/components/hair/HairSkeleton";

/**
 * The loading state for /hair, wired to the route so it shows while the server
 * builds the view. Static Basalt skeletons, no shimmer, no spinner over a face
 * (docs/02-design-system.md, SkeletonRow).
 */
export default function HairLoading() {
  return <HairSkeleton />;
}
