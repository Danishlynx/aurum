import { cookies } from "next/headers";

import { Banner } from "@/components/ui/Banner";
import {
  JUDGE_REMAINING_COOKIE,
  JUDGE_SESSION_COOKIE,
  parseRemaining,
} from "@/lib/client/judge-session";
import { judgePerSessionCapsEnabled } from "@/lib/server/env";
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
 *
 * It is hidden for the same reason with JUDGE_PER_SESSION_CAPS off
 * (src/lib/server/env.ts). The whole banner is a count and a promise about what
 * happens when the count runs out, and with the caps off nothing happens when it
 * runs out: the session keeps working. A sentence saying two analyses remain
 * when the number bounds nothing is worse than no sentence, and inventing a
 * different one here would put copy outside src/lib/shared/copy.ts.
 */
export async function JudgeBanner() {
  const store = await cookies();
  if (store.get(JUDGE_SESSION_COOKIE) === undefined) {
    return null;
  }

  if (!judgePerSessionCapsEnabled()) {
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
