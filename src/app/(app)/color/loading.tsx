import { ColorSkeleton } from "@/components/color/ColorSkeleton";

/**
 * The loading state for /color, wired to the route so it shows while the server
 * derives the palette. Static Basalt skeletons, no shimmer, no spinner
 * (docs/02-design-system.md, SkeletonRow).
 */
export default function ColorLoading() {
  return <ColorSkeleton />;
}
