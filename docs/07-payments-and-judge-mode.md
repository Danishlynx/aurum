# 07. Payments and judge mode

Decision for this build: no payment processing. Judges get gated live access with hard caps. Monetization is documented here so the company story is complete, and the code is structured so adding Razorpay or Stripe later touches only a feature flag and one module.

## Judge mode (build this)

Purpose: let a judge use the real app with the team's provider keys, without signup friction, without the possibility of draining credits, and with every screen still working if a cap is hit.

Access

- The Devpost project page shows: the live URL, the access code, and one line: "Your session includes 3 full analyses. The app keeps working from a saved demo profile after that."
- /judge accepts the code. The server compares it against JUDGE_ACCESS_CODE_HASH (bcrypt or argon2 hash of the code). On match it creates a judge_sessions row with expires_at 24 hours out, analyses_allowed from JUDGE_ANALYSES_ALLOWED (default 3), credits_cap from JUDGE_CREDITS_CAP, and sets an httpOnly, secure, sameSite strict cookie with the session id.
- Judge sessions skip Supabase Auth. Server routes accept either a Supabase JWT or a valid judge cookie. Data written during a judge session is owned by the session id.

Caps

- Each capture that reaches the analyze step decrements analyses_used. When analyses_used equals analyses_allowed, the capture screen is disabled with the flow doc copy and reads serve the demo profile.
- Every provider call during a judge session reserves credits against credits_cap. Exceeding the cap returns 429 and the app falls back to cache or demo, so a judge is never stranded on a broken screen.
- Renders are limited to 6 per judge session.
- Rate limits from docs/06-safety-privacy.md apply.

Demo profile

- A seed script loads a fixture profile: a consented fixture capture with real analyses, real masks, a full reading, saved makeup and hair renders, a six garment wardrobe, and two saved looks for "Wedding guest" and "Interview". Product listings for the demo are recorded responses so they never depend on live quota.
- The demo profile is read only for judge sessions. The banner makes it clear what is live and what is demo.

Kill switch

- PROVIDER_CALLS_ENABLED=false makes every provider route serve from cache or the demo profile. Flip it if the credit balance nears exhaustion before judging ends on September 3. The app stays fully navigable.

Observability for judging

- Log judge session creation and each cap event. A tiny /api/judge/stats route (protected by the same code) shows sessions created, analyses used, credits used, so the human can watch the balance during judging.

## Monetization (document now, build later)

Revenue streams, in the order we would turn them on

1. Affiliate commission on grounded products. Every recommendation already links to a real listing. Joining affiliate programs (for India: Amazon Associates, Nykaa, Myntra; globally: Amazon, Sephora, and brand programs) converts existing behavior into revenue with zero change to the person's experience. Affiliate links must be labeled as such in the product card footer ("Chosen from live listings. We may earn a commission.").
2. Premium tier. Progress tracking over time using Perfect Corp's skin simulation for before and after, unlimited looks and renders, seasonal palette refreshes, priority rendering. Hypothesis: a monthly price in the range of a single coffee in India and a single fast casual meal elsewhere; validate with a waitlist before setting it.
3. B2B licensing. A neutral consultation tool for salons, makeup artists, and multi brand retailers who want cross brand recommendations. Per seat or per consultation pricing.

Why neutrality is the business

- Brand embedded quizzes recommend their own shelf; their revenue depends on it. AURUM's revenue comes from being right for the person, across brands. That is the counter position; do not dilute it with sponsored placement.

Unit economics to track from day one

- Cost per full session: Perfect Corp units at the console price, SerpApi searches at the plan price, Claude tokens for one synthesis and one stylist call, storage. The credit ledger records units; add a monthly cost view once real pricing is known.
- Revenue per session at target: affiliate conversion rate times average order value times commission rate. Even modest conversion on a routine of five products pays for the session's provider costs.

## Razorpay later (India)

What it takes

- Razorpay live mode requires an Indian business entity and KYC. Test mode works anywhere and is enough to build and demo the premium flow.
- Products: Razorpay Subscriptions for the premium tier, or one time Payments for passes. Use Subscriptions.
- Flow: server creates a subscription, client opens Razorpay Checkout with the subscription id, Razorpay redirects back, and the server verifies the payment signature. Never trust the client redirect alone.
- Webhooks: subscribe to subscription activated, charged, cancelled, and payment failed. Verify the webhook signature with the webhook secret. Make handlers idempotent by storing the event id.
- Entitlement: a premium flag on the profile with an expiry, set only by verified webhooks or verified callbacks, never by the client.

## Stripe later (global)

- Same shape: Checkout Sessions in subscription mode, webhook verification with the endpoint secret, idempotent handlers, entitlement set server side only.
- Choose the processor by the person's country at checkout time behind one interface: src/lib/server/billing/{razorpay,stripe}.ts implementing createSubscription, verifyCallback, handleWebhook.

## Feature flags

- BILLING_ENABLED=false in this build. Premium only features are visible with a quiet "Coming soon" line rather than a paywall, so the demo never hits a locked screen.
- When billing turns on, the free tier keeps: one profile, one full analysis per month, three saved looks. Everything the judges see today remains free.

## What never happens

- No payment code in the hackathon build.
- No paywall between a judge and any screen.
- No sponsored placement in recommendations, ever, in any tier.
