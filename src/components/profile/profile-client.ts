/**
 * The browser side of the routes /profile calls.
 *
 * It lives beside the screen for the same reason
 * src/components/wardrobe/wardrobe-client.ts does: these are one screen's own
 * calls. The rules are src/lib/client/api.ts's rules. Every response is parsed
 * with zod before it reaches a component, and no sentence a person reads is ever
 * taken from a response body: a route returns {error: string} for the log and
 * the network tab, and the screen picks its line from copy.ts.
 *
 * Routes, docs/01-user-flow.md section L and the Layer 5 contract:
 *
 *   GET    /api/profile          the summary rows, the saved items, the flags
 *   PATCH  /api/profile          "Keep original photos"
 *   POST   /api/profile/delete   "Delete everything", with the typed word
 *
 * GET /api/profile/download is not here. It is a plain link on the screen, so
 * the browser saves the file the server names in its Content-Disposition header
 * and this app never has to invent a filename for the person's own data.
 *
 * Failures are typed rather than described. "read_only" is the honest 403 the
 * demo profile answers a write with, and everything else is one kind, because
 * from the person's side a 500, a dropped connection, and a schema that did not
 * match are the same event: it did not happen.
 */

import { z } from "zod";

import { copy } from "@/lib/shared/copy";
import type { ProfileView } from "@/lib/shared/profile-view";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * ProfileSummaryRow and SavedItemRow from src/lib/shared/profile-view.ts, as
 * schemas. The keys and the actions are closed sets, because the screen decides
 * where an affordance links from the action and has nowhere to send an action it
 * does not know.
 */
const profileSummaryRowSchema = z.object({
  key: z.enum([
    "skin_type",
    "top_concern",
    "tone_undertone",
    "season",
    "face_shape",
    "hair_type",
  ]),
  label: z.string().min(1),
  value: z.string().nullable(),
  action: z.enum(["retake", "adjust"]).nullable(),
});

const savedItemRowSchema = z.object({
  kind: z.enum(["makeup", "hair", "look"]),
  label: z.string().min(1),
  detail: z.string().nullable(),
});

const profileViewSchema = z.object({
  rows: z.array(profileSummaryRowSchema),
  saved: z.array(savedItemRowSchema),
  keepOriginals: z.boolean(),
  isJudgeSession: z.boolean(),
  /**
   * False only before any photo has been read for this session, which is when
   * the screen puts the first run invitation above the rows. Required rather
   * than optional: a missing flag would default the screen into showing an
   * invitation to somebody who already has a profile, and the route always
   * sends it.
   */
  hasProfile: z.boolean(),
});

/** Both writes answer the same way: it happened, or the status says why not. */
const okSchema = z.object({ ok: z.literal(true) });

export type ProfileOk = z.infer<typeof okSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Why a call did not do what it was asked.
 *
 * "read_only" is the 403 the demo profile answers every write with, kept apart
 * from the rest so the screen can say so instead of claiming an ordinary
 * failure. docs/01-user-flow.md "Judge mode across the flow": a judge session
 * never sees the delete control, and the server refuses it regardless.
 */
export type ProfileFailure = "read_only" | "other";

export type ProfileResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ProfileFailure };

function failureFor(status: number): ProfileFailure {
  return status === 403 ? "read_only" : "other";
}

async function readJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function call<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<ProfileResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    return { ok: false, failure: "other" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureFor(response.status) };
  }

  const parsed = schema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false, failure: "other" };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/** The profile as it stands: the six rows, what is saved, and the two flags. */
export function fetchProfile(): Promise<ProfileResult<ProfileView>> {
  return call(
    "/api/profile",
    { method: "GET", cache: "no-store" },
    profileViewSchema,
  );
}

/**
 * "Keep original photos", docs/01-user-flow.md section L item 3, which mirrors
 * the retention choice made on the consent screen.
 *
 * The screen only moves the toggle once this answers, so what a person sees is
 * what the server stored, never an optimistic guess about it.
 */
export function saveKeepOriginals(
  keepOriginals: boolean,
): Promise<ProfileResult<ProfileOk>> {
  return call(
    "/api/profile",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepOriginals }),
    },
    okSchema,
  );
}

/**
 * "Delete everything", docs/01-user-flow.md section L: the person types DELETE,
 * and the server removes the rows and the storage objects and signs them out.
 *
 * The typed word travels with the request so the refusal is the server's too: a
 * body without it is rejected there, not only here. It is copy.profile.
 * deleteConfirmWord, the same constant the field is checked against, so the word
 * on the screen and the word in the body cannot drift.
 */
export function deleteEverything(): Promise<ProfileResult<ProfileOk>> {
  return call(
    "/api/profile/delete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: copy.profile.deleteConfirmWord }),
    },
    okSchema,
  );
}

/**
 * Where "Download my data" points. A route, not a fetch: the screen renders it
 * as a link so the browser performs the save and the server names the file.
 */
export const PROFILE_DOWNLOAD_HREF = "/api/profile/download";
