# 01. User flow, A to Z

This document is the screen by screen spec. Build exactly these screens with exactly these states. Copy strings live in src/lib/shared/copy.ts and are quoted here; do not paraphrase them in components.

The app is mobile first. Design and test at 390px width. Desktop centers a 480px column on the warm black canvas; it never stretches into a dashboard.

## Screen map

    (public)
      /                     Landing: promise, the reveal preview, judge code entry
      /judge                Judge access (also reachable from landing)
    (onboarding)
      /welcome              What happens with your photo, consent, age confirmation
      /capture              Guided selfie with quality gate
      /analyzing            The reveal
    (app)
      /report               Skin report and routine
      /color                Color identity
      /makeup               Makeup on your face
      /hair                 Hair on your face
      /wardrobe             Your garments
      /looks                Looks by occasion
      /profile              Your profile, history, data controls

Bottom navigation inside (app): Report, Color, Makeup, Hair, Looks. Wardrobe is reached from Looks. Profile is reached from the top right.

## Personas used for copy and testing

- Priya, 27, Bengaluru, warm deep olive skin, wavy hair. Has a friend's wedding in ten days. Has tried three skin apps and trusts none of them because the routines never mention pigmentation.
- Daniel, 34, Atlanta, deep skin with cool undertone, coily hair. Interviewing next week. Wants to know which shirt and which cut of hair, and does not want a lecture.

Every screen should make sense to both.

## A. Landing (/)

Purpose: state the promise in one breath and get the person to the capture.

Layout: full bleed warm black. The hero is a slow, one time reveal on a fixture face (never a stock model; use the founder's own consented selfie or a synthetic face generated with Perfect Corp's tools) where gold toned concern masks bloom over the face and settle into swatches. This single orchestrated motion is the only non user triggered animation in the app.

Copy:

- Headline: "One selfie. Every decision."
- Subhead: "Skin, color, makeup, hair, and what to wear, from a profile that knows you. Every product is a real listing you can buy."
- Primary button: "Start with a selfie"
- Secondary link: "Watch the 2 minute demo"
- Footer line: "Judging this build? Enter your access code" (links to /judge)

States:

- Default as above.
- Judge session active: a slim gold hairline banner at the top reading "Judge session. 3 analyses remaining." The count is live.

## B. Judge access (/judge)

Purpose: let a judge use the live app with the team's keys, with hard caps.

Layout: a single centered field on warm black. No marketing.

Copy:

- Title: "Judge access"
- Body: "Enter the code from the project page. Your session includes 3 full analyses and is capped so credits cannot run out mid judging."
- Field placeholder: "Access code"
- Button: "Open the app"
- Error: "That code did not match. Check the project page and try again."
- Exhausted: "This session has used its 3 analyses. The app keeps working from a saved demo profile so you can see every screen."

Behavior: valid code sets an httpOnly session cookie for 24 hours, creates a judge_sessions row, and routes to /welcome. Caps are enforced server side. See docs/07-payments-and-judge-mode.md.

## C. Welcome and consent (/welcome)

Purpose: plain language consent for biometric processing, age confirmation, retention choice. This screen is legally and ethically load bearing. Do not shorten it into a modal.

Layout: three short sections separated by warm hairlines, one checkbox group, one button. No illustration.

Copy:

- Title: "Before your photo"
- Section 1 heading: "What we do with it"
- Section 1 body: "Your selfie is sent to Perfect Corp to read your skin, tone, face shape, and hair. We keep the results. By default we delete the photo itself as soon as the reading is done."
- Section 2 heading: "What we never do"
- Section 2 body: "We never diagnose anything. We never share your photo. We never process anyone's face but yours."
- Section 3 heading: "Your choices"
- Checkbox 1 (required): "I am 18 or older"
- Checkbox 2 (required): "I agree to have my selfie processed to build my profile"
- Toggle (default off): "Keep my original photo so I can compare later"
- Button: "Continue to capture" (disabled until both required boxes are checked)
- Link: "How your data is handled" (opens the privacy sheet)

States:

- Button disabled with the two required boxes unchecked. No red text; the disabled state is enough.
- Returning person with a profile: this screen is skipped; they land on /report.

## D. Capture (/capture)

Purpose: get one photo that Perfect Corp can read well, so we never waste a credit on a bad frame.

Layout: full screen camera. A soft oval frame in antique gold hairline marks where the face should be. Below the frame, one line of live guidance. A single shutter control. A small "Upload instead" text link for people without a working camera.

Live guidance (one line at a time, replaced as conditions change, never stacked):

- "Face the light. A window works best."
- "Move closer until your face fills the oval."
- "Hold still."
- "Good. Tap to capture." (frame turns solid gold)

Quality gate after capture (runs client side first, then server side):

- Face detected, roughly frontal, filling at least 60 percent of the frame height
- Sharpness above threshold (Laplacian variance)
- Exposure within range (no blown highlights on the forehead, no crushed shadows)

Sharpness is measured at one fixed size, on the face, by one function that both the live guidance line and the gate call. Laplacian variance depends on the resolution it is read at, so measuring the preview at one size and the capture at another and comparing both to one threshold is not a comparison: on 2026-09-03 it told a person "Good. Tap to capture." and then called that same frame blurry, every shot.

Failing the sharpness check is borderline and never a refusal. The engine reads its own input gate for free and is the authority on whether a frame is sharp enough, so a soft frame is offered with "Use it anyway" rather than refused. Only face detection (no face, more than one face) and the exposure extremes, which spend a credit on a reading nothing can come of, refuse a frame outright.

Copy for a rejected frame (choose the one matching the failure):

- "Too dark to read your skin. Turn toward the light and try again."
- "A little blurry. Hold still and tap again."
- "Move closer so your face fills the oval."
- Buttons: "Retake" (primary), "Use it anyway" (secondary, only shown for borderline frames, never for failed face detection)

Behavior: on accept, the image is downscaled client side to a 1024px long edge, EXIF stripped, hashed, uploaded to the private captures bucket, and the analysis jobs start. Route to /analyzing.

## E. Analyzing (/analyzing)

Purpose: the reveal. This is the signature moment of the product and of the demo video.

Layout: the person's captured selfie fills the screen, slightly darkened at the edges by a single radial vignette. As each analysis returns, its masks bloom over the face in translucent antique gold, then settle. Below, one line of status.

Sequence (driven by job completion, not timers):

1. Selfie appears, still. Status: "Reading your skin"
2. Skin masks bloom (pores, texture, tone areas). Status: "Reading your tone"
3. A single gold swatch appears at the bottom with the detected tone. Status: "Reading your face shape and hair"
4. A faint hairline traces the face shape. Status: "Building your profile"
5. Transition to /report.

Timing: each step waits for its job. If a job is slow, the status line stays; nothing fakes progress. If a job fails, its step is skipped and the report notes what is missing (see error states in F).

Reduced motion: masks appear without animation; the status lines still update.

## F. Skin report (/report)

Purpose: the tone first reading and a routine where every step has a reason and a real product.

Layout, top to bottom:

1. Hero: the selfie with mask toggles. A row of small toggles named by concern ("Pigmentation", "Texture", "Pores", "Redness", and so on, only the ones detected). Tapping a toggle shows that concern's mask. Default shows the top concern.
2. The reading: three to five sentences from the synthesis layer, written as a consultant would speak. It must name the top concern and where on the face it sits, describe the skin type per zone, and say one thing that is going well. Example of the standard: "Your skin is combination: oilier through the T zone, drier on the cheeks. The main thing worth attention is pigmentation on the cheekbones and around the mouth, common on deeper skin and very responsive to consistent care. Your texture and pores are in good shape."
3. Concern list: each concern with its name, a one line plain description, and a subtle 1 to 100 score shown as a thin gold bar, never a big number. Ordered tone first (pigmentation and uneven tone rank above wrinkles for deeper skin; the ranking rule lives in src/lib/shared/concerns.ts).
4. Skin age: shown once, small, with the framing "Perfect Corp estimates a skin age of 31. This is a cosmetic estimate of surface condition, not a health measure." Never animated, never celebrated, never used as a score to beat.
5. Routine: two groups, "Morning" and "Night". Each step is a row: step name, the concern it addresses ("for pigmentation"), one sentence of why, and a product card.
6. Product card: image, name, price, store, distance if local, "View listing" link (opens in new tab). A small line: "Chosen from live listings, not sponsored." If we could not find a listing, the row shows the ingredient or product type and "No listing found near you yet", never a made up product.
7. Footer: "Save to profile" (already saved automatically; this button confirms and routes to /color) and "Retake photo".

States:

- Loading: the hero shows immediately with the selfie; the reading and routine show skeleton rows in the surface color, no shimmer, no spinner.
- Partial: if Fitzpatrick or attributes failed, the report still renders; a quiet line under the reading says "Tone reading is unavailable for this photo. Color identity will ask you to confirm your undertone."
- Empty products: as described in item 6.
- Judge demo mode: identical layout on the saved demo profile, with the top banner.

## G. Color identity (/color)

Purpose: the palette that everything else reads from.

Layout, top to bottom:

1. A wide swatch of the detected skin tone with the undertone label ("Warm undertone") and a "Not quite right?" link that opens the undertone adjuster.
2. Undertone adjuster (sheet): three large swatches "Warm", "Cool", "Neutral" with a one line test under each ("Gold jewelry tends to look better on you", "Silver tends to look better", "Both look fine"). Choosing one updates the profile and re derives the palette. Copy: "Lighting can fool a camera. You know your skin. Pick what is true."
3. Season line: "Your palette is Deep Autumn" with a one sentence explanation in plain words ("rich, warm, and grounded colors sit closest to your skin").
4. "Colors to wear": a grid of named swatches (8 to 12). Each swatch has a plain name ("Olive", "Rust", "Cream") and, on tap, one line of why.
5. "Colors to keep away from your face": 4 to 6 swatches with one line each ("Icy pastels wash you out").
6. "What this decides": three short rows linking to Makeup, Hair, and Looks, each with one line ("Lipstick and blush shades", "Hair colors that flatter", "Outfit colors and combinations").

States:

- Undertone unknown (attributes failed): the top swatch shows "Confirm your undertone" and the adjuster opens automatically.

## H. Makeup (/makeup)

Purpose: recommended shades on the person's own face, and the products.

Layout:

1. Hero: the selfie with the recommended full look applied by the try on API. Toggle: "Before" and "After" (a tap and hold shows Before).
2. Shade rows: "Lip", "Blush", "Foundation", "Eye". Each row shows three swatches inside the palette, the middle one selected. Selecting re renders the hero (a new try on job; show the previous render dimmed until the new one arrives).
3. Product card per selected shade, same card as the report.
4. "Save this look" saves the selected shades to the profile.

States:

- Render pending: previous render stays visible, dimmed to 70 percent, with the status line "Applying rust lip". No spinner over the face.
- Try on failed: the swatches still work as recommendations, and the hero shows the unedited selfie with "Preview unavailable for this shade."

## I. Hair (/hair)

Purpose: styles for the face shape and hair type, colors within the palette.

Layout:

1. Face shape line: "Your face shape reads as oval. Most lengths and partings suit you; the styles below add structure at the jaw." One sentence, specific.
2. Styles: a horizontal row of 3 to 4 rendered try ons. Tapping one enlarges it. Each has a plain name ("Textured crop", "Soft layers past the collarbone") and one line of why it suits the face shape and hair type.
3. Colors: a row of 3 to 4 hair colors inside the palette, rendered on the selected style. One line each ("Warm chestnut brings out the warmth in your skin").
4. "Save this" saves the chosen style and color to the profile.

States: same pending and failed patterns as Makeup.

## J. Wardrobe (/wardrobe)

Purpose: get garments into the profile with as little typing as possible.

Layout:

1. Empty state: "Add what you own. Photos of a shirt, trousers, a jacket, shoes. Flat on a bed or hanging both work." Button: "Add garments". Below, a quiet line: "Or skip this. Looks can be built from new pieces near you."
2. Add flow: multi select from camera roll. Each photo becomes a card with the classification chips filled in by the classifier: type ("Shirt"), color ("Navy"), pattern ("Solid"), formality ("Smart"). Chips are tappable to correct. One line: "Tap a chip to correct it."
3. Grid of garment cards, filterable by type.

States:

- Classifying: cards show with a dimmed image and the chips as skeleton pills, replaced one by one as results arrive.
- Classification failed for one photo: that card shows "Could not read this one. Tap to fill in details."

## K. Looks (/looks)

Purpose: occasion ready combinations, with reasons, rendered, and shoppable.

Layout:

1. Occasion chooser: a row of plain chips: "Interview", "Wedding guest", "Date", "Festival", "Everyday", "Formal evening". One selected at a time.
2. Composed looks: two to three looks, each a card with a flat lay of the garments (from the person's wardrobe) and, for the top look, a rendered try on of the hero garment on the person. Each look has a two line rationale from the stylist layer: "Navy against your warm deep skin reads sharp and calm. The cream shirt keeps it from going heavy." Never a numeric score.
3. "Shop the gap": if a look is missing a piece (no shoes in the wardrobe), a product card fetched within the palette and, if location is allowed, near the person. Line: "You do not own shoes yet. These sit in your palette and are near you."
4. "Save this look" and "Try another occasion".

States:

- No wardrobe: the looks are composed entirely from live listings within the palette. Line: "Built from pieces near you. Add your own garments to mix them in."
- Try on pending: the flat lay shows first; the rendered hero arrives when the job completes.
- Location not allowed: cards drop the distance and say "Online listing".

## L. Profile (/profile)

Purpose: the person's data, in plain sight, with real controls.

Layout:

1. Top: the profile summary as short rows: skin type, top concern, tone and undertone, season, face shape, hair type. Each row has a "Retake" or "Adjust" affordance where it applies.
2. Saved: saved makeup look, hair choice, saved looks.
3. Data: "Keep original photos" toggle (mirrors consent), "Download my data" (JSON), "Delete everything" (typed confirmation: the person types DELETE).

Copy for delete: "This removes your photos, readings, garments, and looks. It cannot be undone." Button: "Delete everything". Toast after: "Deleted."

## Global states and rules

- Errors explain and direct. Never "Something went wrong." Always what happened and what to do: "Perfect Corp did not respond in time. Your photo is safe. Try again in a moment."
- Empty screens invite action with one specific verb.
- Loading uses the surface color skeletons in the exact shape of the content. No spinners on faces. No shimmer.
- Every destructive action has a typed confirmation.
- Every external link opens in a new tab and is marked as a listing, not an endorsement.
- Toasts are one line, sentence case, no icons, and disappear in 3 seconds.
- Copy never uses exclamation marks, never says "amazing", "perfect", "flawless", or "glow up", and never uses em dashes or en dashes.

## Judge mode across the flow

- The banner is visible on every screen.
- Each full capture and analysis decrements the session's remaining count.
- At zero, capture is disabled with the line "This session has used its analyses. Exploring the saved demo profile." and every screen renders from the demo profile so nothing is dead.
- Judge sessions never see the Delete everything control on the demo profile.
