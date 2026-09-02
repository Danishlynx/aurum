/**
 * The browser side of the try on routes /makeup calls.
 *
 * It lives beside the screen rather than in src/lib/client/api.ts because these
 * are the makeup screen's own calls. The rules are api.ts's rules: every
 * response is parsed with zod before it reaches a component, and no sentence a
 * person reads is ever taken from a response body. A failure here becomes the
 * documented "Preview unavailable for this shade." line, chosen by the screen.
 *
 * Routes, docs/01-user-flow.md section H and docs/03-architecture.md "Jobs":
 *
 *   POST /api/renders          starts (or returns from cache) a try on render
 *   GET  /api/renders/{id}     the render as it stands, polled while running
 *   POST /api/profile/makeup   saves the selected shades to the profile
 *
 * A render that has not succeeded has no image, and this module never invents
 * one: renderUrl is present only on a succeeded render, so the screen can only
 * ever draw the person's own photo or a real render of it.
 */

import { z } from "zod";

import { httpUrlSchema } from "@/lib/shared/schemas";

import type { RenderCategoryParam } from "./makeup-content";

/** The four job statuses from src/lib/shared/schemas.ts, as a render reports them. */
const renderStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);

export type RenderStatus = z.infer<typeof renderStatusSchema>;

/**
 * A signed URL for the render, or nothing. It is checked as an http URL because
 * the screen puts it in an image source and it arrives over the network.
 */
const renderUrlSchema = httpUrlSchema.nullable().optional();

const renderStartSchema = z.object({
  renderId: z.string().min(1),
  jobId: z.string().min(1).nullable().optional(),
  status: renderStatusSchema,
  renderUrl: renderUrlSchema,
});

const renderPollSchema = z.object({
  renderId: z.string().min(1),
  status: renderStatusSchema,
  renderUrl: renderUrlSchema,
  /** For the log and the network tab. Never shown to a person. */
  error: z.string().nullable().optional(),
});

export type RenderState = {
  readonly renderId: string;
  readonly status: RenderStatus;
  /** Present only on a succeeded render. */
  readonly renderUrl: string | null;
};

export type RenderResult =
  | { readonly ok: true; readonly render: RenderState }
  /**
   * Anything that did not produce a render: no key on the server (503), a cap
   * (429), consent missing (403), a schema that did not match, or no network.
   * The screen shows the same documented line for all of them, because from the
   * person's side they are one thing: there is no preview.
   */
  | { readonly ok: false };

async function readJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Starts a makeup try on for the whole look, or returns the stored render when
 * the same parameters were rendered before (docs/03-architecture.md, "Caching":
 * "Re selecting a shade or style returns the stored render").
 */
export async function requestMakeupRender(
  categories: readonly RenderCategoryParam[],
): Promise<RenderResult> {
  let response: Response;
  try {
    response = await fetch("/api/renders", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "makeup", params: { categories } }),
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    return { ok: false };
  }

  const parsed = renderStartSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false };
  }
  return {
    ok: true,
    render: {
      renderId: parsed.data.renderId,
      status: parsed.data.status,
      renderUrl: parsed.data.renderUrl ?? null,
    },
  };
}

/** The render as it stands. Polled while it is pending or running. */
export async function fetchRender(renderId: string): Promise<RenderResult> {
  let response: Response;
  try {
    response = await fetch(`/api/renders/${encodeURIComponent(renderId)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    return { ok: false };
  }

  const parsed = renderPollSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false };
  }
  return {
    ok: true,
    render: {
      renderId: parsed.data.renderId,
      status: parsed.data.status,
      renderUrl: parsed.data.renderUrl ?? null,
    },
  };
}

/**
 * "Save this look", docs/01-user-flow.md section H item 4: the selected shades
 * are saved to the profile.
 *
 * POST /api/profile/makeup takes the same category list the render takes and
 * stores it on the profile row (migration 0013), so the next visit opens on
 * these shades and the try on they were rendered with is the one the hero shows.
 * A judge session reading the demo profile gets 403 and the screen says the look
 * was not saved, which is true of it.
 *
 * Only the status is read. The body is not parsed into anything the screen
 * shows, so there is nothing here for a schema to guard.
 */
export async function saveMakeupLook(
  categories: readonly RenderCategoryParam[],
): Promise<boolean> {
  try {
    const response = await fetch("/api/profile/makeup", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categories }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
