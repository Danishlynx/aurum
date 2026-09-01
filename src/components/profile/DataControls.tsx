import { Button, buttonClassName } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { copy } from "@/lib/shared/copy";

import { PROFILE_DOWNLOAD_HREF } from "./profile-client";

/**
 * "Data", docs/01-user-flow.md section L item 3: the "Keep original photos"
 * toggle that mirrors consent, "Download my data" (JSON), and "Delete
 * everything" behind a typed confirmation.
 *
 * Three notes on what is and is not here:
 *
 * 1. The toggle moves only after the server has stored the choice, so it is
 *    never showing a retention setting that was refused. While the request is in
 *    flight it is disabled rather than half moved.
 * 2. Download is an ordinary link, not a fetch. The browser performs the save
 *    and the server names the file through its Content-Disposition header, so
 *    this screen never invents a filename for a person's own data. On the demo
 *    profile it is refused rather than served (docs/06-safety-privacy.md, "Keys,
 *    sessions, abuse": "Judge sessions cannot delete the demo profile and cannot
 *    download data"), so the link stays where docs/01 section L item 3 puts it
 *    and the tap is answered with the line saying why. Following it would hand
 *    the person a file holding a refusal where their data should be, which is
 *    the one thing a data export must never be.
 * 3. The delete control is not rendered at all for a judge session
 *    (docs/01-user-flow.md "Judge mode across the flow": "Judge sessions never
 *    see the Delete everything control on the demo profile"). The server refuses
 *    it too; hiding it here is the first of the two, not the only one.
 *
 * "Delete everything" opens the sheet as a secondary button: the one gold thing
 * on this screen is the retention toggle when it is on, and the gold that arms a
 * delete belongs on the confirmation itself, not on the control that asks for
 * it.
 */

type DataControlsProps = {
  readonly keepOriginals: boolean;
  /** True while the retention choice is being stored. */
  readonly saving: boolean;
  readonly onKeepOriginalsChange: (keepOriginals: boolean) => void;
  /** True on the demo profile, whose data is nobody's to take a copy of. */
  readonly downloadRefused: boolean;
  readonly onDownloadRefused: () => void;
  /** False for a judge session, which never sees the delete control. */
  readonly showDelete: boolean;
  readonly onDeleteRequested: () => void;
};

export function DataControls({
  keepOriginals,
  saving,
  onKeepOriginalsChange,
  downloadRefused,
  onDownloadRefused,
  showDelete,
  onDeleteRequested,
}: DataControlsProps) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">
        {copy.profile.dataHeading}
      </h2>

      <div className="border-t border-raised pt-2">
        <Toggle
          id="profile-keep-originals"
          checked={keepOriginals}
          onCheckedChange={(next) => {
            if (saving) {
              return;
            }
            onKeepOriginalsChange(next);
          }}
        >
          {copy.profile.keepOriginalsToggle}
        </Toggle>
      </div>

      <div className="flex flex-col items-start gap-4 border-t border-raised pt-4">
        <a
          href={PROFILE_DOWNLOAD_HREF}
          download
          className={buttonClassName("quiet")}
          onClick={(event) => {
            if (!downloadRefused) {
              return;
            }
            event.preventDefault();
            onDownloadRefused();
          }}
        >
          {copy.profile.downloadAction}
        </a>

        {showDelete ? (
          <Button variant="secondary" onClick={onDeleteRequested}>
            {copy.profile.deleteAction}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
