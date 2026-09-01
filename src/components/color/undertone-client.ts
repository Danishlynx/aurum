/**
 * The browser side of POST /api/profile/undertone, the one route /color calls.
 *
 * It lives beside the screen rather than in src/lib/client/api.ts because no
 * other screen posts an undertone. The rules are the same ones api.ts sets: the
 * response is parsed with zod before it reaches a component, and the sentence a
 * person sees is chosen from copy.ts by the caller, never taken from the body.
 *
 * docs/01-user-flow.md section G item 2: choosing an undertone updates the
 * profile and re derives the palette. The screen asks the server to re render
 * afterwards, so the palette below the swatch is the newly derived one and never
 * a guess made in the browser.
 */

import { z } from "zod";

import type { Undertone } from "@/lib/shared/palette";

/**
 * The documented answer, UndertoneUpdateResponse in src/lib/shared/color-view.ts:
 * the new season and whether a palette was derived for it. season is null when
 * the photo gave no skin tone, which is a stored undertone with no palette
 * behind it, not a failure. Only the shape is checked here. Nothing in it is
 * rendered: the screen re reads the whole ColorView from the server instead.
 */
const undertoneResponseSchema = z.object({
  season: z.string().min(1).nullable(),
  paletteChanged: z.boolean(),
});

export type UndertoneSaved = z.infer<typeof undertoneResponseSchema>;

export type UndertoneSaveResult =
  | { readonly ok: true; readonly data: UndertoneSaved }
  | { readonly ok: false };

export async function saveUndertone(
  undertone: Undertone,
): Promise<UndertoneSaveResult> {
  let response: Response;
  try {
    response = await fetch("/api/profile/undertone", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ undertone }),
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    return { ok: false };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false };
  }

  const parsed = undertoneResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}
