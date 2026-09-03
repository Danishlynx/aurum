import "server-only";

import type {
  AccessoryCategory,
  RenderRequest,
  RenderStatus,
  RenderView,
  SimulatableConcernKey,
} from "@/lib/shared/color-view";
import { copy } from "@/lib/shared/copy";
import { storedImageType } from "@/lib/shared/image-type";

import {
  countRenders,
  findJobForSubject,
  getCapture,
  insertJob,
  updateJob,
} from "../db";
import { BUCKETS, createSignedRead, downloadObject, uploadObject } from "../db/storage";
import type { JobRecord, Json, Render, RenderKind } from "../db/types";
import { findReservation, perfectCorpUnits, reconcile, refund, reserve } from "../credits";
import {
  isSupabaseConfigured,
  JUDGE_RENDERS_ALLOWED,
  providerCallsEnabled,
} from "../env";
import { messages } from "../http/messages";
import {
  claimForPolling,
  JOB_LIFETIME_MS,
  messageForFailure,
} from "../jobs";
import { getAestheticProfile } from "../profile/db";
import { isDemoFixtureMode } from "../profile/report-view";
import {
  createTask,
  downloadResultAssets,
  getEndpoint,
  getTaskSnapshot,
  isPerfectCorpConfigured,
  parseRenderUrls,
  uploadImage,
  type PerfectCorpEndpointKey,
} from "../providers/perfectcorp";
import type { AppSession } from "../session";
import { getGarment, listGarments } from "../wardrobe/db";
import {
  accessoryEndpointFor,
  accessoryTaskBody,
  callableAccessoryCategories,
  isAccessoryCategory,
  isAccessoryGarmentType,
} from "./accessory";
import { clothCategoryForType, clothTaskBody } from "./cloth";
import {
  countOpenRenders,
  deleteRender,
  findRenderByHash,
  getRender,
  insertRender,
  updateRender,
} from "./db";
import { hairColorTaskBody, hairstyleTaskBody, hairstyleTemplateFor } from "./hair";
import { makeupTaskBody } from "./makeup";
import {
  canonicalAccessoryParams,
  canonicalClothParams,
  canonicalHairColorParams,
  canonicalHairstyleParams,
  canonicalMakeupParams,
  canonicalSimulationParams,
  paramsHash,
  type StoredAccessoryParams,
  type StoredClothParams,
  type StoredHairColorParams,
  type StoredHairstyleParams,
  type StoredMakeupParams,
  type StoredRenderParams,
  type StoredSkinSimulationParams,
} from "./params";
import { simulationConcernsFor, simulationTaskBody } from "./simulation";

/**
 * Try on renders: one shade set, one hairstyle, one hair colour, one garment,
 * one accessory, or one projection in, one image of the person's own face out,
 * or nothing.
 *
 * docs/01-user-flow.md sections F, H, I, and K are the screens, and
 * docs/09-build-order-and-demo.md Layer 6 adds the last two kinds: the skin
 * simulation on /report, which is labeled as a projection and never as a
 * promise (docs/06-safety-privacy.md), and one accessory try on in the top look.
 * docs/03-architecture.md is the machinery: renders are cached by
 * (user_id, kind, params_hash), they are sequential per person, and every
 * provider call reserves credits first.
 * docs/07-payments-and-judge-mode.md caps a judge session at twelve of them
 * (raised from six on 2026-09-03), and that cap counts every kind together: four
 * makeup rows, a hairstyle, a hair colour, and a garment is one demo session.
 *
 * The rule that shapes every path in this file: a try on cannot be faked. With
 * no key, with the kill switch off, with the original photo already deleted, or
 * with a failed task, the answer is a typed refusal and the screen shows the
 * unedited selfie with "Preview unavailable for this shade."
 * (docs/01 section H, "Try on failed"). There is no stand in image anywhere in
 * this module.
 *
 * "The original photo already deleted" is now a rare case rather than the
 * ordinary one. Retention used to remove it as soon as the readings finished,
 * which made this whole module unreachable for a live person; since 2026-09-03
 * the original lives as long as the session (docs/06-safety-privacy.md,
 * "Retention", and supabase/migrations/0014), so a person who just finished an
 * analysis has a face to try things on.
 *
 * The job half follows the analysis jobs exactly and reuses their helpers: the
 * same compare and set poll claim, the same lifetime, the same failure to
 * sentence mapping. What differs is only what a render does on success, which is
 * to pull the image into the private renders bucket before the provider's URL
 * expires (docs/04-integrations.md, step 5).
 */

/** renders/<user_id>/<render_id>.<ext>, the convention in migration 0003. */
export function renderPath(
  ownerId: string,
  renderId: string,
  extension = "jpg",
): string {
  return `${ownerId}/${renderId}.${extension}`;
}

/** The render kinds this build can produce. Layer 6 adds the last two. */
export type SupportedRenderKind = RenderRequest["kind"];

/**
 * A kind whose endpoint is fixed. Every kind but the accessory: an accessory try
 * on has one endpoint per category (earrings, bag, watch), so its endpoint is
 * read from the request or from the stored params, never from the kind.
 */
export type FixedEndpointRenderKind = Exclude<SupportedRenderKind, "accessory">;

/**
 * The endpoint behind each fixed kind, and with it the price: makeup try on is
 * 1 unit, hairstyle try on is 2, hair colour try on is 1, skin simulation is 4
 * for up to four concerns, and cloth try on is still TBD in the credit table, so
 * the credits layer reserves the unknown cost fallback of one unit for it
 * (docs/04-integrations.md).
 */
export const ENDPOINT_FOR_RENDER_KIND: Readonly<
  Record<FixedEndpointRenderKind, PerfectCorpEndpointKey>
> = {
  makeup: "makeupTryOn",
  hairstyle: "hairstyleTryOn",
  hair_color: "hairColorTryOn",
  cloth: "clothTryOn",
  skin_simulation: "skinSimulation",
};

/** The endpoint for a kind that has exactly one, or null for the accessory. */
export function endpointForRenderKind(
  kind: RenderKind,
): PerfectCorpEndpointKey | null {
  return kind === "accessory" ? null : ENDPOINT_FOR_RENDER_KIND[kind];
}

/**
 * The endpoint a stored render polls against, or null when there is none to
 * poll.
 *
 * For an accessory that means reading the category back out of the stored
 * params, because that is what decided the endpoint when the task was created. A
 * row whose params do not carry a category we recognise returns null and is left
 * exactly as it is rather than polled against a guess.
 */
export function endpointForStoredRender(
  render: Pick<Render, "kind" | "params">,
): PerfectCorpEndpointKey | null {
  if (render.kind !== "accessory") {
    return endpointForRenderKind(render.kind);
  }
  const params = render.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  const category = (params as Record<string, unknown>).category;
  return typeof category === "string" && isAccessoryCategory(category)
    ? accessoryEndpointFor(category)
    : null;
}

/**
 * Units one render reserves.
 *
 * The item count is what the tiered rows in the credit table are counted by: the
 * number of concerns for a skin simulation (4 units for 1 to 4 of them, 6 for 5
 * to 10). Every other render sends one item.
 */
export function renderUnits(
  endpointKey: PerfectCorpEndpointKey,
  itemCount = 1,
): number {
  return perfectCorpUnits(endpointKey, itemCount);
}

/** Units one makeup try on reserves. One per render, per docs/04. */
export function makeupRenderUnits(): number {
  return renderUnits("makeupTryOn");
}

/**
 * Whether we are allowed to call the endpoint behind a kind at all.
 *
 * This mirrors assertEndpointVerified in the Perfect Corp client, which is still
 * the gate at the call site. It is repeated here so an unverified endpoint is a
 * typed refusal the screen can render, taken before a credit is reserved and a
 * row is written, rather than a provider exception after both.
 *
 * As of 2026-09-02 every fixed kind is callable: makeup, hairstyle, hair colour,
 * cloth, and the skin simulation all have a confirmed path and a confirmed
 * request body (endpoints.ts records how each was settled, and all of it was
 * settled for free). What this still stops is the accessory kinds behind the
 * earrings and the bag, whose unit costs are published nowhere we can read, so
 * the credits layer would have nothing true to reserve. They need
 * PERFECTCORP_ALLOW_UNVERIFIED=true, and the screens offer neither.
 */
export function isRenderEndpointCallable(key: PerfectCorpEndpointKey): boolean {
  return (
    getEndpoint(key).verification.state === "confirmed" ||
    process.env.PERFECTCORP_ALLOW_UNVERIFIED === "true"
  );
}

export type CreateRenderRefusal =
  | "no_profile"
  | "no_capture_image"
  | "render_in_progress"
  | "judge_render_limit"
  | "not_configured"
  | "endpoint_unverified"
  | "style_not_renderable"
  | "garment_not_found"
  | "garment_not_renderable"
  | "accessory_not_renderable"
  | "kill_switch"
  | "daily_cap"
  | "session_cap"
  | "nothing_to_render";

export type CreateRenderOutcome =
  | {
      readonly ok: true;
      /** True when the params hash already had a finished render stored. */
      readonly cached: boolean;
      readonly renderId: string;
      readonly jobId: string | null;
      readonly status: RenderStatus;
      readonly renderUrl: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: CreateRenderRefusal;
      /** Units or renders left, for the cap refusals. */
      readonly remaining?: number;
    };

export interface CreateRenderInput {
  readonly session: AppSession;
  /**
   * The parsed body of POST /api/renders: one of the kinds in
   * src/lib/shared/color-view.ts, with its own parameters. It is passed whole
   * rather than as a kind and a params pair so the two cannot come apart.
   */
  readonly request: RenderRequest;
  readonly onProviderCall?: (count: number) => void;
  readonly onCredits?: (units: number) => void;
}

/**
 * One render, worked out from the request before anything is spent: which
 * endpoint, what the parameters canonically are, and what feeds the tiered cost
 * table. Pure.
 */
type RenderPlan =
  | {
      readonly kind: "makeup";
      readonly endpointKey: "makeupTryOn";
      readonly stored: StoredMakeupParams;
      readonly itemCount: number;
    }
  | {
      readonly kind: "hairstyle";
      readonly endpointKey: "hairstyleTryOn";
      readonly stored: StoredHairstyleParams;
      readonly itemCount: number;
    }
  | {
      readonly kind: "hair_color";
      readonly endpointKey: "hairColorTryOn";
      readonly stored: StoredHairColorParams;
      readonly itemCount: number;
    }
  | {
      readonly kind: "cloth";
      readonly endpointKey: "clothTryOn";
      readonly stored: StoredClothParams;
      readonly itemCount: number;
      /** The garment photo sent as the reference image. Read once, above. */
      readonly garmentStoragePath: string;
    }
  | {
      readonly kind: "skin_simulation";
      readonly endpointKey: "skinSimulation";
      readonly stored: StoredSkinSimulationParams;
      /** Concerns projected, which is what the tiered cost is counted by. */
      readonly itemCount: number;
    }
  | {
      readonly kind: "accessory";
      /** One endpoint per category, chosen in src/lib/server/renders/accessory.ts. */
      readonly endpointKey: PerfectCorpEndpointKey;
      readonly stored: StoredAccessoryParams;
      readonly itemCount: number;
      /** The accessory photo sent as the reference image. Read once, above. */
      readonly garmentStoragePath: string;
    };

/**
 * The garment a cloth or accessory render is of, resolved before anything is
 * planned.
 *
 * It is read from the row rather than taken from the request, so the photo is
 * one this person owns. For a cloth render the category comes from the type the
 * person or the classifier recorded; for an accessory the row only says that it
 * is an accessory (the wardrobe has one type for all of them), so the category
 * is the one the person asked for on the request.
 */
interface GarmentSubject {
  readonly garmentId: string;
  readonly storagePath: string;
  readonly category: string;
}

function planRender(args: {
  readonly captureId: string;
  readonly request: RenderRequest;
  readonly cloth: GarmentSubject | null;
}): RenderPlan {
  const request = args.request;
  switch (request.kind) {
    case "makeup": {
      const stored = canonicalMakeupParams({
        captureId: args.captureId,
        params: request.params,
      });
      return {
        kind: "makeup",
        endpointKey: "makeupTryOn",
        stored,
        itemCount: stored.categories.length,
      };
    }
    case "hairstyle":
      return {
        kind: "hairstyle",
        endpointKey: "hairstyleTryOn",
        stored: canonicalHairstyleParams({
          captureId: args.captureId,
          params: request.params,
        }),
        itemCount: 1,
      };
    case "hair_color":
      return {
        kind: "hair_color",
        endpointKey: "hairColorTryOn",
        stored: canonicalHairColorParams({
          captureId: args.captureId,
          params: request.params,
        }),
        itemCount: 1,
      };
    case "cloth": {
      if (args.cloth === null) {
        // Unreachable: createRender resolves the garment before it plans, and
        // refuses when there is none. Throwing rather than inventing a category
        // keeps that guarantee visible instead of silently rendering something.
        throw new Error("A cloth render was planned without a garment.");
      }
      return {
        kind: "cloth",
        endpointKey: "clothTryOn",
        stored: canonicalClothParams({
          captureId: args.captureId,
          garmentId: args.cloth.garmentId,
          garmentCategory: args.cloth.category,
        }),
        itemCount: 1,
        garmentStoragePath: args.cloth.storagePath,
      };
    }
    case "skin_simulation": {
      const stored = canonicalSimulationParams({
        captureId: args.captureId,
        concerns: request.params.concerns,
      });
      return {
        kind: "skin_simulation",
        endpointKey: "skinSimulation",
        stored,
        // The tiered row in the credit table is counted by concerns simulated.
        itemCount: stored.concerns.length,
      };
    }
    case "accessory": {
      if (args.cloth === null) {
        // Unreachable, for the same reason as the cloth branch above.
        throw new Error("An accessory render was planned without a garment.");
      }
      return {
        kind: "accessory",
        endpointKey: accessoryEndpointFor(request.params.category),
        stored: canonicalAccessoryParams({
          captureId: args.captureId,
          garmentId: args.cloth.garmentId,
          category: request.params.category,
        }),
        itemCount: 1,
        garmentStoragePath: args.cloth.storagePath,
      };
    }
  }
}

/**
 * The request body for a plan, or null when there is nothing to render: no
 * makeup category survived the mapping, the style has no provider template
 * (src/lib/server/renders/hair.ts), or the garment photo never reached the
 * provider.
 */
function taskBodyFor(
  plan: RenderPlan,
  fileId: string,
  referenceFileId: string | null,
): Record<string, unknown> | null {
  switch (plan.kind) {
    case "makeup":
      return makeupTaskBody({ fileId, params: plan.stored });
    case "hairstyle":
      return hairstyleTaskBody({ fileId, params: plan.stored });
    case "hair_color":
      return hairColorTaskBody({ fileId, params: plan.stored });
    case "cloth":
      return referenceFileId === null
        ? null
        : clothTaskBody({ fileId, referenceFileId, params: plan.stored });
    case "skin_simulation":
      return simulationTaskBody({ fileId, params: plan.stored });
    case "accessory":
      return referenceFileId === null
        ? null
        : accessoryTaskBody({ fileId, referenceFileId, params: plan.stored });
  }
}

async function signRender(render: Render): Promise<string | null> {
  if (render.storage_path === null) {
    return null;
  }
  try {
    return await createSignedRead(BUCKETS.renders, render.storage_path);
  } catch {
    return null;
  }
}

/**
 * Starts a try on, or returns the one that already exists.
 *
 * The order of the gates, and why:
 * 1. the profile and the original photo, so a request with nothing to render on
 *    costs nothing
 * 2. the params hash, so a shade or a style the person has already seen never
 *    spends a second credit (docs/03-architecture.md, "Caching")
 * 3. the key, the endpoint verification, and the kill switch, which are all
 *    answered from cache above and refused here
 * 4. one open render per person, then the judge render cap
 * 5. the credit reservation, last, immediately before the provider call
 */
export async function createRender(
  input: CreateRenderInput,
): Promise<CreateRenderOutcome> {
  const ownerId = input.session.id;
  const kind = input.request.kind;

  const profile = await getAestheticProfile(ownerId);
  if (profile === null || profile.capture_id === null) {
    return { ok: false, reason: "no_profile" };
  }

  const capture = await getCapture(ownerId, profile.capture_id);
  if (capture === null || capture.storage_path === null) {
    // The session that made this capture has ended and the scheduled purge took
    // the original with it (docs/06-safety-privacy.md, "Retention"). There is no
    // face to render on, so the person takes a new photo.
    return { ok: false, reason: "no_capture_image" };
  }

  // The garment, before anything is planned or spent. An id that is not this
  // person's, or one nobody has classified, costs nothing and renders nothing:
  // the category comes from the recorded type, never from a guess about an
  // unread photo (src/lib/server/renders/cloth.ts).
  let cloth: GarmentSubject | null = null;
  if (input.request.kind === "cloth") {
    const garment = await getGarment(ownerId, input.request.params.garmentId);
    if (garment === null) {
      return { ok: false, reason: "garment_not_found" };
    }
    const category = clothCategoryForType(garment.type);
    if (category === null) {
      return { ok: false, reason: "garment_not_renderable" };
    }
    cloth = {
      garmentId: garment.id,
      storagePath: garment.storage_path,
      category,
    };
  }

  // The accessory, on the same terms. The wardrobe records every accessory under
  // one type, so the row is only asked whether the photo is an accessory at all
  // (src/lib/server/renders/accessory.ts); which accessory it is worn as is the
  // category on the request. A photo of a shirt sent as a pair of earrings is
  // refused here, before anything is uploaded.
  if (input.request.kind === "accessory") {
    const garment = await getGarment(ownerId, input.request.params.garmentId);
    if (garment === null) {
      return { ok: false, reason: "garment_not_found" };
    }
    if (!isAccessoryGarmentType(garment.type)) {
      return { ok: false, reason: "accessory_not_renderable" };
    }
    cloth = {
      garmentId: garment.id,
      storagePath: garment.storage_path,
      category: input.request.params.category,
    };
  }

  const plan = planRender({
    captureId: capture.id,
    request: input.request,
    cloth,
  });
  const stored: StoredRenderParams = plan.stored;
  const hash = paramsHash(kind, stored);

  const existing = await findRenderByHash({
    ownerId,
    kind,
    paramsHash: hash,
  });

  if (existing !== null && existing.status === "succeeded") {
    return {
      ok: true,
      cached: true,
      renderId: existing.id,
      jobId: null,
      status: "succeeded",
      renderUrl: await signRender(existing),
    };
  }

  if (
    existing !== null &&
    (existing.status === "pending" || existing.status === "running")
  ) {
    // Idempotency, the same rule the analysis jobs follow: asking again for a
    // render that is already running returns the running one.
    const job = await findJobForSubject(ownerId, existing.id);
    return {
      ok: true,
      cached: false,
      renderId: existing.id,
      jobId: job?.id ?? null,
      status: existing.status,
      renderUrl: null,
    };
  }

  if (!isPerfectCorpConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  if (!isRenderEndpointCallable(plan.endpointKey)) {
    // A guessed path or a guessed payload is not a try on. The screen shows the
    // unedited selfie and says the preview is unavailable, which is true.
    return { ok: false, reason: "endpoint_unverified" };
  }
  if (
    plan.kind === "hairstyle" &&
    hairstyleTemplateFor(plan.stored.styleId) === null
  ) {
    // The endpoint is confirmed but the template catalog is not, so there is no
    // id to send. Refused here rather than after a reservation, because nothing
    // was ever going to be rendered.
    return { ok: false, reason: "style_not_renderable" };
  }
  if (!providerCallsEnabled()) {
    return { ok: false, reason: "kill_switch" };
  }

  if ((await countOpenRenders(ownerId)) > 0) {
    return { ok: false, reason: "render_in_progress" };
  }

  if (input.session.kind === "judge") {
    const used = await countRenders(ownerId);
    if (used >= JUDGE_RENDERS_ALLOWED) {
      return {
        ok: false,
        reason: "judge_render_limit",
        remaining: 0,
      };
    }
  }

  // A failed row is reused rather than replaced: (user_id, kind, params_hash) is
  // unique, so the retry is the same row moving back to pending.
  const render =
    existing ??
    (await insertRender({
      user_id: ownerId,
      kind,
      params: stored as unknown as Json,
      params_hash: hash,
      status: "pending",
    }));
  if (existing !== null) {
    await updateRender(render.id, {
      status: "pending",
      params: stored as unknown as Json,
      provider_task_id: null,
      credits_used: 0,
    });
  }

  const units = renderUnits(plan.endpointKey, plan.itemCount);
  const reservation = await reserve({
    session: input.session,
    provider: "perfectcorp",
    units,
    subjectId: render.id,
    note: `reserve ${kind} render`,
  });
  if (!reservation.ok) {
    if (existing === null) {
      await deleteRender(ownerId, render.id);
    }
    return {
      ok: false,
      reason: reservation.reason === "session_cap" ? "session_cap" : "daily_cap",
      remaining: reservation.remaining,
    };
  }
  input.onCredits?.(reservation.reservation.units);

  try {
    const object = await downloadObject(BUCKETS.captures, capture.storage_path);
    const uploaded = await uploadImage({
      fileName: `${capture.id}.${object.contentType === "image/png" ? "png" : "jpg"}`,
      contentType: object.contentType === "image/png" ? "image/png" : "image/jpeg",
      bytes: object.bytes,
    });
    input.onProviderCall?.(1);

    // A cloth or accessory try on takes a second image: the person's own photo
    // of the piece, sent as the reference it is copied from
    // (docs/04-integrations.md, the cloth-v4 and 2d-vto request shapes). It is
    // uploaded after the capture so a failure here lands in the same catch and
    // refunds the same reservation.
    let referenceFileId: string | null = null;
    if (plan.kind === "cloth" || plan.kind === "accessory") {
      const garmentObject = await downloadObject(
        BUCKETS.garments,
        plan.garmentStoragePath,
      );
      const isPng = garmentObject.contentType === "image/png";
      const uploadedGarment = await uploadImage({
        fileName: `${plan.stored.garmentId}.${isPng ? "png" : "jpg"}`,
        contentType: isPng ? "image/png" : "image/jpeg",
        bytes: garmentObject.bytes,
      });
      input.onProviderCall?.(1);
      referenceFileId = uploadedGarment.fileId;
    }

    const body = taskBodyFor(plan, uploaded.fileId, referenceFileId);
    if (body === null) {
      await refund({ session: input.session, reservation: reservation.reservation });
      if (existing === null) {
        await deleteRender(ownerId, render.id);
      }
      return { ok: false, reason: "nothing_to_render" };
    }

    const task = await createTask({
      endpointKey: plan.endpointKey,
      body,
      itemCount: plan.itemCount,
    });
    input.onProviderCall?.(1);

    await updateRender(render.id, {
      status: "running",
      provider_task_id: task.taskId,
      credits_used: reservation.reservation.units,
    });

    const previous = await findJobForSubject(ownerId, render.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const job =
      previous === null
        ? await insertJob({
            user_id: ownerId,
            subject_type: "render",
            subject_id: render.id,
            status: "running",
            provider_task_id: task.taskId,
            attempts,
          })
        : // The row is reused, so its lifetime has to start again with the task
          // it now points at. Without the created_at, a second try on later in
          // the same session is failed as a timeout on its first poll.
          ((await updateJob(previous.id, {
            status: "running",
            provider_task_id: task.taskId,
            attempts,
            error: null,
            last_polled_at: null,
            created_at: new Date().toISOString(),
          })) ?? previous);

    console.log(
      JSON.stringify({
        event: "aurum.render_started",
        ownerType: input.session.ownerType,
        ownerId,
        kind,
        renderId: render.id,
        // How much was asked for, in the terms of the kind. No shade name, no
        // colour name, no style name: a log line is not a place for copy.
        items: plan.itemCount,
        units: reservation.reservation.units,
      }),
    );

    return {
      ok: true,
      cached: false,
      renderId: render.id,
      jobId: job.id,
      status: "running",
      renderUrl: null,
    };
  } catch (thrown) {
    // Nothing was rendered, so nothing is owed. The row goes back to failed with
    // the same sentence the analysis jobs use, and the route reports the
    // provider failure.
    await refund({ session: input.session, reservation: reservation.reservation });
    await updateRender(render.id, {
      status: "failed",
      provider_task_id: null,
      credits_used: 0,
    });
    await writeRenderJobFailure({
      ownerId,
      renderId: render.id,
      message: messageForFailure(thrown),
    });
    throw thrown;
  }
}

/** Records the failure on the job row, creating one if the task never started. */
async function writeRenderJobFailure(args: {
  readonly ownerId: string;
  readonly renderId: string;
  readonly message: string;
}): Promise<void> {
  const existing = await findJobForSubject(args.ownerId, args.renderId);
  if (existing === null) {
    await insertJob({
      user_id: args.ownerId,
      subject_type: "render",
      subject_id: args.renderId,
      status: "failed",
      attempts: 1,
      error: args.message,
    });
    return;
  }
  await updateJob(existing.id, {
    status: "failed",
    error: args.message,
    attempts: existing.attempts + 1,
  });
}

// ---------------------------------------------------------------------------
// Read and poll
// ---------------------------------------------------------------------------

function viewOf(
  render: Render,
  renderUrl: string | null,
  job: JobRecord | null,
): RenderView {
  return {
    renderId: render.id,
    status: render.status,
    renderUrl,
    error: render.status === "failed" ? (job?.error ?? messages.providerRefused) : null,
  };
}

export interface PollRenderInput {
  readonly session: AppSession;
  readonly renderId: string;
  readonly onProviderCall?: (count: number) => void;
}

/**
 * One pass over one render.
 *
 * Returns null when the id is not this person's, which the route answers with a
 * 404. Nothing here waits on the provider for more than one HTTP call, so the
 * client's poll returns in time and Vercel function timeouts stay irrelevant.
 */
export async function pollRender(
  input: PollRenderInput,
): Promise<RenderView | null> {
  const ownerId = input.session.id;
  const render = await getRender(ownerId, input.renderId);
  if (render === null) {
    return null;
  }

  if (render.status === "succeeded") {
    return viewOf(render, await signRender(render), null);
  }

  const job = await findJobForSubject(ownerId, render.id);
  if (render.status === "failed") {
    return viewOf(render, null, job);
  }
  if (job === null || job.provider_task_id === null) {
    return viewOf(render, null, job);
  }

  if (Date.now() - Date.parse(job.created_at) > JOB_LIFETIME_MS) {
    await failRender({
      session: input.session,
      render,
      job,
      message: copy.errors.providerTimeout,
    });
    return {
      renderId: render.id,
      status: "failed",
      renderUrl: null,
      error: copy.errors.providerTimeout,
    };
  }

  // The kill switch stops the provider call, not the answer: a render already
  // stored still serves, and a running one stays running.
  if (!providerCallsEnabled() || !isPerfectCorpConfigured()) {
    return viewOf(render, null, job);
  }

  // A stored render this build cannot resolve an endpoint for (an accessory row
  // whose params carry a category we no longer send) is left exactly as it is
  // rather than failed or polled on a guess. The job lifetime check above still
  // ends it, so nothing runs forever.
  const endpointKey = endpointForStoredRender(render);
  if (endpointKey === null) {
    return viewOf(render, null, job);
  }

  if (!(await claimForPolling(job))) {
    return viewOf(render, null, job);
  }

  try {
    const snapshot = await getTaskSnapshot({
      endpointKey,
      taskId: job.provider_task_id,
    });
    input.onProviderCall?.(1);

    if (snapshot.state === "succeeded") {
      const finished = await succeedRender({
        session: input.session,
        render,
        job,
        urls: parseRenderUrls(snapshot),
      });
      return finished;
    }

    if (snapshot.state === "failed") {
      await failRender({
        session: input.session,
        render,
        job,
        message: messages.providerRefused,
      });
      return {
        renderId: render.id,
        status: "failed",
        renderUrl: null,
        error: messages.providerRefused,
      };
    }

    return viewOf(render, null, job);
  } catch (thrown) {
    const message = messageForFailure(thrown);
    await failRender({ session: input.session, render, job, message });
    return {
      renderId: render.id,
      status: "failed",
      renderUrl: null,
      error: message,
    };
  }
}

/**
 * Pulls the finished image into the private renders bucket.
 *
 * docs/04-integrations.md, step 5: "Download mask and render outputs promptly
 * (result URLs may expire) and store them in our private buckets." A download
 * that fails is a failed render, not a render pointing at a URL that will stop
 * working.
 */
async function succeedRender(args: {
  readonly session: AppSession;
  readonly render: Render;
  readonly job: JobRecord;
  readonly urls: readonly string[];
}): Promise<RenderView> {
  const url = args.urls[0];
  if (url === undefined) {
    await failRender({
      session: args.session,
      render: args.render,
      job: args.job,
      message: messages.providerRefused,
    });
    return {
      renderId: args.render.id,
      status: "failed",
      renderUrl: null,
      error: messages.providerRefused,
    };
  }

  let storagePath: string;
  try {
    const [asset] = await downloadResultAssets([url]);
    /*
     * The type is decided here, not taken from the provider's own header. The
     * live makeup try on serves its finished render from S3 as
     * "binary/octet-stream", which the renders bucket refuses (migration 0006
     * allows three image types), so the upload failed with "mime type
     * binary/octet-stream is not supported" on a task that had already run and
     * already been charged, and the screen said the preview was unavailable
     * while the picture sat in the response. src/lib/shared/image-type.ts reads
     * the URL when the header says nothing we can store.
     */
    const image = storedImageType(asset.contentType, url);
    storagePath = await uploadObject({
      bucket: BUCKETS.renders,
      storagePath: renderPath(args.session.id, args.render.id, image.extension),
      bytes: asset.bytes,
      contentType: image.contentType,
    });
  } catch (thrown) {
    const message = messageForFailure(thrown);
    await failRender({
      session: args.session,
      render: args.render,
      job: args.job,
      message,
    });
    return {
      renderId: args.render.id,
      status: "failed",
      renderUrl: null,
      error: message,
    };
  }

  const reservation = await findReservation({
    owner: { ownerType: args.session.ownerType, ownerId: args.session.id },
    subjectId: args.render.id,
    provider: "perfectcorp",
  });
  const units = reservation?.units ?? args.render.credits_used;
  if (reservation !== null) {
    await reconcile({
      session: args.session,
      reservation,
      actualUnits: reservation.units,
    });
  }

  const updated =
    (await updateRender(args.render.id, {
      status: "succeeded",
      storage_path: storagePath,
      credits_used: units,
    })) ?? args.render;
  await updateJob(args.job.id, { status: "succeeded", error: null });

  console.log(
    JSON.stringify({
      event: "aurum.render_succeeded",
      ownerType: args.session.ownerType,
      ownerId: args.session.id,
      kind: args.render.kind,
      renderId: args.render.id,
      units,
    }),
  );

  return {
    renderId: args.render.id,
    status: "succeeded",
    renderUrl: await signRender({ ...updated, storage_path: storagePath }),
    error: null,
  };
}

/**
 * A failed render costs nothing: "If the engine fails to process the task, the
 * task's status will change to 'error' and no unit will be consumed"
 * (docs/04-integrations.md), so the reservation goes back.
 */
async function failRender(args: {
  readonly session: AppSession;
  readonly render: Render;
  readonly job: JobRecord;
  readonly message: string;
}): Promise<void> {
  const reservation = await findReservation({
    owner: { ownerType: args.session.ownerType, ownerId: args.session.id },
    subjectId: args.render.id,
    provider: "perfectcorp",
  });
  if (reservation !== null) {
    await refund({ session: args.session, reservation });
  }
  await updateRender(args.render.id, { status: "failed", credits_used: 0 });
  await updateJob(args.job.id, {
    status: "failed",
    error: args.message,
    attempts: args.job.attempts,
  });
}

// ---------------------------------------------------------------------------
// What the Layer 6 screens ask the render layer before they draw
// ---------------------------------------------------------------------------

/**
 * The projection row on /report, docs/09-build-order-and-demo.md Layer 6.
 *
 * Three fields, and between them the row draws itself:
 * - renderUrl: a projection that already exists, signed for this request
 * - canRender: whether asking for one would actually produce a picture
 * - concerns: which concerns it covers, so the row can name them
 *
 * With no key, no database, an unverified endpoint, the kill switch off, or the
 * original photo already deleted, both of the first two are empty and the row
 * does not render at all. That is deliberate: a dead button in a demo is a
 * promise the build cannot keep.
 */
export type ProjectionState = {
  readonly renderUrl: string | null;
  readonly canRender: boolean;
  readonly concerns: readonly SimulatableConcernKey[];
};

export async function readProjection(args: {
  readonly session: AppSession;
  /** The report's own ranking, tone first (src/lib/shared/concerns.ts). */
  readonly rankedConcernKeys: readonly string[];
}): Promise<ProjectionState> {
  const concerns = simulationConcernsFor(args.rankedConcernKeys);
  const none: ProjectionState = {
    renderUrl: null,
    canRender: false,
    concerns,
  };

  // Fixture mode has no database and no key, so there is nothing stored and
  // nothing that could be asked for.
  if (concerns.length === 0 || isDemoFixtureMode() || !isSupabaseConfigured()) {
    return none;
  }

  try {
    const profile = await getAestheticProfile(args.session.id);
    if (profile === null || profile.capture_id === null) {
      return none;
    }

    const hash = paramsHash(
      "skin_simulation",
      canonicalSimulationParams({
        captureId: profile.capture_id,
        concerns,
      }),
    );
    const existing = await findRenderByHash({
      ownerId: args.session.id,
      kind: "skin_simulation",
      paramsHash: hash,
    });
    if (existing !== null && existing.status === "succeeded") {
      return { renderUrl: await signRender(existing), canRender: false, concerns };
    }

    // Nothing stored, so the row is only worth drawing if a request would work.
    // The original photo is the last gate: it lives for the length of the
    // session and there is no face to project without it.
    const capture = await getCapture(args.session.id, profile.capture_id);
    const canRender =
      capture !== null &&
      capture.storage_path !== null &&
      isPerfectCorpConfigured() &&
      providerCallsEnabled() &&
      isRenderEndpointCallable("skinSimulation");
    return { renderUrl: null, canRender, concerns };
  } catch {
    // A read that failed is not a projection. The row disappears rather than
    // offering something that cannot be produced.
    return none;
  }
}

/**
 * One accessory the person owns, offered in one category, for the top look on
 * /looks (docs/09-build-order-and-demo.md Layer 6).
 *
 * The list is empty in fixture mode, with no key, with the kill switch off, with
 * no accessory in the wardrobe, and when no accessory endpoint is callable,
 * which is every one of them today except the watch. An empty list draws no
 * affordance at all.
 */
export type AccessoryTryOnOption = {
  readonly garmentId: string;
  readonly category: AccessoryCategory;
};

export async function accessoryTryOnOptions(
  session: AppSession,
): Promise<AccessoryTryOnOption[]> {
  if (
    isDemoFixtureMode() ||
    !isSupabaseConfigured() ||
    !isPerfectCorpConfigured() ||
    !providerCallsEnabled()
  ) {
    return [];
  }

  const categories = callableAccessoryCategories(isRenderEndpointCallable);
  if (categories.length === 0) {
    return [];
  }

  try {
    const profile = await getAestheticProfile(session.id);
    if (profile === null || profile.capture_id === null) {
      return [];
    }
    const capture = await getCapture(session.id, profile.capture_id);
    if (capture === null || capture.storage_path === null) {
      return [];
    }

    // The newest accessory in the wardrobe, which is the one the person most
    // likely just added (listGarments is newest first). One accessory at a time:
    // the try on puts a single item on the person, and offering a list of them
    // would be a wardrobe screen, not a slot on a look.
    const garments = await listGarments(session.id);
    const accessory = garments.find((garment) =>
      isAccessoryGarmentType(garment.type),
    );
    if (accessory === undefined) {
      return [];
    }
    return categories.map((category) => ({
      garmentId: accessory.id,
      category,
    }));
  } catch {
    return [];
  }
}

export type {
  StoredAccessoryParams,
  StoredClothParams,
  StoredHairColorParams,
  StoredHairstyleParams,
  StoredMakeupParams,
  StoredRenderParams,
  StoredSkinSimulationParams,
};
