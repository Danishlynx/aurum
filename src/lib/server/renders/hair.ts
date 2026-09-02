import "server-only";

import { isHairStyleId, type HairStyleId } from "@/lib/shared/hair-rules";

import { getEndpoint } from "../providers/perfectcorp";
import type { StoredHairColorParams, StoredHairstyleParams } from "./params";

/**
 * The hairstyle and hair colour try on request bodies.
 *
 * The provider module owns the envelope, the task creation, and the polling.
 * This file owns the two things left: which style we ask for, and which colour.
 * It is the hair twin of src/lib/server/renders/makeup.ts.
 *
 * docs/04-integrations.md, "Hairstyle and hair color try on (Layer 3)", and the
 * credit table: a hairstyle render costs 2 units, a hair colour render costs 1.
 */

/* ------------------------------------------------------------------ */
/* Hairstyle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where the provider's hairstyle templates come from, and when they were read.
 *
 * The reference page names a Template API next to the task API, and it is a
 * plain GET that lists the predefined reference templates. It creates no task,
 * so it costs nothing: the credit balance was 24 units before the read and 24
 * after it.
 *
 *     GET /s2s/v2.1/task/template/hair-transfer?page_size=20&starting_token=...
 *     Authorization: Bearer <api key>
 *
 * The response is the { status, data } envelope the task APIs use, with the
 * page inside it:
 *
 *     { status, data: { next_token, templates: [
 *         { id, thumb, title, category_name, keep_users_color } ] } }
 *
 * next_token is null on the last page and is passed back as starting_token.
 * page_size has a ceiling: 20 is accepted, 50 and 100 both answer 400
 * InvalidParameters, "page_size is above the allowed maximum." The v2.0 spelling
 * of the same path answers with the identical list, so the list is not versioned
 * with the task API.
 *
 * The whole catalog is 116 templates: 17 under category_name "Male" and 99 under
 * "Female". The id prefix and the category are not the same axis, which is worth
 * knowing before reading an id as a gender: all_crewcut is categorised Male and
 * all_bobcut is categorised Female, while the male_ and female_ prefixes match
 * their category. HAIRSTYLE_TEMPLATE_CATALOG below records only the 13 the app
 * actually sends. Re read the full list any time with the GET above.
 */
export const HAIRSTYLE_TEMPLATE_SOURCE = {
  listPath: "/s2s/v2.1/task/template/hair-transfer",
  maxPageSize: 20,
  totalTemplates: 116,
  docs: "https://docs.makeupar.com/reference/ai_hairstyle",
  readOn: "2026-09-02",
} as const;

/** One row of the provider's template list, in the fields it returns. */
export interface HairstyleTemplate {
  readonly id: string;
  /** The provider's own name for the template, quoted exactly. */
  readonly title: string;
  /** The provider's category_name. Not the same axis as the id prefix. */
  readonly category: "Male" | "Female";
  /**
   * True when the template keeps the person's own hair colour and changes only
   * the cut. False means the template imposes its own colour as well, which is
   * why it is recorded: a hairstyle try on that silently recolours would be
   * answering a question the person asked on the colour row instead.
   */
  readonly keepUsersColor: boolean;
}

/**
 * The templates this app sends, read live from the list endpoint above.
 *
 * These are the provider's ids and the provider's own titles. Nothing here is
 * invented: an id that is not in this list came from somewhere else and should
 * be checked against the endpoint before it is trusted.
 */
export const HAIRSTYLE_TEMPLATE_CATALOG: readonly HairstyleTemplate[] = [
  { id: "male_textured_crop", title: "Textured Crop", category: "Male", keepUsersColor: false },
  { id: "all_soft_flipped_layers", title: "Soft Flipped Layers", category: "Female", keepUsersColor: true },
  { id: "female_blunt_bob", title: "Blunt Bob", category: "Female", keepUsersColor: true },
  { id: "all_bobcut", title: "Bobcut", category: "Female", keepUsersColor: true },
  { id: "all_french_bob", title: "French Bob", category: "Female", keepUsersColor: true },
  { id: "all_modern_mid_part_bob", title: "Modern Mid-Part Bob", category: "Female", keepUsersColor: true },
  { id: "all_curtain_wavy", title: "Curtain Wavy", category: "Female", keepUsersColor: true },
  { id: "female_blunt_fringe_straight", title: "Blunt Fringe Straight", category: "Female", keepUsersColor: true },
  { id: "all_face_framing_shag_cut", title: "Face Framing Shag Cut", category: "Female", keepUsersColor: true },
  { id: "female_modern_wavy_lob", title: "Modern Wavy Lob", category: "Female", keepUsersColor: true },
  { id: "female_dark_c_curl_layers", title: "Dark C-Curl Layers", category: "Female", keepUsersColor: true },
  { id: "all_gentle_waves", title: "Gentle Waves", category: "Female", keepUsersColor: true },
  { id: "all_bixie_cut", title: "Bixie Cut", category: "Female", keepUsersColor: true },
];

/**
 * The provider template id for each catalog style.
 *
 * CONFIRMED, from src/lib/server/providers/perfectcorp/endpoints.ts: the path is
 * /s2s/v2.1/task/hair-transfer (note v2.1, not v2.0), the request takes
 * src_file_id or src_file_url plus one of ref_file_id, ref_file_url, or
 * template_id, the result carries a url, and one successful call costs 2 units.
 *
 * CONFIRMED, as of HAIRSTYLE_TEMPLATE_SOURCE.readOn: every id below exists in
 * the provider's live template list. What is still UNVERIFIED is the pairing at
 * the other end: no hairstyle task has been created on this account, so the
 * template_id field name is the reference page's word and not something we have
 * watched succeed, and no render has been looked at to check that a template
 * lands as the cut its title names. The first golden run settles both, and it
 * costs 2 units.
 *
 * Which template each of our cuts maps to is a curation call, not a fact the
 * provider states, so each one records how close the match is:
 *
 *   exact: the provider's title names the same cut we do.
 *   near:  the same family and length, a detail unstated or different.
 *
 * The catalog holds no angled or A line bob and nothing named for crown volume,
 * so those two rows take the nearest cut with the same effect and are marked
 * near. Preferring keep_users_color true is deliberate everywhere it was
 * possible: a hairstyle render should change the cut and leave the colour to the
 * colour row. textured-crop is the one exception, because the exact cut is worth
 * more than the colour there, and the person is shown a render of a haircut.
 *
 * The other way in, a reference image of the haircut, is deliberately not used:
 * a reference photo is someone else's face, and the rule in CLAUDE.md is that
 * the person only ever processes their own.
 */
export const HAIRSTYLE_TEMPLATE_ID: Readonly<
  Record<HairStyleId, string | null>
> = {
  // exact: "Textured Crop". The default the golden run reaches for.
  "textured-crop": "male_textured_crop",
  // exact: "Soft Flipped Layers", layers below the jaw.
  "soft-layers-collarbone": "all_soft_flipped_layers",
  // exact: "Blunt Bob".
  "blunt-bob-jaw": "female_blunt_bob",
  // near: "Bobcut" is the plain bob. The provider does not state its length.
  "blunt-bob-below-jaw": "all_bobcut",
  // exact: a French bob is a chin length blunt bob.
  "chin-length-bob": "all_french_bob",
  // near: the catalog holds no angled or A line bob. This one falls below the chin.
  "angled-bob-below-chin": "all_modern_mid_part_bob",
  // exact: "Curtain Wavy" is the curtain parting.
  "curtain-fringe": "all_curtain_wavy",
  // exact: "Blunt Fringe Straight".
  "blunt-fringe": "female_blunt_fringe_straight",
  // exact: a shag is long layers, and this one frames the face.
  "long-layers-shoulders": "all_face_framing_shag_cut",
  // near: a lob, which is the length. The provider does not state the parting.
  "side-parted-lob": "female_modern_wavy_lob",
  // near: C curl layers sweep in across the face. "Dark" is the thumbnail, not
  // the render: this template keeps the person's own colour.
  "side-swept-layers": "female_dark_c_curl_layers",
  // exact: "Gentle Waves".
  "soft-waves-shoulder": "all_gentle_waves",
  // near: nothing is named for crown volume. A bixie is short with the volume
  // through the top, which is what the reason for this row claims.
  "volume-through-top": "all_bixie_cut",
};

/** The provider template for a style id, or null when there is none to send. */
export function hairstyleTemplateFor(styleId: string): string | null {
  if (!isHairStyleId(styleId)) {
    return null;
  }
  return HAIRSTYLE_TEMPLATE_ID[styleId];
}

/**
 * The body for one hairstyle try on. Returns null when the style has no
 * provider template, which the caller reads as "there is nothing to render".
 */
export function hairstyleTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredHairstyleParams;
}): Record<string, unknown> | null {
  const templateId = hairstyleTemplateFor(args.params.styleId);
  if (templateId === null) {
    return null;
  }
  const endpoint = getEndpoint("hairstyleTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    template_id: templateId,
  };
}

/* ------------------------------------------------------------------ */
/* Hair colour                                                         */
/* ------------------------------------------------------------------ */

/** Full head rather than ombre. Both cost 1 unit (docs/04-integrations.md). */
export const HAIR_COLOR_MODE = "full";

/** Full strength. The swatch the person picked is the colour they asked for. */
export const HAIR_COLOR_INTENSITY = 100;

/**
 * The body for one hair colour try on.
 *
 * UNVERIFIED, twice over, which is why the endpoint entry itself is marked
 * unverified and the render layer refuses to call it without
 * PERFECTCORP_ALLOW_UNVERIFIED:
 *
 *   1. the task path did not render on the reference page, so the path in
 *      endpoints.ts is a placeholder,
 *   2. the request fields that carry the colour are not confirmed. The shape
 *      below follows the makeup try on payload, which is the closest confirmed
 *      neighbour, with the full versus ombre mode the reference page does
 *      confirm.
 *
 * Nothing has ever been rendered from it. What is confirmed is only the price,
 * 1 unit per render for both modes.
 *
 * TODO for the human: run one hair colour try on from the API playground, record
 * the path and the colour payload in endpoints.ts, mark the entry confirmed, and
 * correct this body if it differs.
 */
export function hairColorTaskBody(args: {
  readonly fileId: string;
  readonly params: StoredHairColorParams;
}): Record<string, unknown> | null {
  const endpoint = getEndpoint("hairColorTryOn");
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";
  return {
    [fileField]: args.fileId,
    mode: HAIR_COLOR_MODE,
    palettes: [
      {
        colors: [
          { color: args.params.colorHex, intensity: HAIR_COLOR_INTENSITY },
        ],
      },
    ],
  };
}
