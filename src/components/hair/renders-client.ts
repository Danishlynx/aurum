/**
 * The browser side of the routes /hair calls.
 *
 * It lives beside the screen for the same reason
 * src/components/makeup/renders-client.ts does, and follows the same rules:
 * every response is parsed with zod before it reaches a component, and no
 * sentence a person reads is ever taken from a response body. A failure here
 * becomes one of the documented "Preview unavailable" lines, chosen by the
 * screen.
 *
 * Routes, docs/01-user-flow.md section I and docs/03-architecture.md "Jobs":
 *
 *   POST /api/renders            starts (or returns from cache) a try on render
 *   GET  /api/renders/{id}       the render as it stands, polled while running
 *   POST /api/profile/hair/save  saves the chosen style and color
 *
 * Two render kinds, both with the same response shape, the same params hash
 * cache, and the same caps as the makeup render:
 *
 *   { kind: "hairstyle",  params: { styleId } }
 *   { kind: "hair_color", params: { styleId, colorHex, colorName } }
 *
 * A render that has not succeeded has no image, and this module never invents
 * one: renderUrl is present only on a succeeded render, so the screen can only
 * ever draw the person's own photo or a real render of it.
 */

import { z } from "zod";

import { httpUrlSchema } from "@/lib/shared/schemas";

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
   * Anything that did not produce a render: no key on the server (503), an
   * unverified endpoint the client refuses (the hair color try on, until
   * docs/04-integrations.md records it), a cap (429), consent missing (403), a
   * schema that did not match, or no network. The screen shows the same
   * documented line for all of them, because from the person's side they are one
   * thing: there is no preview.
   */
  | { readonly ok: false };

async function readJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function startRender(body: unknown): Promise<RenderResult> {
  let response: Response;
  try {
    response = await fetch("/api/renders", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

/**
 * The hairstyle try on for one style, or the stored render when the same style
 * was rendered before (docs/03-architecture.md, "Caching": "Re selecting a shade
 * or style returns the stored render").
 */
export function requestHairstyleRender(params: {
  readonly styleId: string;
}): Promise<RenderResult> {
  return startRender({ kind: "hairstyle", params });
}

/**
 * The hair color try on, applied to the selected style, which is why the style
 * id travels with the color (docs/01 section I item 3: the colors are "rendered
 * on the selected style").
 */
export function requestHairColorRender(params: {
  readonly styleId: string;
  readonly colorHex: string;
  readonly colorName: string;
}): Promise<RenderResult> {
  return startRender({ kind: "hair_color", params });
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
 * What POST /api/profile/hair/save answered.
 *
 * "read_only" is the 403 the route returns for the saved demo profile, which
 * nobody may write to (docs/01-user-flow.md, "Judge mode across the flow"). It
 * is kept apart from a plain failure so the screen can say which of the two
 * happened instead of guessing.
 */
export type HairSaveResult = "saved" | "read_only" | "failed";

/**
 * "Save this", docs/01-user-flow.md section I item 4: the chosen style and color
 * are saved to the profile.
 *
 * colorName is null when no color has been chosen, which is a style saved on its
 * own. Only the status is read. The body is not parsed into anything the screen
 * shows, so there is nothing here for a schema to guard.
 */
export async function saveHairChoice(body: {
  readonly styleId: string;
  readonly colorName: string | null;
}): Promise<HairSaveResult> {
  try {
    const response = await fetch("/api/profile/hair/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return "saved";
    }
    return response.status === 403 ? "read_only" : "failed";
  } catch {
    return "failed";
  }
}
