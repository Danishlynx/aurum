"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { createJudgeSession } from "@/lib/client/api";
import { rememberJudgeRemaining } from "@/lib/client/judge-session";
import { copy } from "@/lib/shared/copy";

/**
 * B. Judge access, docs/01-user-flow.md section B.
 *
 * A valid code sets the httpOnly session cookie server side and routes to
 * /welcome. A session that has already used its analyses does not route: it says
 * so and offers the saved demo profile, because docs/07-payments-and-judge-mode.md
 * promises a judge is never stranded on a dead screen.
 *
 * The sentence shown for a failure is chosen here, not read from the response
 * body, so the voice rules hold whatever a route decides to return.
 */
export function JudgeAccessForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || code.trim() === "") {
      return;
    }
    setPending(true);
    setError(null);

    const result = await createJudgeSession(code.trim());

    if (!result.ok) {
      setPending(false);
      setError(
        result.kind === "unauthorized"
          ? copy.judge.codeError
          : copy.errors.requestFailed,
      );
      return;
    }

    rememberJudgeRemaining(result.data.analysesRemaining);

    /*
     * A session that was given analyses and has none left is the exhausted state
     * docs/01-user-flow.md section B writes, and it says so here.
     *
     * A session that was given none at all is a different thing and gets the
     * ordinary route into the app. This build sets JUDGE_ANALYSES_ALLOWED=0
     * (docs/07-payments-and-judge-mode.md): judges walk the whole flow, consent
     * included, and every screen renders from the saved demo profile, with the
     * capture screen disabled and saying so. Sending them to a dead end on the
     * access screen instead would hide the app the code was meant to open.
     */
    if (
      result.data.analysesRemaining === 0 &&
      result.data.analysesAllowed > 0
    ) {
      setPending(false);
      setExhausted(true);
      return;
    }

    /*
     * A whole page load rather than a client transition.
     *
     * The session cookie changes what the shell renders: docs/01-user-flow.md
     * puts the judge banner "on every screen", and the root layout draws it from
     * the cookie on the server. A client side push keeps the layout that was
     * rendered before the session existed, so the first screens of the judge
     * flow would carry no banner at all until something forced a reload.
     */
    window.location.assign("/welcome");
  }

  if (exhausted) {
    return (
      <div className="flex flex-col gap-6">
        <p className="rounded-sm border border-accent bg-surface px-4 py-3 font-body text-body text-text">
          {copy.judge.exhausted}
        </p>
        <ButtonLink variant="primary" href="/report">
          {copy.judge.exploreDemoAction}
        </ButtonLink>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="flex flex-col gap-6"
      noValidate
    >
      <Field
        id="judge-code"
        label={copy.judge.fieldPlaceholder}
        labelHidden
        placeholder={copy.judge.fieldPlaceholder}
        value={code}
        onValueChange={(value) => {
          setCode(value);
          setError(null);
        }}
        error={error}
        disabled={pending}
        maxLength={64}
      />
      <Button type="submit" variant="primary" disabled={pending || code.trim() === ""}>
        {copy.judge.submitAction}
      </Button>
    </form>
  );
}
