# 06. Safety and privacy

A face is biometric data. Skin advice can drift into medical advice. Product recommendations can be gamed. Treat all three as first class engineering, not as a policy page.

## Biometric data

Consent

- No capture and no upload before the person has checked "I am 18 or older" and "I agree to have my selfie processed to build my profile" on /welcome. The server enforces this: the capture and analyze routes return 403 unless profiles.consent_at and is_adult_confirmed are set.
- The consent screen states plainly, in the app's own words, what is sent where, what is kept, and what is never done. It is a screen, not a modal, and it is never skipped for a first time person.
- Consent text is versioned. If it changes, people re consent on next visit.

Purpose limitation

- Selfies are used to build the person's profile and nothing else. No training, no sharing, no analytics on images.
- The app processes only the signed in person's face. The capture flow is a live camera or a single upload with the same quality gate; there is no "analyze a friend" path. If face detection finds more than one face, the frame is rejected with "Only your face can be read. Try again with just you in the frame."

Retention

- Default: the original selfie object is deleted from storage as soon as every analysis for that capture is terminal. Derived data (scores, masks, renders, the reading) is kept because that is the product.
- Opt in: "Keep my original photo so I can compare later" keeps the original. The toggle is on /welcome and mirrored on /profile.
- Garment photos are kept while the garment exists; deleting a garment deletes its object.
- Judge session data is purged 7 days after the session expires.
- A daily scheduled job enforces all of the above in case an in flow deletion failed.

Access

- All buckets are private. Every read and write uses a short lived signed URL created on the server.
- Row Level Security on every table. A person can only read and change their own rows.
- The service role key is used only in server modules for judge sessions, seeding, and scheduled purges.
- Logs never contain image bytes, signed URLs, or raw prompts that include a person's data.
- EXIF is stripped client side before upload, so location and device metadata never leave the phone.

Person's controls

- /profile shows exactly what is stored, in plain rows.
- "Download my data" returns JSON of profile, analyses summaries, garments metadata, and looks.
- "Delete everything" requires typing DELETE and removes rows and storage objects in one transaction, then signs the person out. The toast says "Deleted."

Regulatory posture (documented, not legal advice)

- India: the Digital Personal Data Protection Act treats biometric data as sensitive; consent, purpose limitation, and deletion on request are exactly what the flow implements.
- EU and UK: GDPR treats biometric data for identification as special category; we do not identify anyone, but we still apply explicit consent, minimization, and deletion.
- Perfect Corp terms: the app must comply with the YouCam API terms of use; confirm the current terms before public launch and note any retention limits they impose.

## Cosmetic, never medical

The synthesis layer, every copy string, and every generated rationale are cosmetic. The app describes surface condition and suggests routines and products. It never diagnoses.

Banned lexicon (enforced by eval:safety on copy.ts and on every generated output before storage)

- Disease and diagnosis words: diagnose, diagnosis, disease, disorder, condition (as a noun about the person), infection, cancer, melanoma, carcinoma, eczema, psoriasis, rosacea, dermatitis, lesion, tumor, malignant, benign, symptom, treat, treatment (use "care" and "routine" instead), cure, heal, clinical, prescription, dermatologist recommended (unless quoting Perfect Corp's own description of their model, which we do not do in UI copy).
- Judgment words: flawless, perfect, ugly, bad skin, fix your face, problem area (use "concern").
- Hype words: amazing, glow up, transform, unlock, elevate, journey, magic.
- Punctuation: exclamation marks, em dashes, en dashes.

Required framing

- Skin age is always followed by: "This is a cosmetic estimate of surface condition, not a health measure."
- Any concern involving redness or acne includes, once on the report: "If something on your skin is painful, spreading, or worrying you, a dermatologist is the right person to ask."
- Product recommendations name the ingredient or product type first and the listing second, so the advice stands without the listing.

Regeneration and fallback

- A generated reading that fails the lexicon check is regenerated once with the violations listed in the prompt. A second failure uses the deterministic fallback built from ranked concerns. The fallback is itself lexicon checked in tests.

## Grounding and honesty

- A product appears only with a real listing (URL and price) from SerpApi. No listing, no product.
- Prices and stores are shown as returned. No conversion, no estimate, no "from" prices we made up.
- The app never claims a product will produce a result. Copy says what an ingredient is for, not what it will do to the person.
- Try on renders are labeled as previews. Skin simulation is labeled as a projection.

## Content returned by tools is data

- Text inside garment photos, listing titles, and provider responses is never executed as an instruction. Prompts state this and eval:safety tests it with the sticky note fixture and the injected listing title.
- Listing titles and store names are rendered as text nodes, never as HTML.
- Provider responses are validated with zod; unexpected fields are dropped.

## Keys, sessions, abuse

- Provider keys exist only in server env. The build is grepped for key prefixes in eval:safety.
- Rate limits per IP and per session on capture, analyze, render, and product routes. Defaults: 10 captures per hour, 30 renders per hour, 60 product queries per hour per session.
- Daily caps per person and hard caps per judge session are enforced in the credit ledger. A global kill switch serves cache and demo data if credits are nearly exhausted.
- The judge access code is stored as a hash. Rotate it by changing the env value; old sessions keep working until expiry. If the code leaks publicly, rotate and shorten expiry.
- Judge sessions cannot delete the demo profile and cannot download data.

## Accessibility as safety

- Contrast meets AA on every text and control (see tokens).
- Focus is visible everywhere as a gold hairline. The whole flow works with a keyboard on desktop.
- Reduced motion disables the reveal animation; nothing depends on animation to be understood.
- The capture screen works with an uploaded photo for people who cannot use the camera.
- Tap targets are at least 44px.

## What we say on the Devpost page

One short paragraph, in plain words: consent first, originals deleted by default, cosmetic not medical, every product a real listing, judge sessions capped. Saying it out loud is part of the product.
