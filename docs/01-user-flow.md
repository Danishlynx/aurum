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

The master frame contract, decided 2026-09-23 and implemented by the capture PRs that follow this one. There is one portrait 3:4 frame with fixed geometry, identical on every device: it is what the person sees on the stage, it is what the live line and the gate measure, and it is what is uploaded. The oval is the target face inside that frame, 0.70 of the frame's width cheek to cheek, 1.35 times as tall as it is wide, centred at 0.50 of the width and 0.47 of the height, and it is defined in the frame's own coordinates rather than drawn over whatever the camera granted. A phone track keeps its full width as a centred 3:4 crop; a laptop track keeps its full height. The upload path composes a gallery photo into the same geometry around the face it finds, and the one reframe retry is a concentric crop of that frame that cannot cut inside the oval. Every number lives in src/lib/shared/frame-geometry.ts and is derived from the engine's four gate families and the Camera Kit presets in docs/04-integrations.md, so a face that fills the oval is the same face, at the same share of the picture, on an iPhone, an Android and a webcam alike.

Live guidance (one line at a time, replaced as conditions change, never stacked):

- "Face the light. A window works best."
- "Too bright. Move out of direct light."
- "Hold the phone upright."
- "Look straight at the lens and keep the phone level."
- "Hold the phone at eye level."
- "Move closer until your face fills the oval."
- "Move back a little so your whole face fits."
- "Hold still."
- "Good. Tap to capture." (frame turns solid gold)

Order is precedence, and pose comes before framing: no amount of moving closer fixes a head that is turned away from the lens, and the engine refuses the turned head first. Light is measured over the face itself, on the same 0 to 1 scale the engine's own capture SDK uses, and has a top as well as a bottom. "Hold the phone upright" is said only on a touch device whose camera track is landscape.

"Hold the phone at eye level" is a pitch line and "Look straight at the lens" is a yaw and roll line. Both are read from the head pose the face model solves for (the landmarker's transformation matrix, decoded in src/lib/shared/pose.ts), and both hold only for a pose the gate would refuse. Nothing is inferred from where the face sits in the frame any more.

When the face model has not loaded, the line says so instead of guessing: light over the whole frame, then "Hold still.", then "The face check did not load. You can still take the photo." The tap still works; the frame is offered unmeasured (below).

Who reaches this screen: a device with a consented session. With open access on, a device without one, or whose 24 hour session has run out, is sent to /welcome before it frames a photo, because that is the screen that can mint a session and record the consent (the register call would answer 401 otherwise, and until 2026-09-14 that was shown as "Upload did not complete"). The same two answers from the server after the tap, 401 and 403, also go to /welcome rather than to a retake.

When an upload does stop, the screen says where and what came back, under the documented line: "Stopped while registering the photo. The server answered 500." or "Stopped while saving the photo. No answer came back from the server." A status code is not a sentence a person acts on, but it is what makes a screenshot a diagnosis.

Quality gate after capture (runs client side only; the server does not recompute it, and instead validates the uploaded bytes at analyze before spending anything: a JPEG whose header dimensions equal the registered ones, at least 480 px on the short side, at most 2560 px on the long side, at most 10 MB, with the registered digest, see docs/04-integrations.md):

- A face is measured by the face model (MediaPipe's FaceLandmarker: 478 landmarks, a solved head pose, the eye blink blendshapes), or the frame is unmeasured because the model did not load. There is nothing in between: no colour rule, no browser detector. An unmeasured frame is never refused; it is offered with "Use it anyway" and the reason "unmeasured", and the engine's own input gate, which is free, decides.
- On a measured frame, exactly one face. No face, or more than one, is a refusal.
- The face at least 60 percent of the frame width, cheek to cheek across the model's face oval, which is the rule the engine itself applies and a narrower measure than any detector's box. Under the Camera Kit RELAXED floor of 0.55 the frame is refused as too far; between 0.55 and 0.60 it is offered; above 0.86 it is offered as too close. The frame is composed around the face oval before it is judged, so this is a statement about the composed frame; the live line asks only whether there is enough face to compose (0.40 of the preview width, until the master frame PR moves the preview onto the frame that is sent).
- The face oval inside the frame's edge margins (3 percent, 8 percent at the top for the hair), else offered as out of bounds, which is what the engine refuses as out of boundary and no crop fixes.
- Head within the pose window, read from the solved matrix: yaw and roll inside 15 degrees, pitch from minus 20 to plus 10, matching Perfect Corp's own capture profile. A pose outside the window but inside the slack is offered, not refused, and the live line holds only for a pose the gate would refuse.
- Light over the face oval within range, on a 0 to 1 scale, with today's bands (40, 60, 205 and 225 of 255) until the calibration report moves them; blown highlights and crushed shadows over the oval's box. The eye blink blendshapes and the luma difference between the eyes are recorded in captures.quality and not yet applied.
- Sharpness measured and recorded, and used only to choose the best frame of the burst. It neither refuses nor flags a frame, there is no reason it could be reported under, and it does not hold the live line.

The reasons a frame can be refused or offered under, in precedence order: unmeasured, no face, multiple faces, too dark, over exposed, face out of bounds, too far, too close, facing away, eyes closed (recorded, applied by a later PR). What refuses outright: no face and multiple faces on a measured frame, the light extremes, a face under the 0.55 floor, and a pose beyond the slack. Everything else is offered.

Amended 2026-09-23. The face detector became the face landmarker, self hosted with its runtime from public/ and pinned by sha256 (docs/04-integrations.md), and the colour threshold fallback was deleted: every threshold it fed was a guess about lit skin, and a gate that measured nothing has no grounds to refuse. The gate now reads the engine's own quantities, cheek to cheek width, a solved pose, light over the face, and stores every one of them for the calibration report.

Amended again 2026-09-14, after a level phone with a face filling the oval sat on "Hold the phone at eye level" and then answered "Move closer" on the tap. Every threshold written against the height of the face box had been calibrated against the old skin colour box, which covered the forehead, the hair and the neck. A detector reports a face, eyebrows to chin, about two thirds of that. So the 60 percent height rule called a well framed face too far, and the pitch estimate's guessed neutral point read a level phone as looking up by about eight degrees, on the axis the engine's budget is tightest. The height rule is gone from the gate and the live line, the pitch neutral is corrected, and neither sharpness nor a borderline pose can hold the line any more. `/capture?debug=1` shows the numbers the line was computed from, so the next threshold is set from a phone rather than from a guess.

Amended 2026-09-07, after a wave of good photographs was being refused. Four things were wrong and all four are fixed in place.

The face detector was `window.FaceDetector`, the Shape Detection API, which Safari has never implemented and Chrome has never shipped on by default. In practice it was never present, so every capture was measured by a YCbCr skin colour threshold instead. That fallback drops deep skin under warm light out of its chroma range and answers "no face", it merges a face with any skin coloured wall behind it, it runs down a lit neck and reports a box larger than the face, and it reads a bare arm as a second person. The app loaded MediaPipe's short range face detector in its place, with the colour threshold as a fallback for a device where the model would not load; since 2026-09-23 the detector is the landmarker and the fallback is gone (above).

Sharpness was a bare Laplacian variance, which is edge energy, which scales with the contrast of the face being measured. A deeply pigmented face in soft light carries less local contrast than a pale one under the same lamp, so the measurement ran low on exactly the skin tones this product exists to serve and told those people their sharp photograph was blurry. It is now divided by the region's own contrast, which makes it a focus measure rather than a contrast measure, and Perfect Corp publishes no blur or sharpness error code at all, so it refuses nothing.

The framing rule was face height against frame height. The engine's rule is face width against the frame's short axis, and a face sitting exactly on our height rule in a 3 by 4 frame lands at about 0.56 of the width where the engine wants more than 0.60. Our gate passed at precisely the value the engine refuses at. Both rules are now checked, and a frame that fails the width one is recomposed around the face rather than refused: the camera path now does what the upload path has done since 2026-09-02.

Pose was not measured at all, and pose is what the engine actually refuses. Every refusal read off the live API has been one: error_face_angle_rightward, error_face_not_forward_facing, error_face_angle_downward. The live line now names it before the shutter, and the app asks the engine for its most permissive angle tolerance ("flexible", 30 degrees) rather than the default it was sending ("high", 10 degrees), which no handheld selfie reliably meets.

Sharpness is measured at one fixed size, on the face, by one function that both the live guidance line and the gate call. Laplacian variance depends on the resolution it is read at, so measuring the preview at one size and the capture at another and comparing both to one threshold is not a comparison: on 2026-09-03 it told a person "Good. Tap to capture." and then called that same frame blurry, every shot.

There is no sharpness check. The engine publishes no blur code and reads its own input gate for free, so a soft frame is sent and the engine judges it; the number is recorded with the capture and ranks the frames of the burst, and that is all it does. What refuses a frame outright is listed with the gate above.

Copy for a rejected frame (choose the one matching the failure):

- "Too dark to read your skin. Turn toward the light and try again."
- "Move closer so your face fills the oval."
- "The face check did not load on this device, so the photo was not checked." (offered, never refused)
- Buttons: "Retake" (primary), "Use it anyway" (secondary, only shown for borderline frames, never for failed face detection on a measured frame)

Behavior: one tap takes a short burst of 5 frames about 90ms apart, not the single frame at the instant of the tap, because the instant of the tap is the instant the finger pressing the glass moves the phone and this product gets one attempt at a reading. Every frame of the burst is composed and measured by the same gate, the best scoring one is sent (frameScore in src/lib/shared/quality.ts, which ranks on pose first, then framing, then light, then sharpness), and the frame frozen on screen becomes the winner. There is still one shutter and it still fires only when it is tapped. On accept, the image is downscaled client side to a 1024px long edge, EXIF stripped, hashed, uploaded to the private captures bucket, and the analysis jobs start. Route to /analyzing.

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

Backgrounded: the screen polls again the moment the tab comes back to the foreground, because nothing advances a reading without it.

Gave up: after three polls in a row that never reached the server, the status line says "The app could not reach the server. Check your connection and try again." with "Check again" as the primary action, which resumes polling the same capture, and "Retake photo" under it. The readings behind the screen are paid for and often finished; a dropped connection never buys them twice.

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
