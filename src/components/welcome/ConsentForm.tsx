"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Sheet } from "@/components/ui/Sheet";
import { Toggle } from "@/components/ui/Toggle";
import { saveConsent } from "@/lib/client/api";
import { copy } from "@/lib/shared/copy";

/**
 * C. Welcome and consent, docs/01-user-flow.md section C, section 3 onward.
 *
 * The button is disabled until both required boxes are checked. There is no red
 * text and no warning: the disabled state is the whole message.
 *
 * Nothing is captured or uploaded before this posts. docs/06-safety-privacy.md:
 * the capture and analyze routes return 403 until consent_at and
 * is_adult_confirmed are set, so this is a gate, not a formality.
 */
export function ConsentForm() {
  const router = useRouter();
  const [isAdult, setIsAdult] = useState(false);
  const [agrees, setAgrees] = useState(false);
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ready = isAdult && agrees;

  async function handleContinue(): Promise<void> {
    if (!ready || pending) {
      return;
    }
    setPending(true);
    setError(null);

    const result = await saveConsent(keepOriginals);
    if (!result.ok) {
      setPending(false);
      setError(copy.errors.requestFailed);
      return;
    }

    router.push("/capture");
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-title font-normal text-text">
          {copy.welcome.section3Heading}
        </h2>
        <div className="flex flex-col gap-2">
          <Checkbox
            id="consent-age"
            checked={isAdult}
            onCheckedChange={setIsAdult}
          >
            {copy.welcome.checkboxAge}
          </Checkbox>
          <Checkbox
            id="consent-processing"
            checked={agrees}
            onCheckedChange={setAgrees}
          >
            {copy.welcome.checkboxProcessing}
          </Checkbox>
          <Toggle
            id="consent-keep-originals"
            checked={keepOriginals}
            onCheckedChange={setKeepOriginals}
          >
            {copy.welcome.keepOriginalToggle}
          </Toggle>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {error !== null ? (
          <p
            role="status"
            className="rounded-sm border border-accent bg-surface px-4 py-3 font-body text-small text-text"
          >
            {error}
          </p>
        ) : null}
        <Button
          variant="primary"
          disabled={!ready || pending}
          onClick={() => {
            void handleContinue();
          }}
        >
          {copy.welcome.continueAction}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setPrivacyOpen(true);
          }}
        >
          {copy.welcome.privacyLink}
        </Button>
      </div>

      <Sheet
        open={privacyOpen}
        title={copy.welcome.privacyLink}
        onClose={() => {
          setPrivacyOpen(false);
        }}
      >
        <ul className="flex flex-col gap-4">
          {copy.privacy.points.map((point) => (
            <li key={point} className="font-body text-small text-text-muted">
              {point}
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
