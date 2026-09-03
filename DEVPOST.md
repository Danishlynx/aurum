# Devpost page

Everything that goes on the project page, in the order Devpost asks for it. Paste each block into the matching field.

Two kinds of marker appear below:

- **TODO-human**: a value only the human has (a URL, a code, a commit sha, a file). Fill it before submitting.
- **Verify before pasting**: a sentence that is only true after the app has run against live keys. Check it against the real run, or cut it. Nothing on this page may claim a call that never happened.

Spec: `docs/09-build-order-and-demo.md`, "Devpost page checklist".

## Project name

    AURUM: one selfie, every decision.

## Tagline

    Skin, color, makeup, hair, and outfits from a profile that knows you, with every product a real listing.

## Inspiration

A person getting ready for something that matters, an interview, a wedding, a date, opens four unrelated apps and gets four unrelated answers. Underneath that are three specific failures.

**Brand locked advice.** The skin analysis most people meet is embedded in a brand's own site and exists to sell that brand's shelf. The analysis is a funnel to a predetermined answer, and the person never learns whether a cheaper product from another brand would serve their skin better.

**Tools built for light skin.** Peer reviewed work shows skin algorithms lose accuracy on darker skin, and the Fitzpatrick scale most tools lean on was designed in 1975 to predict sunburn, compressing most of the world's skin tones into a few types. The concerns that dominate deeper and olive skin, hyperpigmentation, dark spots, uneven tone, post acne marks, come second in tools tuned for wrinkles and redness. Color advice built on that foundation is wrong for most of humanity.

**No shared profile.** Skin tone decides which lipstick shade works, which hair color flatters, which clothing colors sit well, and which foundation to buy. All of it is knowable from one photo, and no product carries it across decisions. The person answers the same questions in every app and still guesses at the end.

## What it does

AURUM builds one aesthetic profile from one guided selfie: skin concerns with scores and masks, Fitzpatrick type and detected skin tone, undertone (which the person can confirm or adjust), eye and natural hair color, face shape, and hair type. That profile is the spine. Every screen is a lens on it, and nothing asks for the photo twice.

- **Skin report.** Concerns ranked tone first, a reading that names the concern and where it sits on the face, and an AM and PM routine where every step is tied to a detected concern.
- **Color identity.** A seasonal palette derived from tone, undertone, eye and hair color, with colors to wear, colors to avoid, and a one line reason for each. This one layer decides the makeup shades and the clothing colors, which is what makes the app feel like a single product rather than five.
- **Makeup.** Shades inside the palette, previewed on the person's own selfie.
- **Hair.** Styles chosen for the face shape and hair type, colors that sit inside the palette, both previewed on the same photo.
- **Wardrobe and looks.** The person uploads their own garments, a vision model classifies them, a rules engine composes occasion ready combinations by color harmony against the palette and formality against the occasion, a stylist model ranks them with two sentence reasons, the hero garment is previewed on the person, and anything missing is shopped inside their palette and near them.

The tone first wedge runs through all of it. The ranking, the reading, the palette mapping, and the shade families lead with what matters on deeper and olive skin, because that is where existing tools fail hardest and where the difference is felt immediately. The product works for every skin tone; it leads with the ones others get wrong.

Two rules hold the whole thing honest. A product is shown only when a live listing came back for it, with its price and store printed exactly as returned. And nothing is medical: the app describes concerns and suggests routines, never a diagnosis, enforced by a banned lexicon checked over every string of copy and every generated reading.

## How we built it

One selfie is quality gated in the browser (sharpness, exposure, face coverage, one face only), downscaled, stripped of EXIF, hashed, and uploaded to a private bucket through a short lived signed URL. The hash is the cache key, so the same photo never pays twice.

The upload fans out into jobs, one per Perfect Corp analysis, and the client polls. Provider responses are parsed with zod at the boundary; a field we depend on going missing fails that job with a typed error instead of putting a guess on the screen. The scores become an internal concern set with a tone first ranking, a pure function with unit tests and golden files. The palette is another pure function over tone, undertone, eye and hair color. Claude turns the ranked scores into one coherent reading and ranks the outfit candidates the rules engine generated, both through forced tool use with a zod schema on the way out and a deterministic fallback when parsing or the lexicon check fails twice. SerpApi grounds every product. Supabase holds the rows behind row level security and the images in four private buckets. The whole thing is a mobile first Next.js app on Vercel, dark by default, built to one design token file.

Judge mode is part of the build, not a demo mode bolted on: an access code opens a capped session with its own credit ledger, and when the cap is reached every screen keeps working from a saved demo profile.

## Challenges we ran into

Verification before spending. Every Perfect Corp endpoint we call carries its verification state in code, and calling an unverified path is refused rather than guessed, so a wrong request shape can never turn into a credit spend. One endpoint is still marked unverified for exactly that reason, and the screen it belongs to says so instead of pretending.

Grounding without inventing. It is easy to write a recommender that names a product. It is harder to accept that when no listing comes back, the honest screen is a product type and an empty state. Both the empty state and the rule that produces it are tested.

Ranking for the skin the tools miss. Tone first ranking is a claim about what to show first, so it is a pure function with fixture profiles and golden files rather than a sentence in a prompt.

Language that stays cosmetic. A model asked to describe a face will reach for medical words. The lexicon check runs over every string in the copy file and every generated output before storage, regenerates once with the violations listed, and falls back to a deterministic reading on a second failure.

## What we learned

The interesting part of a product like this is not the analysis, it is the profile and the incentive. Once one profile exists, every additional feature costs a rules table and a prompt instead of another onboarding. And once the recommender is not selling a shelf, being right is the only thing left to compete on.

## What's next

**Who pays.** Affiliate commission on grounded products first: every recommendation already links to a real listing, so it converts existing behavior into revenue with no change to the experience, labeled in the product card. Then a premium tier for progress tracking over time using skin simulation, unlimited looks, and seasonal palette refreshes. Then licensing to salons, makeup artists, and multi brand retailers who want a consultation tool that recommends across brands. Willingness to pay is already proven by the color analysis, beauty consultation, and personal styling industries, which are human services priced from tens to hundreds of dollars a session.

**Named alternatives, honestly.** Brand embedded skin quizzes analyze your skin to sell their own shelf; we analyze your skin and find the best product at any price from any brand, with the listing as proof. Generic consumer skin apps rank wrinkles and redness first and monetize through sponsored placement; we lead with the concerns that dominate deeper and olive skin and ground every product in a live listing rather than a stale catalog. Closet and outfit apps know your clothes but not your coloring; we compose from a palette derived from your actual skin, hair, and eyes. Single feature try on tools answer one question and forget you; we keep one profile that every decision reads from.

**Risks we will say out loud.** Skin apps exist and try on tools exist. Incumbents could add cross brand recommendations, though not without cannibalizing the shelf they sell. The outfit logic is stylist reasoning encoded in rules plus a model, not a trained aesthetic model. The answer to each is the same: the profile, the neutrality, and the tone first wedge.

**Moat.** The profile is data gravity: it gets richer with every feature used, and nobody rebuilds it elsewhere. Neutrality is counter positioning. And every correction a person makes to their undertone or palette is training signal for the population existing tools serve worst.

## Perfect Corp challenge section

*Verify before pasting: cut any row the demo does not actually show, and confirm the units figures against the API console.*

AURUM is built on the Perfect Corp YouCam API. It is the only thing in the product that reads the face, and it is the only thing that puts anything on it.

| API | Where it does real work in the app |
| --- | --- |
| AI skin analysis | Per concern scores and pixel masks. The masks are the reveal animation on `/analyzing` and the toggles on the report; the scores are the concern bars, the tone first ranking, and the input to the reading. |
| Fitzpatrick skin type | Sets the ranking's tone context, so a deeper skin type moves pigmentation and uneven tone above wrinkles and redness. |
| Facial color tones | Skin, eye, and hair color. This is the input the entire color identity is derived from, which in turn decides makeup shades and clothing colors. |
| AI face analyzer | Face shape, which chooses the hairstyle candidates on `/hair`. |
| Hair type detection | Texture and curl pattern, which filters those candidates again. |
| Makeup try on | The recommended look and the per category shades, previewed on the person's own selfie. |
| Hairstyle try on | Three to four style candidates previewed on the same photo. |
| Hair color try on | Colors inside the palette, previewed on the chosen style. |
| Cloth try on | The hero garment of a composed look, previewed on the person. |
| Accessory try on | One accessory in the top look. |
| Skin simulation | A projected improvement render on the report, labeled as a projection. |

**Consumer value.** The value is not that a person can see a lipstick on their face; several apps do that. It is that they never have to describe themselves to get there. One selfie produces one profile, and Perfect Corp's analysis APIs are what make that profile real rather than a questionnaire: the skin scores decide what the routine is for, the Fitzpatrick type and facial color tones decide the palette, the face shape and hair type decide which styles are even offered, and then the try on APIs put the answer back on the person's own face so the recommendation is something they can judge rather than imagine. Because the analysis and the rendering come from the same profile, the shades previewed are the shades the palette chose, the hair colors are inside that same palette, and the garment rendered is the one the stylist ranked first. Every render is labeled a preview and the skin simulation is labeled a projection, so nothing is sold as a promise. For a person with deeper or olive skin, who is used to color advice that was not built for them, the difference is visible in the first ten seconds.

## SerpApi section

AURUM never shows a product it cannot prove. Every recommendation, a routine step, a makeup shade, a gap in an outfit, is turned into a query built from the recommendation itself and sent to SerpApi's `google_shopping` engine; the card appears only if a listing came back, and it shows the title, price, and store exactly as returned, with a link out. No listing, no product: the step shows its ingredient or product type and an empty state instead. `google_maps` and `google_local` add the other half, where to actually buy it, when the person has allowed location. This is what separates advice from a shopping trip. The recommendation is chosen across brands and price points rather than from one shelf or one stale catalog, the price the person sees is today's price, and the neutrality is verifiable by tapping the link. Every query is hashed and cached, and daily and per session caps sit in front of the quota, so honesty about grounding does not turn into an unbounded spend.

## Built with

Tags: `next.js`, `typescript`, `tailwindcss`, `react`, `supabase`, `postgresql`, `vercel`, `perfect-corp`, `youcam`, `serpapi`, `anthropic`, `claude`, `zod`, `vitest`, `playwright`.

In prose: Next.js (App Router) and TypeScript in strict mode, Tailwind CSS on one design token file, Supabase (Postgres with row level security, magic link auth, four private storage buckets), Vercel, the Perfect Corp YouCam API (skin analysis, Fitzpatrick skin type, facial color tones, face analyzer, hair type detection, makeup try on, hairstyle try on, hair color try on, cloth try on, accessory try on, skin simulation), SerpApi (`google_shopping`, `google_maps`, `google_local`), the Anthropic Claude API (the reading, the stylist ranking, and garment classification by vision), zod at every boundary, Vitest for the unit and eval suites, Playwright for the end to end flows.

## Try it out

- Live URL: https://aurum-danishlynxs-projects.vercel.app
- Judge access code: AURUM-FU625S
- Your session includes 3 full analyses. The app keeps working from a saved demo profile after that.
- Repository: https://github.com/Danishlynx/aurum
- Tag: `hackathon-submission`
- Commit sha: TODO-human

## Video

- Link: TODO-human (unlisted YouTube or Vimeo, under 3 minutes, public playback confirmed in a private window)

The first ten seconds state the problem, and the reveal on a real face is in the first thirty five. Shot list: `docs/09-build-order-and-demo.md`, "Demo video".

## Screenshots to upload

All at 390px, all from the demo profile, in this order. Files are in `docs/screenshots/` after the copy step in the README.

1. Capture, the oval frame with the guidance line. Caption: one guided selfie, quality gated before anything is uploaded.
2. Reveal, masks blooming on the face. Caption: Perfect Corp reads the skin, the tone, the face shape, and the hair.
3. Report, the reading and the routine with product cards. Caption: concerns ranked tone first, every product a live listing.
4. Color identity, the palette grid. Caption: the palette every other screen reads from.
5. Makeup, a shade previewed on the person's face. Caption: shades inside the palette, previewed on you.
6. Hair, the style row with one chosen. Caption: styles for your face shape, colors inside your palette.
7. Looks, "Wedding guest" with two ranked looks. Caption: your own clothes, composed for the occasion, with reasons.
8. Profile, the plain data rows and the delete control. Caption: everything stored, in plain words, with one control that removes all of it.

## Privacy

Consent comes first: nothing is captured or uploaded before the person confirms they are 18 or older and agrees to have their selfie processed, and the server refuses the capture and analyze routes without both. The original photo is deleted from storage as soon as every reading for it is done, unless the person asks us to keep it; what stays is the derived data, which is the product. The app is cosmetic and never medical: it describes concerns and suggests routines, it never diagnoses, and a banned lexicon is enforced by a test over every string of copy and every generated reading. Every product shown is a real listing with a source URL and a price as returned, never an invented one, and every try on is labeled as a preview. Judge sessions are capped in analyses and credits, cannot delete the demo profile, and cannot download data.

## Challenges to select

- Overall prize (judged on Progress, Concept, Feasibility)
- Perfect Corp challenge
- SerpApi challenge

## Before you submit

- [ ] Every TODO-human above is filled in.
- [ ] Every "verify before pasting" block matches what the live app does.
- [ ] The three challenges above are selected on the submission form.
- [ ] The repository is public and stays public, and the video stays viewable.
- [ ] Submitted before September 3, 2026, 10:00 AM Pacific.
