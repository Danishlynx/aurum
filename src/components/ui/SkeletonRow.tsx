/**
 * SkeletonRow, per docs/02-design-system.md: the exact shape of the content it
 * replaces, in Basalt, static. No shimmer, no pulse, no spinner.
 */

type SkeletonRowProps = {
  /** How many bars to draw, one per line of the content being replaced. */
  readonly lines?: number;
  /** Bar height in pixels, matched to the line height of the real content. */
  readonly height?: number;
  /**
   * Width of the last bar as a percentage, so a paragraph skeleton ends short
   * the way a paragraph does.
   */
  readonly lastLineWidth?: number;
};

export function SkeletonRow({
  lines = 1,
  height = 16,
  lastLineWidth = 62,
}: SkeletonRowProps) {
  const bars = Array.from({ length: Math.max(1, lines) }, (_, index) => index);

  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      {bars.map((index) => (
        <div
          key={index}
          className="rounded-sm bg-surface"
          style={{
            height: `${height}px`,
            width:
              index === bars.length - 1 && bars.length > 1
                ? `${lastLineWidth}%`
                : "100%",
          }}
        />
      ))}
    </div>
  );
}
