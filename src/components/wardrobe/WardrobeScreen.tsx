"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Column } from "@/components/layout/Column";
import { ButtonLink } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import {
  CAPTURE_JPEG_QUALITY,
  CAPTURE_LONG_EDGE,
  decodeImageFile,
  drawToCanvas,
  toJpegBlob,
} from "@/lib/client/image";
import { copy } from "@/lib/shared/copy";
import type {
  GarmentFormality,
  GarmentPatchRequest,
  GarmentPattern,
  GarmentType,
  GarmentView,
  WardrobeView,
} from "@/lib/shared/wardrobe-view";

import { AddGarments } from "./AddGarments";
import { GarmentCard } from "./GarmentCard";
import { GarmentPicker } from "./GarmentPicker";
import { TypeFilterRow } from "./TypeFilterRow";
import {
  ALL_TYPES,
  filterByType,
  showsCorrectHint,
  showsSuggestAction,
  showsTypeFilter,
  typeFilterOptions,
  type TypeFilter,
} from "./wardrobe-content";
import {
  classifyGarment,
  createGarmentSlots,
  fetchWardrobe,
  patchGarment,
  uploadGarmentImage,
  type WardrobeFailure,
} from "./wardrobe-client";

/**
 * J. Wardrobe, docs/01-user-flow.md section J: the empty state, the add flow,
 * and the grid of garment cards filterable by type.
 *
 * This is the only client component on the screen, because everything here is a
 * tap: picking photos, filtering, correcting a chip. The grid it opens on was
 * built on the server.
 *
 * The add flow, in the order it happens (docs/03-architecture.md, "Request flow
 * for a capture", which a garment photo follows step for step):
 *
 * 1. The person multi selects from the camera roll.
 * 2. POST /api/garments claims one row and one signed upload slot per photo.
 * 3. Each photo is decoded with its orientation applied, drawn to a canvas at a
 *    1024px long edge, and re encoded as JPEG. A canvas holds pixels only, so
 *    EXIF, GPS, and device metadata are gone by construction. The bytes go
 *    straight to storage; they never pass through this app's server.
 * 4. The grid is re read, so the new cards appear with the dimmed image and the
 *    skeleton pills the doc describes.
 * 5. Each garment is classified in turn, and the grid is re read after each one,
 *    which is what makes the chips fill in "one by one as results arrive".
 *
 * Nothing here invents a chip. A classification that was refused (no key, a cap,
 * the kill switch) leaves the row empty and the job failed, and the card then
 * carries "Could not read this one. Tap to fill in details." That is the whole
 * fallback: docs/03-architecture.md gives the stylist a deterministic fallback
 * and gives the classifier none, on purpose.
 *
 * Fixture mode: the checked in wardrobe renders in full and every write answers
 * 403, which becomes the read only line rather than a claim that something was
 * saved.
 */

type WardrobeScreenProps = {
  readonly view: WardrobeView;
  /**
   * True when the app is serving the saved demo profile, which nobody may write
   * to. It decides which sentence a refused write gets, so the screen never
   * blames the demo profile for an ordinary failure and never tells a person a
   * correction was stored when it was not.
   */
  readonly readOnly: boolean;
};

/**
 * A card standing in for a photo that is on its way up, before its row exists to
 * be read back. It is a real GarmentView in the pending state, so the same card
 * component draws it and there is no second placeholder to keep in step.
 */
function placeholderGarments(count: number): GarmentView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `pending-${index}`,
    imageUrl: null,
    type: null,
    colors: [],
    pattern: null,
    formality: null,
    userEdited: false,
    classificationStatus: "pending" as const,
  }));
}

/**
 * One garment photo, ready to upload: oriented, downscaled, re encoded. Null
 * when the browser could not read the file, which the caller reports once for
 * the whole pick rather than per photo.
 */
async function encodeGarmentPhoto(file: File): Promise<Blob | null> {
  try {
    const decoded = await decodeImageFile(file);
    const canvas = drawToCanvas(decoded.source, decoded.size, CAPTURE_LONG_EDGE);
    decoded.release();
    return await toJpegBlob(canvas, CAPTURE_JPEG_QUALITY);
  } catch {
    return null;
  }
}

export function WardrobeScreen({ view, readOnly }: WardrobeScreenProps) {
  const [garments, setGarments] = useState<GarmentView[]>(view.garments);
  const [filter, setFilter] = useState<TypeFilter>(ALL_TYPES);
  /** How many placeholder cards to draw while photos are on their way up. */
  const [uploading, setUploading] = useState(0);
  /** True for the whole add flow, including the classifications after it. */
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * The sentence for a refusal. The demo profile's 403 is the only one this
   * screen can name, and only when it is actually serving the demo profile: in
   * an ordinary session a 403 is missing consent, which is a different thing.
   */
  const messageFor = useCallback(
    (failure: WardrobeFailure, fallback: string): string => {
      if (failure === "full") {
        return copy.wardrobe.full;
      }
      if (failure === "read_only" && readOnly) {
        return copy.wardrobe.readOnly;
      }
      return fallback;
    },
    [readOnly],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const result = await fetchWardrobe();
    if (!mountedRef.current || !result.ok) {
      return;
    }
    setGarments(result.data.garments);
  }, []);

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (busy || files.length === 0) {
        return;
      }
      setBusy(true);
      setUploading(files.length);

      const created = await createGarmentSlots(files.length);
      if (!mountedRef.current) {
        return;
      }
      if (!created.ok) {
        setUploading(0);
        setBusy(false);
        setToast(messageFor(created.failure, copy.wardrobe.addFailed));
        return;
      }

      let anyFailed = false;
      const uploaded: string[] = [];
      for (const [index, slot] of created.data.slots.entries()) {
        const file = files[index];
        if (file === undefined) {
          continue;
        }
        const blob = await encodeGarmentPhoto(file);
        if (blob === null || !(await uploadGarmentImage(slot.uploadUrl, blob))) {
          anyFailed = true;
          continue;
        }
        uploaded.push(slot.garmentId);
      }
      if (!mountedRef.current) {
        return;
      }

      // The rows exist now, so the real cards carry the pending state and the
      // placeholders would be a second copy of the same photos.
      await refresh();
      if (!mountedRef.current) {
        return;
      }
      setUploading(0);

      for (const garmentId of uploaded) {
        await classifyGarment(garmentId);
        if (!mountedRef.current) {
          return;
        }
        // Re read after each one, which is what fills the chips in one by one
        // (docs/01-user-flow.md section J, "States"). A refused classification
        // needs no line of its own: the card says so itself.
        await refresh();
        if (!mountedRef.current) {
          return;
        }
      }

      setBusy(false);
      if (anyFailed) {
        setToast(copy.wardrobe.addFailed);
      }
    },
    [busy, messageFor, refresh],
  );

  const applyPatch = useCallback(
    async (patch: GarmentPatchRequest): Promise<void> => {
      const garmentId = editingId;
      if (garmentId === null) {
        return;
      }
      const result = await patchGarment(garmentId, patch);
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        setToast(messageFor(result.failure, copy.wardrobe.correctionFailed));
        return;
      }
      const updated = result.data;
      setGarments((current) =>
        current.map((garment) => (garment.id === updated.id ? updated : garment)),
      );
    },
    [editingId, messageFor],
  );

  const options = typeFilterOptions(garments);
  /*
   * A correction can take the last garment of a type out of the wardrobe while
   * that type is the one being filtered on. Falling back to every garment beats
   * leaving the person in front of an empty grid they did not ask for.
   */
  const activeFilter: TypeFilter =
    filter === ALL_TYPES || options.includes(filter) ? filter : ALL_TYPES;

  const shown = [
    ...filterByType(garments, activeFilter),
    ...placeholderGarments(uploading),
  ];
  const editing = garments.find((garment) => garment.id === editingId) ?? null;
  const isEmpty = garments.length === 0 && uploading === 0;
  /*
   * The way onward, and the reason the wardrobe exists: a person photographs
   * their clothes so that something can tell them what to wear. docs/01
   * "Screen map" routes /wardrobe from /looks and writes no route back, which on
   * the live app left the wardrobe a cul de sac: a judge added garments and had
   * to find their own way to the screen that composes them.
   *
   * It takes the screen's one gold fill once there is a typed garment to compose
   * (docs/02-design-system.md, Button: "One per screen"), and "Add garments"
   * steps down to secondary. Adding more is still the obvious second thing to
   * do; it stops being the first.
   */
  const suggests = showsSuggestAction(garments);

  if (isEmpty) {
    return (
      <>
        <Column className="flex flex-col gap-6">
          {/* docs/01-user-flow.md section J item 1, verbatim. */}
          <p className="max-w-[64ch] font-body text-body text-text">
            {copy.wardrobe.emptyBody}
          </p>
          <AddGarments variant="primary" disabled={busy} onFiles={addFiles} />
          <p className="max-w-[64ch] font-body text-small text-text-muted">
            {copy.wardrobe.skipLine}
          </p>
        </Column>

        <Toast
          message={toast}
          onDismiss={() => {
            setToast(null);
          }}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {showsTypeFilter(garments) ? (
        <Column>
          <TypeFilterRow
            options={options}
            selected={activeFilter}
            onSelect={setFilter}
          />
        </Column>
      ) : null}

      <Column className="flex flex-col gap-4">
        {showsCorrectHint(garments) ? (
          // docs/01 section J item 2: "One line: 'Tap a chip to correct it.'"
          <p className="max-w-[64ch] font-body text-small text-text-muted">
            {copy.wardrobe.correctChipsHint}
          </p>
        ) : null}

        <ul aria-busy={busy} className="grid grid-cols-2 gap-4">
          {shown.map((garment) => (
            <GarmentCard
              key={garment.id}
              garment={garment}
              onCorrect={setEditingId}
            />
          ))}
        </ul>
      </Column>

      <Column className="flex flex-col gap-4">
        {suggests ? (
          <ButtonLink variant="primary" href="/looks">
            {copy.wardrobe.suggestAction}
          </ButtonLink>
        ) : null}
        <AddGarments
          variant={suggests ? "secondary" : "primary"}
          disabled={busy}
          onFiles={addFiles}
        />
      </Column>

      <GarmentPicker
        garment={editing}
        onClose={() => {
          setEditingId(null);
        }}
        onPickType={(value: GarmentType) => {
          void applyPatch({ type: value });
        }}
        onPickPattern={(value: GarmentPattern) => {
          void applyPatch({ pattern: value });
        }}
        onPickFormality={(value: GarmentFormality) => {
          void applyPatch({ formality: value });
        }}
      />

      <Toast
        message={toast}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </div>
  );
}
