"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { Button, buttonClassName } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { createJudgeSession } from "@/lib/client/api";
import {
  judgeLanding,
  rememberJudgeRemaining,
} from "@/lib/client/judge-session";
import { copy } from "@/lib/shared/copy";

/**
 * B. Judge access, docs/01-user-flow.md section B.
 *
 * A valid code sets the httpOnly session cookie server side and routes to where
 * the session can actually be used: /welcome when it has an analysis to spend,
 * /report when it was given none and will read the saved demo profile. A session
 * that was given analyses and spent them does not route at all: it says so and
 * offers the demo profile, because docs/07-payments-and-judge-mode.md promises a
 * judge is never stranded on a dead screen. judgeLanding in
 * src/lib/client/judge-session.ts holds that decision and explains each case.
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

    const landing = judgeLanding(result.data);
    if (landing === "exhausted") {
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
    window.location.assign(landing);
  }

  if (exhausted) {
    return (
      <div className="flex flex-col gap-6">
        <p className="rounded-sm border border-accent bg-surface px-4 py-3 font-body text-body text-text">
          {copy.judge.exhausted}
        </p>
        {/*
          A plain anchor, for the reason the assign above is a whole page load:
          the session cookie was set moments ago and the banner is drawn by the
          root layout from that cookie, which a client transition would keep as
          it was rendered before the code was entered.
        */}
        <a href="/report" className={buttonClassName("primary")}>
          {copy.judge.exploreDemoAction}
        </a>
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
