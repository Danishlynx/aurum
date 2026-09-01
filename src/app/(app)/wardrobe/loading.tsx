import { WardrobeSkeleton } from "@/components/wardrobe/WardrobeSkeleton";

/**
 * The loading state for /wardrobe, wired to the route so it shows while the
 * server builds the view. Static Basalt skeletons in the shape of the grid, no
 * shimmer, no spinner (docs/02-design-system.md, SkeletonRow).
 */
export default function WardrobeLoading() {
  return <WardrobeSkeleton />;
}
