"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { copy } from "@/lib/shared/copy";

import { deleteArmed } from "./profile-content";

/**
 * The typed confirmation for "Delete everything", docs/01-user-flow.md section
 * L: "This removes your photos, readings, garments, and looks. It cannot be
 * undone." The person types DELETE, and the button is dead until the word
 * matches exactly. "Global states and rules": every destructive action has a
 * typed confirmation.
 *
 * The sheet is the design system's confirmation surface (docs/02-design-system.md,
 * Sheet). It is titled with the action it performs, so the sentence, the field,
 * and the button all say the same thing, and closing it is one tap on the
 * sheet's own close control or the scrim.
 *
 * The button is the primary gold one, because it is the single action of this
 * surface and because the change from the disabled Umber fill to gold is what
 * shows the person the word has landed. There is no red anywhere in the system;
 * the words carry the weight.
 *
 * What the person typed is cleared whenever the sheet closes, so a sheet opened
 * a second time never opens already armed.
 */

type DeleteSheetProps = {
  readonly open: boolean;
  /** True while the request is in flight, so the button cannot fire twice. */
  readonly deleting: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
};

export function DeleteSheet({
  open,
  deleting,
  onClose,
  onConfirm,
}: DeleteSheetProps) {
  const [typed, setTyped] = useState("");
  const armed = deleteArmed(typed);

  function close(): void {
    setTyped("");
    onClose();
  }

  return (
    <Sheet open={open} title={copy.profile.deleteAction} onClose={close}>
      <div className="flex flex-col gap-6">
        {/* docs/01-user-flow.md section L, "Copy for delete", verbatim. */}
        <p className="max-w-[64ch] font-body text-body text-text">
          {copy.profile.deleteBody}
        </p>

        <Field
          id="profile-delete-confirm"
          label={copy.profile.deleteConfirmLabel}
          value={typed}
          onValueChange={setTyped}
          disabled={deleting}
          maxLength={16}
        />

        <Button
          variant="primary"
          disabled={!armed || deleting}
          onClick={onConfirm}
        >
          {copy.profile.deleteAction}
        </Button>
      </div>
    </Sheet>
  );
}
