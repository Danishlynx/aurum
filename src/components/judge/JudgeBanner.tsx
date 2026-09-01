import { cookies } from "next/headers";

import { Banner } from "@/components/ui/Banner";
import {
  JUDGE_REMAINING_COOKIE,
  JUDGE_SESSION_COOKIE,
  parseRemaining,
} from "@/lib/client/judge-session";
import { copy, formatJudgeBanner } from "@/lib/shared/copy";

/**
 * The judge banner, per docs/01-user-flow.md: a slim gold hairline banner at the
 * top reading "Judge session. 3 analyses remaining.", visible on every screen,
 * with a live count. docs/02-design-system.md: Basalt, gold hairline below,
 * Manrope 12 in Sand with the count in Ivory.
 *
 * It renders nothing without a judge session, so it costs a signed in person
 * nothing but the cookie read.
 *
 * The count comes from the readable mirror cookie described in
 * src/lib/client/judge-session.ts. When the session cookie is there but the
 * count is not, the banner stays hidden rather than showing a number we cannot
 * stand behind.
 */
export async function JudgeBanner() {
  const store = await cookies();
  if (store.get(JUDGE_SESSION_COOKIE) === undefined) {
    return null;
  }

  const remaining = parseRemaining(store.get(JUDGE_REMAINING_COOKIE)?.value);
  if (remaining === null) {
    return null;
  }

  const template =
    remaining === 1
      ? copy.judge.bannerTemplateSingular
      : copy.judge.bannerTemplate;
  const [before = "", after = ""] = template.split("{count}");

  return (
    <Banner label={formatJudgeBanner(remaining)}>
      <span aria-hidden="true">
        {before}
        <span className="text-text">{remaining}</span>
        {after}
      </span>
    </Banner>
  );
}
