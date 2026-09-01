/**
 * The face shape line, docs/01-user-flow.md section I item 1: "Your face shape
 * reads as oval. Most lengths and partings suit you; the styles below add
 * structure at the jaw." One sentence, specific.
 *
 * docs/02-design-system.md, ReadingBlock: Cormorant 19/30 in Ivory on the
 * canvas, no box, no border.
 *
 * The sentence is written by the rules on the server, which own the face shape,
 * the hair type, and the case where neither came back. This renders what it is
 * given and decides nothing, so there is one place the line can be wrong. An
 * empty line draws nothing rather than an empty paragraph.
 */

type FaceShapeLineProps = {
  readonly line: string;
};

export function FaceShapeLine({ line }: FaceShapeLineProps) {
  if (line.length === 0) {
    return null;
  }

  return (
    <p className="max-w-[64ch] font-display text-reading text-text">{line}</p>
  );
}
