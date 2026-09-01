"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Column } from "@/components/layout/Column";
import { Toast } from "@/components/ui/Toast";
import { copy } from "@/lib/shared/copy";
import type { ProfileView } from "@/lib/shared/profile-view";

import { DataControls } from "./DataControls";
import { DeleteSheet } from "./DeleteSheet";
import {
  deleteEverything,
  fetchProfile,
  saveKeepOriginals,
  type ProfileFailure,
} from "./profile-client";
import { ProfileBodySkeleton } from "./ProfileSkeleton";
import { SavedList } from "./SavedList";
import { SummaryRows } from "./SummaryRows";

/**
 * L. Profile, docs/01-user-flow.md section L: the summary rows with their
 * affordances, what the person has saved, and the three data controls.
 *
 * This is the only client component on the screen, because everything here is a
 * tap: following an affordance, moving the retention toggle, asking for the
 * data, typing the confirmation. The session check and the redirect happen on
 * the server, in page.tsx.
 *
 * Why the view is fetched here rather than rendered on the server, which is what
 * /report, /color, /makeup, and /hair all do: the retention toggle and the
 * delete both change the very thing this screen shows, so it would have to re
 * read the view after a write in any case. It reads it from the one route the
 * Layer 5 contract names, the same way /looks does.
 *
 * What this screen refuses to do:
 *
 * - It never moves the retention toggle before the server has stored the choice.
 *   A refusal leaves the toggle where it was and says what happened.
 * - It never says "Deleted." for a delete the server did not perform. A refused
 *   delete gets the line that says nothing was deleted.
 * - It never renders the delete control for a judge session (docs/01-user-flow.md
 *   "Judge mode across the flow"). The server refuses it as well, so hiding it
 *   is the first of the two checks rather than the only one.
 *
 * Fixture mode: the checked in profile renders in full, and every write answers
 * 403, which becomes the read only line rather than a claim that something
 * changed. The download is refused as well (docs/06-safety-privacy.md: "Judge
 * sessions cannot delete the demo profile and cannot download data"), so the tap
 * is answered here rather than followed into a file holding a refusal.
 */

export function ProfileScreen() {
  const router = useRouter();

  const [view, setView] = useState<ProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const [savingKeep, setSavingKeep] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /**
   * True once the server has confirmed the delete. The rows, the saved items,
   * and the controls come off the screen at that point, because there is nothing
   * left for them to describe, and the person leaves for the landing screen when
   * the toast has had its three seconds.
   */
  const [deleted, setDeleted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await fetchProfile();
      if (!mountedRef.current) {
        return;
      }
      setLoading(false);
      if (!result.ok) {
        setUnavailable(true);
        return;
      }
      setView(result.data);
    }
    void load();
  }, []);

  const readOnly = view?.isJudgeSession ?? false;

  /**
   * The sentence for a refusal. The demo profile's 403 is the only one this
   * screen can name, and only when it is actually serving the demo profile: in
   * an ordinary session a 403 is a different thing, and blaming the demo profile
   * for it would be a guess.
   */
  const messageFor = useCallback(
    (failure: ProfileFailure, fallback: string): string =>
      failure === "read_only" && readOnly ? copy.profile.readOnly : fallback,
    [readOnly],
  );

  const dismissToast = useCallback((): void => {
    setToast(null);
    if (!deleted) {
      return;
    }
    // The server has already signed this person out. Leaving them on a screen
    // built from data that no longer exists would be the only untrue thing here.
    router.replace("/");
    router.refresh();
  }, [deleted, router]);

  async function changeKeepOriginals(next: boolean): Promise<void> {
    if (savingKeep || view === null) {
      return;
    }
    setSavingKeep(true);
    const result = await saveKeepOriginals(next);
    if (!mountedRef.current) {
      return;
    }
    setSavingKeep(false);
    if (!result.ok) {
      setToast(messageFor(result.failure, copy.profile.keepOriginalsFailed));
      return;
    }
    // Stored, so the toggle may move. The toggle moving is the confirmation;
    // docs/01 asks for no toast on a choice that landed.
    setView((current) =>
      current === null ? current : { ...current, keepOriginals: next },
    );
  }

  async function confirmDelete(): Promise<void> {
    if (deleting) {
      return;
    }
    setDeleting(true);
    const result = await deleteEverything();
    if (!mountedRef.current) {
      return;
    }
    setDeleting(false);
    if (!result.ok) {
      setToast(messageFor(result.failure, copy.profile.deleteFailed));
      return;
    }
    setDeleteOpen(false);
    setDeleted(true);
    setView(null);
    // docs/01-user-flow.md section L: "Toast after: 'Deleted.'"
    setToast(copy.toasts.deleted);
  }

  return (
    <div className="flex flex-col gap-8">
      {loading ? <ProfileBodySkeleton /> : null}

      {!loading && unavailable ? (
        <Column>
          <p role="status" className="max-w-[64ch] font-body text-body text-text">
            {copy.profile.unavailable}
          </p>
        </Column>
      ) : null}

      {view === null ? null : (
        <>
          <Column>
            <SummaryRows rows={view.rows} />
          </Column>

          <Column>
            <SavedList saved={view.saved} />
          </Column>

          <Column>
            <DataControls
              keepOriginals={view.keepOriginals}
              saving={savingKeep}
              onKeepOriginalsChange={(next) => {
                void changeKeepOriginals(next);
              }}
              downloadRefused={view.isJudgeSession}
              onDownloadRefused={() => {
                setToast(copy.profile.downloadReadOnly);
              }}
              showDelete={!view.isJudgeSession}
              onDeleteRequested={() => {
                setDeleteOpen(true);
              }}
            />
          </Column>

          <DeleteSheet
            open={deleteOpen}
            deleting={deleting}
            onClose={() => {
              setDeleteOpen(false);
            }}
            onConfirm={() => {
              void confirmDelete();
            }}
          />
        </>
      )}

      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}
