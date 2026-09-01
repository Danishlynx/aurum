# 09. Build order and demo

No time estimates. Layers are ordered by dependency, and every layer is a complete, demoable product on its own. Finish a layer before starting the next. If the deadline arrives mid layer, ship the last finished layer and cut the unfinished one from the video and the page.

## Layer 0: spine

Scope

- Repo scaffold, tokens, fonts, Tailwind wiring, ESLint rules (dash rule, no hex in components, server only imports)
- Supabase project, migrations for every table in docs/03-architecture.md, RLS, four private buckets
- Auth (magic link) and judge sessions with the cookie, caps, and the kill switch
- Landing, judge access, welcome and consent screens with real copy
- Capture with the client quality gate, downscale, EXIF strip, hash, signed upload
- Job model and the polling endpoint
- Provider modules with verified endpoints.ts for Perfect Corp, SerpApi, Anthropic (verify first task complete, credit table filled)
- Seed script for the demo profile (fixture capture uploaded, analyses recorded once the provider module works)

Definition of done

- A judge code opens the app, consent gates capture, a bad photo is rejected with the right copy, a good photo uploads and creates jobs, the health route reports green, keys are absent from the client bundle, eval:capture and eval:safety pass.

## Layer 1: skin report and grounded routine

Scope

- Fan out skin analysis, Fitzpatrick, and face attributes from one upload
- The reveal on /analyzing driven by job completion
- Concern normalization and tone first ranking in src/lib/shared/concerns.ts with tests
- Synthesis call with structured output, lexicon check, deterministic fallback
- Routine rows with product queries, SerpApi grounding, product cache, local availability when allowed
- /report with mask toggles, reading, concern bars, skin age framing, routine, product cards, empty product state
- Profile row written; original capture deleted after processing by default

Definition of done

- From a fresh judge session: consent, capture, reveal, report with at least three grounded products in under two minutes on a phone. eval:palette not yet required. eval:synthesis, eval:grounding, eval:budget, eval:safety pass. Screenshots reviewed against the anti slop checklist.

Demo beat

- Selfie taps in, masks bloom, the reading names pigmentation on the cheekbones, the routine shows real products with prices.

Fallback if something fails

- If face attributes fail, the report still renders and says tone reading is unavailable. If SerpApi is unavailable, routine rows show product types with the "No listing found" copy.

## Layer 2: color identity and makeup

Scope

- Palette derivation in src/lib/shared/palette.ts (season from tone, undertone, eye and hair color; wear and avoid lists), golden files
- /color with the undertone adjuster, season line, swatches with one line reasons, "What this decides" rows
- Makeup try on for the recommended full look and per category shade rows within the palette; render caching by params hash
- Product grounding for selected shades

Definition of done

- Adjusting undertone changes the palette and re renders the hero. Shade selection re renders with the previous render dimmed until the new one arrives. eval:palette passes with goldens. Renders stay within the per session budget.

Demo beat

- The undertone swatch, then the palette grid, then the person's face with the rust lip applied.

Fallback

- If try on fails for a shade, the swatch still recommends and the hero shows the plain selfie with "Preview unavailable for this shade."

## Layer 3: hair

Scope

- Face analyzer (face shape) and hair type detection added to the capture fan out
- Style candidates chosen by face shape and hair type (a small rules table with plain names and one line reasons)
- Hairstyle try on for 3 to 4 candidates, hair color try on within the palette on the chosen style
- /hair with the face shape line, style row, color row, save

Definition of done

- Four rendered styles for a fixture face, two hair colors on the chosen style, saved to the profile. Budget still within the per session cap (adjust candidate counts if not).

Demo beat

- "Your face shape reads as oval", four styles, one tapped, a warm chestnut applied.

## Layer 4: wardrobe and looks

Scope

- /wardrobe with multi upload, classifier calls (vision, structured output), chip corrections, failed card state
- Rules engine in src/lib/shared/looks.ts: candidate combinations by color harmony against the palette, formality against the occasion, pattern clash rule; tests
- Stylist call to rank candidates with two sentence rationales
- /looks with occasion chips, two to three looks, flat lay from garment images, cloth try on of the hero garment, shop the gap via SerpApi within the palette

Definition of done

- Six fixture garments classified with at most two chip corrections; "Wedding guest" produces two looks with rationales that name the occasion and the coloring; the hero garment renders on the person; one gap is shoppable with a real listing. eval:stylist rules tests pass; injection fixture passes in eval:safety.

Demo beat

- Tap "Wedding guest", two looks appear with reasons, the navy jacket renders on the person, the shoes gap shows a listing near them.

Fallback

- If cloth try on supports only one garment per call, render the hero garment only and show the rest as a flat lay. If the wardrobe is empty, compose from live listings within the palette.

## Layer 5: occasion polish and profile

Scope

- All six occasions tuned in the rules table
- /profile with summary rows, saved items, data controls, download, typed delete
- Judge stats route

Definition of done

- Every occasion produces at least one look on the demo profile. Delete everything removes rows and objects and signs out. Download returns valid JSON.

## Layer 6: finish

Scope

- Skin simulation for a projected improvement render on the report ("projected", labeled)
- One accessory try on in the top look (earrings or a bag) from the fashion APIs
- Landing hero reveal preview on the fixture face
- Reduced motion pass, keyboard pass, contrast pass
- README, Devpost page, video

Definition of done

- The pre submission checklist below is complete and the hackathon-submission tag is on main.

## Demo video (1 to 3 minutes, this is the pitch)

Recorded on a phone screen with a real face (the founder, with consent on file), captured cleanly with screen recording, no cursor, no narration over silence. Voice over is calm and specific. No music with lyrics. The video is played on a stage if the project reaches the Top 5, so the first ten seconds must carry the problem and the reveal must be visible from across a room.

Shot list

1. 0 to 10 seconds. Black screen, one line of text in Cormorant: "Four apps to look good for one day. None of them know your skin." Voice: "Skin quizzes sell one brand's shelf. Color tools were built for light skin. Hair apps ignore your tone. Closet apps cannot see your coloring. AURUM builds one profile from one selfie, and every decision reads from it."
2. 10 to 35 seconds. The capture: the oval frame, "Face the light", the tap. Then the reveal: masks bloom over the face, the tone swatch appears, the face shape traces. Voice: "One guided selfie. Perfect Corp reads fourteen skin concerns, your tone, your face shape, and your hair."
3. 35 to 65 seconds. The report: the reading names pigmentation on the cheekbones, the routine shows real products with prices and a store nearby. Voice: "The reading leads with what matters on deeper skin. Every product is a live listing with a price, chosen across brands, not sponsored."
4. 65 to 90 seconds. Color identity and makeup: the undertone swatch, the palette, the rust lip applied to the face. Voice: "Your tone decides your palette. Your palette decides your shades. Here they are, on you."
5. 90 to 115 seconds. Hair: face shape line, four styles, one chosen, warm chestnut applied. Voice: "Styles for your face shape. Colors inside your palette."
6. 115 to 150 seconds. Looks: "Wedding guest" tapped, two looks with reasons, the navy jacket rendered on the person, the shoes gap with a listing nearby. Voice: "Your own clothes, composed for the occasion, with reasons. What you are missing, found in your palette, near you."
7. 150 to 170 seconds. Profile: the plain rows, the delete control. Voice: "Consent first. Originals deleted by default. Cosmetic, never medical. Every product real. That is the whole product: one profile, every decision, no horse in the race."
8. Final card: the name, the URL, "Built with Perfect Corp, SerpApi, Claude, Supabase, Next.js."

## Devpost page checklist

- Title and one line pitch: "AURUM: one selfie, every decision. Skin, color, makeup, hair, and outfits from a profile that knows you, with every product a real listing."
- The story: the problem in the three specific failures from docs/00-product.md, what we built, how the profile ties it together, the tone first wedge, and the company thesis with alternatives named.
- Built with: Next.js, TypeScript, Tailwind, Supabase, Vercel, Perfect Corp YouCam API (list the APIs used), SerpApi (engines used), Anthropic Claude API, zod, Vitest, Playwright.
- Perfect Corp section: which APIs, where each does real work, and the consumer value in one paragraph. Their judges asked for this.
- SerpApi section: how live listings improve the experience, in one paragraph.
- Screenshots: capture, reveal, report, color, makeup, hair, looks, profile. All at 390px, all from the demo profile.
- Video link.
- Live URL, judge access code, and the "3 analyses, then demo profile" line.
- Repo link, the hackathon-submission tag, and the commit sha.
- Privacy paragraph from docs/06-safety-privacy.md.
- Select the challenges: overall, Perfect Corp, SerpApi.

## Pre submission checklist

- Live URL loads on a phone over mobile data in under 3 seconds.
- Judge code works; a fresh session completes capture to report; the cap behaves; the demo profile serves every screen after the cap.
- Kill switch tested: with providers disabled the app still navigates every screen.
- Credit balance checked and JUDGE_CREDITS_CAP leaves headroom for the judging window.
- eval:smoke green on the submission commit; eval:consistency and eval:synthesis results attached to the README.
- No secrets in the repo history. .env.example complete.
- README setup works from a clean clone.
- Video uploaded, under 3 minutes, first ten seconds state the problem.
- All copy passes the dash and lexicon checks.
- Screenshots reviewed against the anti slop checklist one last time.
- hackathon-submission tag pushed; Devpost submitted before September 3, 2026, 10:00 AM Pacific.
