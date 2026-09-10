"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { warmFaceDetector } from "@/lib/client/landmarks";
import { Sheet } from "@/components/ui/Sheet";
import { Toggle } from "@/components/ui/Toggle";
import { saveConsent, type ApiFailureKind } from "@/lib/client/api";
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

/**
 * The sentence shown when the consent post did not succeed.
 *
 * Split out so it can be checked without a browser, and because the two cases
 * are not the same failure. POST /api/consent answers 401 when there is no
 * Supabase user and no judge cookie on this device (requireSession in
 * src/lib/server/http/handler.ts). Saying "The app could not reach the server"
 * there would be false: the server was reached, and it answered. The honest
 * line says what is missing and points at the judge door from docs/01 section B.
 */
export function consentErrorLine(kind: ApiFailureKind): string {
  return kind === "unauthorized"
    ? copy.errors.sessionMissing
    : copy.errors.requestFailed;
}
export function ConsentForm() {
  const router = useRouter();

  /*
   * Start fetching the face model while the person reads this screen.
   *
   * The next screen is the camera, and the model is what decides whether it can
   * measure a face at all (src/lib/client/landmarks.ts). Loading it on /capture
   * would mean the first few seconds of the camera run on no detector, which is
   * exactly the state that produced the refusals this replaced. Consent is a
   * screen somebody reads rather than skims, so it is the right place to spend
   * the download.
   *
   * Nothing is uploaded, nothing is measured, and no camera is opened here: this
   * fetches a model file and compiles it. It is also entirely optional. If it
   * fails or times out the capture screen falls back exactly as it does today.
   */
  useEffect(() => {
    warmFaceDetector();
  }, []);

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
      setError(consentErrorLine(result.kind));
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
