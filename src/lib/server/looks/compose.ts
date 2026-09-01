import "server-only";

import {
  composeCandidates,
  type Candidate,
  type Occasion,
} from "@/lib/shared/looks";
import type {
  LookGap,
  LookItem,
  LookRenderStatus,
  LookView,
  LooksView,
} from "@/lib/shared/looks-view";
import type { Palette } from "@/lib/shared/palette";
import type { GarmentView } from "@/lib/shared/wardrobe-view";

import { BUCKETS, createSignedRead } from "../db/storage";
import type { Insert, JobStatus, Look, Render } from "../db/types";
import { paletteForProfile } from "../profile/color";
import { getAestheticProfile } from "../profile/db";
import { DEMO_FIXTURE_ENV, isDemoFixtureMode } from "../profile/report-view";
import { demoFixtureLooksView } from "../profile/demo-fixture-looks";
import { clothCategoryForType } from "../renders/cloth";
import { findRendersByHashes } from "../renders/db";
import { canonicalClothParams, paramsHash } from "../renders/params";
import type { AppSession } from "../session";
import { buildWardrobeView } from "../wardrobe";
import {
  deleteUnsavedLooks,
  insertLook,
  listLooksForOccasion,
  updateLook,
} from "./db";
import { composeFromListings, groundGaps } from "./gaps";
import { buildListingLookRationale } from "./rationale";
import {
  isStoredGarmentMember,
  lookKeyOfItems,
  lookKeyOfMembers,
  readStoredMembers,
  toReportListing,
  toStoredGarments,
} from "./stored";
import { rankLooks } from "./stylist";

/**
 * Everything /looks needs, in one object.
 *
 * docs/01-user-flow.md section K is the layout this fills: the occasion chips,
 * two to three composed looks with a rationale each, the hero garment rendered
 * on the person, and a shoppable card for whatever the look is missing.
 *
 * The order of work, and who decides what:
 *
 * 1. src/lib/shared/looks.ts composes the candidates. Pure, deterministic, and
 *    the only thing allowed to decide what may be worn with what.
 * 2. src/lib/server/looks/stylist.ts ranks and explains them, or the rules do
 *    when there is no model (docs/03-architecture.md, "Claude API error").
 * 3. src/lib/server/looks/gaps.ts shops for what is missing, through the same
 *    grounding layer the report uses.
 * 4. This file attaches the person's own garment photos and whatever cloth try
 *    on already exists, and writes the composition down so a look can be saved.
 *
 * Three things it deliberately does not do:
 *
 * 1. It never starts a render. It reports the cloth renders that already exist
 *    for the hero garments it is offering, so a look the person has already
 *    seen comes back with its picture instead of a second credit
 *    (docs/03-architecture.md, "Caching"). Starting one is POST /api/renders.
 * 2. It never invents a picture, a product, or a piece. A look holds garments
 *    the person owns and listings that came back from SerpApi, and nothing else.
 * 3. It never decides that a look is good. That is the rules engine and the
 *    stylist, in that order.
 */

/** A render row as the card reads it. Running and pending are one state. */
function renderStatusOf(status: JobStatus): LookRenderStatus {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  return "pending";
}

/** A signed URL for a finished render, or null. Never a substitute image. */
async function signRender(render: Render): Promise<string | null> {
  if (render.status !== "succeeded" || render.storage_path === null) {
    return null;
  }
  try {
    return await createSignedRead(BUCKETS.renders, render.storage_path);
  } catch {
    return null;
  }
}

/**
 * The cloth render params hash for one garment on one capture, or null when
 * there is nothing to look up: no capture on the profile, or a garment nobody
 * has classified, which has no garment_category to send.
 */
export function clothHashFor(args: {
  readonly captureId: string | null;
  readonly garment: GarmentView | undefined;
}): string | null {
  const garment = args.garment;
  if (args.captureId === null || garment === undefined) {
    return null;
  }
  const category = clothCategoryForType(garment.type);
  if (category === null) {
    return null;
  }
  return paramsHash(
    "cloth",
    canonicalClothParams({
      captureId: args.captureId,
      garmentId: garment.id,
      garmentCategory: category,
    }),
  );
}

/** Hash to render, for the hero garments that have one. */
async function clothRendersByHash(args: {
  readonly ownerId: string;
  readonly hashes: readonly string[];
}): Promise<Map<string, Render>> {
  const found = new Map<string, Render>();
  if (args.hashes.length === 0) {
    return found;
  }
  try {
    for (const render of await findRendersByHashes({
      ownerId: args.ownerId,
      kind: "cloth",
      paramsHashes: args.hashes,
    })) {
      found.set(render.params_hash, render);
    }
  } catch {
    // A screen that cannot read its render history still shows every look. It
    // shows them as not yet rendered, which is what the person would see on
    // their first visit anyway.
  }
  return found;
}

/** The items of one candidate, in the order the rules put them. */
function itemsOfCandidate(
  candidate: Candidate,
  garmentsById: ReadonlyMap<string, GarmentView>,
): LookItem[] {
  const items: LookItem[] = [];
  for (const id of candidate.garmentIds) {
    const garment = garmentsById.get(id);
    if (garment === undefined || garment.type === null) {
      continue;
    }
    items.push({
      source: "garment",
      garmentId: garment.id,
      imageUrl: garment.imageUrl,
      type: garment.type,
    });
  }
  return items;
}

/** The items of a stored look, with anything the person no longer owns dropped. */
function itemsOfStoredLook(
  row: Look,
  garmentsById: ReadonlyMap<string, GarmentView>,
): LookItem[] {
  const items: LookItem[] = [];
  for (const member of readStoredMembers(row.garments)) {
    if (isStoredGarmentMember(member)) {
      const garment = garmentsById.get(member.garment_id);
      if (garment === undefined) {
        // The garment was deleted. A look cannot show a piece that is gone, and
        // it must not show a stand in for one.
        continue;
      }
      // The current type leads, because the person may have corrected the chip
      // since. A piece with no type at all is dropped rather than drawn with a
      // blank label.
      const type = garment.type ?? member.type ?? null;
      if (type === null) {
        continue;
      }
      items.push({
        source: "garment",
        garmentId: garment.id,
        imageUrl: garment.imageUrl,
        type,
      });
      continue;
    }
    const type = member.type ?? null;
    if (type === null) {
      continue;
    }
    items.push({
      source: "listing",
      listing: toReportListing(member),
      type,
    });
  }
  return items;
}

/**
 * The gaps of every candidate, grounded once.
 *
 * Two looks for a wedding usually miss the same piece, and asking for it twice
 * would spend two searches on one answer. The union is searched once and every
 * look reads the same result.
 */
async function groundAllGaps(args: {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly palette: Palette | null;
  readonly candidates: readonly Candidate[];
}): Promise<Map<string, LookGap>> {
  const types: string[] = [];
  for (const candidate of args.candidates) {
    for (const gap of candidate.gaps) {
      if (!types.includes(gap)) {
        types.push(gap);
      }
    }
  }
  const gaps = await groundGaps({
    session: args.session,
    occasion: args.occasion,
    palette: args.palette,
    gapTypes: types,
  });
  return new Map(gaps.map((gap) => [gap.type, gap] as const));
}

/**
 * Writes the composition down and returns the row id for each look.
 *
 * /looks recomposes on every visit, so the rows are a record of the last
 * composition rather than a cache of an answer: a look keeps its id while its
 * pieces are unchanged, which is what lets "Save this look" flip a flag on a row
 * the screen is already showing. A row nobody saved and nothing matches is
 * deleted, so the table follows the wardrobe instead of growing with it.
 *
 * Never throws. With no database reachable the looks still render, and their ids
 * fall back to the deterministic candidate ids; saving one then answers "not
 * found", which is true.
 */
async function persistComposition(args: {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly composed: readonly ComposedLook[];
  readonly rows: readonly Look[];
}): Promise<{ readonly id: string; readonly isSaved: boolean }[]> {
  const assigned: { id: string; isSaved: boolean }[] = [];
  const claimed = new Set<string>();

  for (const entry of args.composed) {
    const match = args.rows.find(
      (row) =>
        !claimed.has(row.id) &&
        lookKeyOfMembers(readStoredMembers(row.garments)) === entry.key,
    );

    try {
      if (match !== undefined) {
        claimed.add(match.id);
        if (match.rationale !== entry.view.rationale) {
          await updateLook(args.session.id, match.id, {
            rationale: entry.view.rationale,
          });
        }
        assigned.push({ id: match.id, isSaved: match.is_saved });
        continue;
      }

      const row: Insert<"looks"> = {
        user_id: args.session.id,
        occasion: args.occasion,
        garments: toStoredGarments(entry.view.items),
        rationale: entry.view.rationale,
      };
      const inserted = await insertLook(row);
      claimed.add(inserted.id);
      assigned.push({ id: inserted.id, isSaved: inserted.is_saved });
    } catch {
      // A write that did not land leaves the look with its composed id. The
      // screen still renders it; only "Save this look" cannot find it.
      assigned.push({ id: entry.view.id, isSaved: false });
    }
  }

  try {
    await deleteUnsavedLooks({
      ownerId: args.session.id,
      lookIds: args.rows
        .filter((row) => !claimed.has(row.id) && !row.is_saved)
        .map((row) => row.id),
    });
  } catch {
    // Housekeeping. A row left behind is invisible to the person.
  }

  return assigned;
}

/**
 * The looks view for the signed in person or the judge session.
 *
 * Always returns a view. A person with no profile, no palette, or no garments
 * still gets a screen: docs/01 section K has a state for every one of those, and
 * none of them is an error.
 */
export async function buildLooksView(
  session: AppSession,
  occasion: Occasion,
): Promise<LooksView> {
  if (isDemoFixtureMode()) {
    console.log(
      JSON.stringify({
        event: "aurum.looks_view",
        source: "fixture",
        note: `${DEMO_FIXTURE_ENV} is true: the looks are served from the checked in fixture and no database or provider is touched.`,
      }),
    );
    return demoFixtureLooksView(occasion);
  }

  const wardrobe = await buildWardrobeView(session);
  const garments = wardrobe.garments;
  const garmentsById = new Map(
    garments.map((garment) => [garment.id, garment] as const),
  );

  const profile = await getAestheticProfile(session.id);
  const palette = profile === null ? null : paletteForProfile(profile);
  const captureId = profile?.capture_id ?? null;

  const candidates = composeCandidates({ garments, palette, occasion });

  const composed =
    candidates.length > 0
      ? await composeFromWardrobe({
          session,
          occasion,
          palette,
          candidates,
          garmentsById,
          captureId,
        })
      : await composeFromShop({ session, occasion, palette });

  const rows = await readLooksRows(session, occasion);
  const assigned = await persistComposition({
    session,
    occasion,
    composed,
    rows,
  });

  const composedViews = composed.map((entry, index) => {
    const record = assigned[index];
    return {
      isSaved: record?.isSaved ?? false,
      view: record === undefined ? entry.view : { ...entry.view, id: record.id },
    };
  });

  // Saved first, docs/01-user-flow.md section L item 2: a saved look is
  // something the person kept, so it leads its occasion. A saved look whose
  // pieces no longer compose (the wardrobe changed, or the occasion no longer
  // accepts one of them) is still theirs, so it is shown above the new ones
  // rather than dropped.
  const composedKeys = new Set(composed.map((entry) => entry.key));
  const savedLooks = rows
    .filter(
      (row) =>
        row.is_saved &&
        !composedKeys.has(lookKeyOfMembers(readStoredMembers(row.garments))),
    )
    .map((row) => toSavedLookView(row, occasion, garmentsById))
    .filter((look): look is LookView => look !== null);

  const ordered: LookView[] = [
    ...savedLooks,
    ...composedViews.filter((entry) => entry.isSaved).map((entry) => entry.view),
    ...composedViews.filter((entry) => !entry.isSaved).map((entry) => entry.view),
  ];

  console.log(
    JSON.stringify({
      event: "aurum.looks_built",
      ownerType: session.ownerType,
      ownerId: session.id,
      occasion,
      garments: garments.length,
      candidates: candidates.length,
      looks: ordered.length,
      savedLooks: savedLooks.length,
      fromListings: candidates.length === 0,
    }),
  );

  return {
    occasion,
    looks: ordered,
    wardrobeEmpty: garments.length === 0,
  };
}

/** The rows for this occasion, or none when the table cannot be read. */
async function readLooksRows(
  session: AppSession,
  occasion: Occasion,
): Promise<Look[]> {
  try {
    return await listLooksForOccasion({
      ownerId: session.id,
      occasion,
    });
  } catch {
    return [];
  }
}

interface ComposedLook {
  readonly key: string;
  readonly view: LookView;
}

/** The looks a person's own wardrobe can make for this occasion. */
async function composeFromWardrobe(args: {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly palette: Palette | null;
  readonly candidates: readonly Candidate[];
  readonly garmentsById: ReadonlyMap<string, GarmentView>;
  readonly captureId: string | null;
}): Promise<ComposedLook[]> {
  const ranked = await rankLooks({
    session: args.session,
    occasion: args.occasion,
    palette: args.palette,
    garmentsById: args.garmentsById,
    candidates: args.candidates,
  });

  const gapsByType = await groundAllGaps({
    session: args.session,
    occasion: args.occasion,
    palette: args.palette,
    candidates: args.candidates,
  });

  const byId = new Map(
    args.candidates.map((candidate) => [candidate.id, candidate] as const),
  );

  const heroHashes = new Map<string, string>();
  for (const look of ranked.ranked) {
    if (look.heroGarmentId === null) {
      continue;
    }
    const hash = clothHashFor({
      captureId: args.captureId,
      garment: args.garmentsById.get(look.heroGarmentId),
    });
    if (hash !== null) {
      heroHashes.set(look.heroGarmentId, hash);
    }
  }
  const renders = await clothRendersByHash({
    ownerId: args.session.id,
    hashes: [...heroHashes.values()],
  });

  const composed: ComposedLook[] = [];
  for (const look of ranked.ranked) {
    const candidate = byId.get(look.candidateId);
    if (candidate === undefined) {
      continue;
    }
    const items = itemsOfCandidate(candidate, args.garmentsById);
    if (items.length === 0) {
      continue;
    }

    const hash =
      look.heroGarmentId === null ? undefined : heroHashes.get(look.heroGarmentId);
    const render = hash === undefined ? undefined : renders.get(hash);

    composed.push({
      key: lookKeyOfItems(items),
      view: {
        id: candidate.id,
        occasion: args.occasion,
        rationale: look.rationale,
        rationaleSource: look.rationaleSource,
        items,
        heroGarmentId: look.heroGarmentId,
        renderUrl: render === undefined ? null : await signRender(render),
        renderStatus: render === undefined ? "none" : renderStatusOf(render.status),
        gaps: candidate.gaps
          .map((type) => gapsByType.get(type))
          .filter((gap): gap is LookGap => gap !== undefined),
      },
    });
  }

  return composed;
}

/**
 * The look a person with nothing in their wardrobe gets, docs/01 section K
 * states: "the looks are composed entirely from live listings within the
 * palette".
 *
 * One look, not three: every piece is a live search against a shared daily cap,
 * and three outfits of listings would spend nine searches on a screen whose
 * whole message is "add your own garments to mix them in".
 */
async function composeFromShop(args: {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly palette: Palette | null;
}): Promise<ComposedLook[]> {
  const listingLook = await composeFromListings({
    session: args.session,
    occasion: args.occasion,
    palette: args.palette,
  });
  if (listingLook === null) {
    return [];
  }

  const view: LookView = {
    id: `${args.occasion}-listings`,
    occasion: args.occasion,
    rationale: buildListingLookRationale({
      occasion: args.occasion,
      palette: args.palette,
      colorName: listingLook.heroColorName,
    }),
    rationaleSource: "rules",
    items: listingLook.items,
    // Nothing here is the person's, so there is nothing to render on them.
    heroGarmentId: null,
    renderUrl: null,
    renderStatus: "none",
    gaps: [],
  };

  return [{ key: lookKeyOfItems(view.items), view }];
}

/**
 * A saved look that the current composition no longer produces.
 *
 * Its rationale is the one that was stored with it, because that is the reason
 * the person saved it under. Null when nothing of it is left: every garment in
 * it has been deleted.
 */
function toSavedLookView(
  row: Look,
  occasion: Occasion,
  garmentsById: ReadonlyMap<string, GarmentView>,
): LookView | null {
  const items = itemsOfStoredLook(row, garmentsById);
  if (items.length === 0) {
    return null;
  }
  const rationale = row.rationale;
  if (rationale === null || rationale.length === 0) {
    return null;
  }

  const hero = items.find((item) => item.source === "garment");

  return {
    id: row.id,
    occasion,
    rationale,
    // A stored rationale carries no record of who wrote it, and calling a
    // model's sentence the rules' would be as wrong as the other way round.
    // "rules" is the safe half of that pair: it never claims a model spoke.
    rationaleSource: "rules",
    items,
    heroGarmentId: hero !== undefined && hero.source === "garment" ? hero.garmentId : null,
    renderUrl: null,
    renderStatus: "none",
    gaps: [],
  };
}
