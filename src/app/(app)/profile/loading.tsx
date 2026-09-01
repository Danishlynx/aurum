import { ProfileSkeleton } from "@/components/profile/ProfileSkeleton";

/**
 * The loading state for /profile, wired to the route so it shows while the
 * server resolves the session. Static Basalt skeletons in the shape of the rows,
 * no shimmer, no spinner (docs/02-design-system.md, SkeletonRow).
 */
export default function ProfileLoading() {
  return <ProfileSkeleton />;
}
