import "server-only";

import { isDemoFixtureMode } from "../profile/report-view";
import type { AppSession } from "../session";
import { getLook, updateLook } from "./db";

/**
 * "Save this look", docs/01-user-flow.md section K item 4.
 *
 * A composed look is already a row by the time the screen shows it
 * (src/lib/server/looks/compose.ts), so saving is one flag: is_saved on the
 * looks table, which migration 0003 already carries. Nothing about the look
 * itself moves, so a saved look keeps the pieces and the rationale it was saved
 * under even after the wardrobe changes.
 *
 * The row is read first and by owner id, so an id that is not this person's is
 * "not found" rather than a write nobody was allowed to make.
 */

export type SaveLookOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "fixture_read_only";
    };

export async function saveLook(args: {
  readonly session: AppSession;
  readonly lookId: string;
}): Promise<SaveLookOutcome> {
  if (isDemoFixtureMode()) {
    // The fixture is checked in and there is no database behind it. Saying so is
    // the honest answer; writing to nothing and reporting success is not.
    return { ok: false, reason: "fixture_read_only" };
  }

  const existing = await getLook(args.session.id, args.lookId);
  if (existing === null) {
    return { ok: false, reason: "not_found" };
  }

  if (!existing.is_saved) {
    await updateLook(args.session.id, args.lookId, { is_saved: true });
  }

  console.log(
    JSON.stringify({
      event: "aurum.look_saved",
      ownerType: args.session.ownerType,
      ownerId: args.session.id,
      lookId: args.lookId,
      occasion: existing.occasion,
    }),
  );

  return { ok: true };
}
