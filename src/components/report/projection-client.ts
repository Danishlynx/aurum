/**
 * The browser side of the one route the projection row calls.
 *
 * It lives beside the screen for the same reason
 * src/components/hair/renders-client.ts does, and follows the same rules: every
 * response is parsed with zod before it reaches a component, and no sentence a
 * person reads is ever taken from a response body. A failure here becomes
 * copy.report.projectionUnavailable, chosen by the row.
 *
 * Routes, docs/09-build-order-and-demo.md Layer 6 and docs/03-architecture.md
 * "Jobs":
 *
 *   POST /api/renders        { kind: "skin_simulation", params: { concerns } }
 *   GET  /api/renders/{id}   that render as it stands, while polled
 *
 * A render that has not succeeded has no image, and this module never invents
 * one: renderUrl is present only on a succeeded render, so the row can only ever
 * draw a real projection of the person's own capture.
 */

import { z } from "zod";

import { httpUrlSchema } from "@/lib/shared/schemas";

const renderStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);

export type RenderStatus = z.infer<typeof renderStatusSchema>;

/**
 * A signed URL for the render, or nothing. It is checked as an http URL because
 * the row puts it in an image source and it arrives over the network.
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
   * Anything that did not produce a render: no key on the server (503), the
   * unverified skin simulation endpoint (503), a cap (429), fixture mode, a
   * schema that did not match, or no network. The row shows the same documented
   * line for all of them, because from the person's side they are one thing:
   * there is no projection.
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
 * Starts the projection for the concerns the report ranked highest, or returns
 * the stored one when the same concerns were projected before
 * (docs/03-architecture.md, "Caching").
 */
export async function requestSimulationRender(
  concerns: readonly string[],
): Promise<RenderResult> {
  let response: Response;
  try {
    response = await fetch("/api/renders", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "skin_simulation",
        params: { concerns: [...concerns] },
      }),
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
