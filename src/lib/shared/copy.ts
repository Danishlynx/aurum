/**
 * Every string the person reads lives here, quoted from docs/01-user-flow.md.
 * Components never hold inline strings.
 *
 * Voice rules (docs/01-user-flow.md "Global states and rules" and
 * docs/02-design-system.md "Writing inside the design"):
 * sentence case, plain verbs, buttons say what happens, no exclamation marks,
 * no em dashes or en dashes, cosmetic never medical.
 *
 * Provenance: unless a comment says otherwise, every string below is quoted
 * verbatim from docs/01-user-flow.md. Strings taken from another doc name that
 * doc. Strings written in house (because the flow doc specifies the state but
 * not its words) are listed in COPY_NOT_IN_FLOW_DOC at the bottom of this file
 * and carry a comment where they appear.
 *
 * Screen titles: docs/01-user-flow.md gives explicit titles only for /judge and
 * /welcome. The other screens use their nav label as the title until the human
 * decides otherwise.
 *
 * Values that belong to a catalog rather than to a screen (palette color names,
 * garment type and pattern vocabularies, hairstyle names, season names) are not
 * copy. They land with src/lib/shared/palette.ts and the garment vocabulary.
 */

import type { CaptureRejectionReason } from "./quality";

export const copy = {
  product: {
    name: "AURUM",
    tagline: "One selfie. Every decision.",
  },

  /** Bottom navigation, docs/01-user-flow.md "Screen map". */
  nav: {
    report: "Report",
    color: "Color",
    makeup: "Makeup",
    hair: "Hair",
    looks: "Looks",
    wardrobe: "Wardrobe",
    profile: "Profile",
  },

  /** A. Landing (/) */
  landing: {
    headline: "One selfie. Every decision.",
    subhead:
      "Skin, color, makeup, hair, and what to wear, from a profile that knows you. Every product is a real listing you can buy.",
    primaryAction: "Start with a selfie",
    secondaryLink: "Watch the 2 minute demo",
    judgeFooter: "Judging this build? Enter your access code",
  },

  /** B. Judge access (/judge) */
  judge: {
    title: "Judge access",
    body: "Enter the code from the project page. Your session includes 3 full analyses and is capped so credits cannot run out mid judging.",
    fieldPlaceholder: "Access code",
    submitAction: "Open the app",
    codeError: "That code did not match. Check the project page and try again.",
    exhausted:
      "This session has used its 3 analyses. The app keeps working from a saved demo profile so you can see every screen.",
    /**
     * The landing banner. The doc shows it at three remaining; the count is
     * live, so formatJudgeBanner fills it. bannerExample is the doc's exact
     * wording and exists so the safety eval checks the shipped sentence.
     */
    bannerExample: "Judge session. 3 analyses remaining.",
    bannerTemplate: "Judge session. {count} analyses remaining.",
    bannerTemplateSingular: "Judge session. {count} analysis remaining.",
    // In house. docs/01 section B gives the exhausted sentence but no label for
    // the control that takes the judge into the saved demo profile.
    exploreDemoAction: "Open the demo profile",
  },

  /** C. Welcome and consent (/welcome) */
  welcome: {
    title: "Before your photo",
    section1Heading: "What we do with it",
    section1Body:
      "Your selfie is sent to Perfect Corp to read your skin, tone, face shape, and hair. We keep the results. By default we delete the photo itself as soon as the reading is done.",
    section2Heading: "What we never do",
    // Contains "diagnose" as an explicit negation. See SAFETY_COPY_EXEMPTIONS
    // in src/lib/shared/lexicon.ts.
    section2Body:
      "We never diagnose anything. We never share your photo. We never process anyone's face but yours.",
    section3Heading: "Your choices",
    checkboxAge: "I am 18 or older",
    checkboxProcessing:
      "I agree to have my selfie processed to build my profile",
    keepOriginalToggle: "Keep my original photo so I can compare later",
    continueAction: "Continue to capture",
    privacyLink: "How your data is handled",
  },

  /**
   * The privacy sheet opened from the /welcome link. docs/01 section C names the
   * link and says it opens the privacy sheet but does not write the sheet. These
   * five lines are in house, each one a plain restatement of a rule in
   * docs/06-safety-privacy.md ("Retention", "Access", "Person's controls").
   * The sheet reuses welcome.privacyLink as its title.
   */
  privacy: {
    points: [
      "Your photo is deleted from storage as soon as every reading for it is done, unless you ask us to keep it.",
      "We keep what the readings produced: your scores, your masks, your palette, and the words on your report.",
      "Photos sit in a private bucket. Every read and write uses a short lived signed link created on the server.",
      "Location and device data are stripped from the photo on your phone, before anything is uploaded.",
      "You can download everything we hold, or delete all of it, from your profile.",
    ],
  },

  /** D. Capture (/capture) */
  capture: {
    /** Live guidance, one line at a time, never stacked. */
    guidance: {
      light: "Face the light. A window works best.",
      closer: "Move closer until your face fills the oval.",
      hold: "Hold still.",
      ready: "Good. Tap to capture.",
    },
    uploadInstead: "Upload instead",
    /**
     * In house. docs/01 section D provides the upload fallback but no line for
     * the browser that refuses the camera or has none.
     */
    cameraUnavailable:
      "The camera is not available in this browser. Upload a photo instead.",
    /**
     * In house. The shutter is one of the two controls docs/02 allows to appear
     * without a visible label, so it carries this accessible name instead.
     */
    shutterLabel: "Take the photo",
    /**
     * One line per rejection reason. Keyed by CaptureRejectionReason from
     * src/lib/shared/quality.ts so the set stays complete at compile time.
     */
    rejection: {
      too_dark: "Too dark to read your skin. Turn toward the light and try again.",
      blurry: "A little blurry. Hold still and tap again.",
      too_far: "Move closer so your face fills the oval.",
      // docs/06-safety-privacy.md, "Purpose limitation".
      multiple_faces:
        "Only your face can be read. Try again with just you in the frame.",
      // In house. docs/01 section D lists blown highlights as a gate condition
      // but gives no line for it. Written to match the "Too dark" pattern.
      over_exposed:
        "Too bright to read your skin. Move out of direct light and try again.",
      // In house. docs/01 section D gives no line for a frame with no face.
      no_face: "No face in the frame. Center your face in the oval and try again.",
    },
    retakeAction: "Retake",
    /** Secondary, shown for borderline frames only, never for a face failure. */
    useAnywayAction: "Use it anyway",
  },

  /** E. Analyzing (/analyzing) */
  analyzing: {
    readingSkin: "Reading your skin",
    readingTone: "Reading your tone",
    readingFaceShapeAndHair: "Reading your face shape and hair",
    buildingProfile: "Building your profile",
  },

  /** F. Skin report (/report) */
  report: {
    /**
     * Concern display names and the one line plain description shown beside the
     * score bar (docs/01 section F item 3). Keys are the internal concern keys
     * in src/lib/shared/concerns.ts. Names are the mask toggle labels; the doc
     * names four of them ("Pigmentation", "Texture", "Pores", "Redness") and
     * says "and so on". Descriptions are in house, written to the voice rules.
     */
    concerns: {
      pigmentation: {
        name: "Pigmentation",
        description:
          "Areas where color has gathered and sits darker than the skin around them.",
      },
      uneven_tone: {
        name: "Uneven tone",
        description: "Color that shifts from one part of the face to another.",
      },
      dark_spots: {
        name: "Dark spots",
        description:
          "Small, defined spots of deeper color, often from sun or from older marks.",
      },
      texture: {
        name: "Texture",
        description: "How smooth or rough the surface reads in close light.",
      },
      pores: {
        name: "Pores",
        description:
          "How visible the openings in the skin are, usually across the T zone.",
      },
      redness: {
        name: "Redness",
        description:
          "Warmer, pinker color sitting on the surface, often on the cheeks and nose.",
      },
      oiliness: {
        name: "Oiliness",
        description: "How much shine the skin carries through the day.",
      },
      moisture: {
        name: "Moisture",
        description: "How much water the surface is holding.",
      },
      acne: {
        name: "Blemishes",
        description:
          "Raised marks that come and go, most often along the jaw and chin.",
      },
      wrinkles: {
        name: "Wrinkles",
        description: "Lines that stay visible when the face is at rest.",
      },
      dark_circles: {
        name: "Dark circles",
        description: "Deeper color in the hollow under the eyes.",
      },
      eye_bags: {
        name: "Eye bags",
        description: "Puffiness sitting under the lower lash line.",
      },
      eyelid_droop: {
        name: "Eyelid droop",
        description: "How much the upper lid rests over the crease.",
      },
      tear_trough: {
        name: "Tear trough",
        description:
          "The shadowed groove running from the inner corner of the eye.",
      },
      firmness: {
        name: "Firmness",
        description: "How taut the skin reads along the jaw and cheeks.",
      },
      radiance: {
        name: "Radiance",
        description: "How much light the surface gives back.",
      },
    },

    /**
     * Skin age, shown once, small. docs/01 section F item 4 and the required
     * framing in docs/06-safety-privacy.md. The framing sentence is never
     * shown without the estimate and never the other way round.
     */
    skinAgeTemplate: "Perfect Corp estimates a skin age of {age}.",
    skinAgeFraming:
      "This is a cosmetic estimate of surface condition, not a health measure.",

    /**
     * In house. Names the mask toggle row above the hero (docs/02-design-system.md,
     * MaskToggle) for a screen reader, which otherwise meets a row of chips with
     * no word for what they switch between.
     */
    maskTogglesLabel: "Concern masks",

    /** Routine groups, docs/01 section F item 5. */
    routineMorning: "Morning",
    routineNight: "Night",
    /** The gold micro tag on a routine row, for example "for pigmentation". */
    routineConcernTagTemplate: "for {concern}",

    /** Footer, docs/01 section F item 7. */
    saveToProfileAction: "Save to profile",
    retakePhotoAction: "Retake photo",

    /** Partial state, docs/01 section F states. */
    toneUnavailable:
      "Tone reading is unavailable for this photo. Color identity will ask you to confirm your undertone.",

    /**
     * Required once on the report when a redness or blemish concern is shown.
     * docs/06-safety-privacy.md, "Required framing".
     */
    seeSomeoneLine:
      "If something on your skin is painful, spreading, or worrying you, a dermatologist is the right person to ask.",

    /**
     * Deterministic fallback reading used when the Claude call fails.
     * docs/03-architecture.md, "Failure modes and what the person sees".
     */
    fallbackReadingTemplate:
      "Main concern: {concern} on the {location}. Skin type: {skinType}.",
    /**
     * The three lines below finish the fallback reading. In house.
     *
     * docs/03-architecture.md gives the first two sentences above and stops
     * there, but docs/01-user-flow.md section F item 2 sets the standard the
     * block has to meet: name the top concern and where it sits, describe the
     * skin type, and say one thing that is going well. docs/05-evals.md then
     * requires 3 to 5 sentences. These templates are what carries the fallback
     * from two sentences to that standard, in the same plain voice.
     *
     * The no skin type variant exists because copy.fill refuses to render a
     * template with a missing value, and the skin type is unknown when neither
     * oiliness nor moisture came back.
     */
    fallbackReadingNoSkinTypeTemplate: "Main concern: {concern} on the {location}.",
    fallbackSecondConcernTemplate:
      "Also worth attention: {concern} on the {location}.",
    fallbackGoingWellTemplate: "Your {concerns} are in good shape.",
    fallbackGoingWellSingularTemplate: "Your {concern} is in good shape.",

    /**
     * The projection row, docs/09-build-order-and-demo.md Layer 6: "Skin
     * simulation for a projected improvement render on the report ('projected',
     * labeled)".
     *
     * All in house. docs/01-user-flow.md section F stops at the footer and does
     * not write this row. The words are set by docs/06-safety-privacy.md, which
     * requires the label: "Try on renders are labeled as previews. Skin
     * simulation is labeled as a projection." So the heading is the label, and
     * the line under it says what the picture is and what it is not, because the
     * same doc says the app "never claims a product will produce a result".
     */
    projectionHeading: "Projected",
    projectionFraming:
      "A projection of this photo with your top concerns eased. It is a picture of what care could look like, not a promise of a result.",
    /**
     * The row's only control, and only when a projection can actually be
     * rendered. Plain verb, says what happens (docs/02-design-system.md).
     */
    projectionAction: "Show the projection",
    /** Pending, in the same two words as "Applying rust lip" on /makeup. */
    projectionPending: "Building the projection",
    /**
     * The try on failed state of section H, worded for this row: a projection is
     * not a shade, so it says which picture is missing.
     */
    projectionUnavailable: "Projection unavailable for this photo.",
    /** Names the concerns the projection covers, for example "dark spots and texture". */
    projectionConcernsTemplate: "Projected on {concerns}.",
  },

  /** Product card, used on /report, /makeup, /hair, and /looks. */
  productCard: {
    viewListing: "View listing",
    notSponsored: "Chosen from live listings, not sponsored.",
    noListing: "No listing found near you yet",
    /** Location not allowed, docs/01 section K states. */
    onlineListing: "Online listing",
    /**
     * In house. docs/01 section F item 6 lists "distance if local" on the
     * product card and docs/02 ProductCard says "distance in Sand small when
     * known", but neither doc writes the sentence. Filled by the grounding
     * layer only when a nearby store carrying the listing was actually found,
     * from the person's approximate location (docs/04-integrations.md: "We show
     * distance computed from the person's approximate location").
     */
    distanceTemplate: "{distance} km away",
  },

  /** G. Color identity (/color) */
  color: {
    undertoneWarm: "Warm undertone",
    undertoneCool: "Cool undertone",
    undertoneNeutral: "Neutral undertone",
    adjusterLink: "Not quite right?",
    adjusterIntro:
      "Lighting can fool a camera. You know your skin. Pick what is true.",
    adjusterWarm: "Warm",
    adjusterCool: "Cool",
    adjusterNeutral: "Neutral",
    adjusterWarmTest: "Gold jewelry tends to look better on you",
    adjusterCoolTest: "Silver tends to look better",
    adjusterNeutralTest: "Both look fine",
    /** Season names and their one sentence explanations live in palette.ts. */
    seasonLineTemplate: "Your palette is {season}",
    wearHeading: "Colors to wear",
    avoidHeading: "Colors to keep away from your face",
    decidesHeading: "What this decides",
    decidesMakeup: "Lipstick and blush shades",
    decidesHair: "Hair colors that flatter",
    decidesLooks: "Outfit colors and combinations",
    /** Undertone unknown state, docs/01 section G states. */
    confirmUndertone: "Confirm your undertone",
    /**
     * In house. docs/01 section G item 2: "Choosing one updates the profile and
     * re derives the palette." The doc gives no line for a choice that never
     * reached the profile, and "Global states and rules" requires one that says
     * what happened and what to do.
     */
    adjusterFailed: "Your undertone was not saved. Try again in a moment.",
  },

  /** H. Makeup (/makeup) */
  makeup: {
    before: "Before",
    after: "After",
    /**
     * In house. Names the pair of chips above the hero for a screen reader,
     * which otherwise meets two words with nothing saying they are one choice.
     */
    beforeAfterLabel: "Before and after",
    rowLip: "Lip",
    rowBlush: "Blush",
    rowFoundation: "Foundation",
    rowEye: "Eye",
    saveLookAction: "Save this look",
    /** Render pending, for example "Applying rust lip". */
    applyingTemplate: "Applying {shade} {category}",
    previewUnavailable: "Preview unavailable for this shade.",
    /**
     * In house. docs/01 section H item 4 has "Save this look" save the selected
     * shades to the profile but gives no confirmation line. Toasts are one line,
     * sentence case, no icon (docs/02-design-system.md, Toast).
     */
    savedToast: "Saved to your profile.",
    /**
     * In house, for a save that never reached the profile. Written to the same
     * pattern as copy.errors.uploadFailed, and short enough to stay on one line
     * in the toast at 390px (docs/02-design-system.md, Toast).
     */
    saveFailed: "Your look was not saved. Try again.",
    /**
     * In house. docs/01 section H item 3 puts a product card under each selected
     * shade, and ProductCard names the product type when no listing came back
     * (docs/01 section F item 6). This is what names it, for example "Rust lip",
     * in the same two words as applyingTemplate.
     */
    shadeProductTypeTemplate: "{shade} {category}",
  },

  /** I. Hair (/hair) */
  hair: {
    /**
     * The doc's example is one full sentence pair for an oval face:
     * "Your face shape reads as oval. Most lengths and partings suit you; the
     * styles below add structure at the jaw." The first sentence is the
     * template. The second sentence is per face shape and lands with Layer 3.
     */
    faceShapeLineTemplate: "Your face shape reads as {shape}.",
    saveAction: "Save this",
    /** docs/01-user-flow.md section I names these two sections, items 2 and 3. */
    stylesHeading: "Styles",
    colorsHeading: "Colors",
    /**
     * In house. docs/01 section I states: "same pending and failed patterns as
     * Makeup", and section H's pending line is "Applying rust lip". These two
     * name what the person just chose, in the same two words.
     */
    applyingStyleTemplate: "Applying {style}",
    applyingColorTemplate: "Applying {color}",
    /**
     * In house, for the same reason: section H writes "Preview unavailable for
     * this shade." and section I asks for that pattern here. A style and a color
     * are two different choices, so each says which one has no preview rather
     * than borrowing the makeup sentence about a shade.
     */
    previewUnavailableStyle: "Preview unavailable for this style.",
    previewUnavailableColor: "Preview unavailable for this color.",
    /**
     * In house. docs/01 section I item 4 has "Save this" store the chosen style
     * and color but gives no confirmation line. Same wording as the makeup save,
     * because it is the same promise (docs/02-design-system.md, Toast: one line,
     * sentence case, no icon).
     */
    savedToast: "Saved to your profile.",
    /** In house, for a save that never reached the profile. */
    saveFailed: "Your hair choice was not saved. Try again.",
    /**
     * In house. docs/01 "Judge mode across the flow" has every screen render
     * from the saved demo profile, which nobody may write to. Saying so is the
     * true state; a confirmation toast there would claim a write that the server
     * refused.
     */
    saveReadOnly: "The demo profile is read only, so nothing was saved.",
    /**
     * In house. docs/01 section I item 3 puts the hair colors "inside the
     * palette", so with no palette there are no colors to show. The line says
     * what happened and what to do, which is what the global rules require of an
     * empty state.
     */
    colorsUnavailable:
      "Hair colors come from your palette. Confirm your undertone on the color screen and they will appear here.",
  },

  /** J. Wardrobe (/wardrobe) */
  wardrobe: {
    emptyBody:
      "Add what you own. Photos of a shirt, trousers, a jacket, shoes. Flat on a bed or hanging both work.",
    addAction: "Add garments",
    skipLine: "Or skip this. Looks can be built from new pieces near you.",
    correctChipsHint: "Tap a chip to correct it.",
    classificationFailed: "Could not read this one. Tap to fill in details.",
    /**
     * In house. docs/01 section J item 3 says the grid is "filterable by type"
     * but names neither the control nor the chip that clears the filter.
     */
    filterLabel: "Filter by type",
    filterAll: "All",
    /**
     * In house. docs/01 section J item 2 makes the chips tappable to correct but
     * gives no title for the sheet a tap opens, and no name for the three groups
     * inside it. The group names are the chips' own words.
     */
    correctSheetTitle: "Correct this garment",
    chipGroupType: "Type",
    chipGroupPattern: "Pattern",
    chipGroupFormality: "Formality",
    /**
     * In house. docs/01 section J describes the add flow but gives no line for
     * an upload that never landed. "Global states and rules" requires one that
     * says what happened and what to do.
     */
    addFailed: "Those garments were not added. Try again.",
    /** In house, for a correction that never reached the row. */
    correctionFailed: "That chip was not saved. Try again.",
    /**
     * In house. docs/01 "Judge mode across the flow" has every screen render
     * from the saved demo profile, which nobody may write to. Same promise as
     * hair.saveReadOnly, worded for a screen where the write is an add or a
     * correction rather than a save.
     */
    readOnly: "The demo profile is read only, so nothing was changed.",
    /**
     * In house. The wardrobe ceiling in src/lib/shared/wardrobe-view.ts. Kept
     * word for word the same as messages.wardrobeFull, so the sentence in the
     * refusal body and the sentence on the screen are one sentence.
     */
    full: "Your wardrobe is full. Remove a garment before adding more.",
  },

  /** K. Looks (/looks) */
  looks: {
    occasionInterview: "Interview",
    occasionWeddingGuest: "Wedding guest",
    occasionDate: "Date",
    occasionFestival: "Festival",
    occasionEveryday: "Everyday",
    occasionFormalEvening: "Formal evening",
    shopTheGapHeading: "Shop the gap",
    /** For example "You do not own shoes yet." */
    shopTheGapTemplate:
      "You do not own {garmentType} yet. These sit in your palette and are near you.",
    saveLookAction: "Save this look",
    tryAnotherOccasionAction: "Try another occasion",
    /** No wardrobe state, docs/01 section K states. */
    noWardrobe:
      "Built from pieces near you. Add your own garments to mix them in.",
    /**
     * In house. The doc's gap line ends "and are near you", which is only true
     * when a nearby store was found. docs/01 section K states: with location not
     * allowed the cards "drop the distance and say 'Online listing'", so the
     * sentence above them drops the claim too rather than saying near you about
     * a listing with no distance.
     */
    shopTheGapOnlineTemplate:
      "You do not own {garmentType} yet. These sit in your palette.",
    /**
     * In house. docs/01 section K item 1 is a row of occasion chips but gives
     * the row no name, and a group of chips needs one for a screen reader.
     */
    occasionsLabel: "Occasion",
    /**
     * In house. docs/01 section K states: "Try on pending: the flat lay shows
     * first; the rendered hero arrives when the job completes." These two are
     * the makeup pattern (section H states) worded for a garment, the same way
     * hair.applyingStyleTemplate is worded for a style.
     */
    applyingTemplate: "Applying the {garment}",
    previewUnavailable: "Preview unavailable for this garment.",
    /**
     * In house. docs/01 section K item 4 has "Save this look" but gives no
     * confirmation line. Same wording as the makeup and hair saves, because it
     * is the same promise (docs/02-design-system.md, Toast).
     */
    savedToast: "Saved to your profile.",
    /** In house, for a save that never reached the profile. */
    saveFailed: "This look was not saved. Try again.",
    /** In house. The demo profile is read only, so a save stored nothing. */
    saveReadOnly: "The demo profile is read only, so nothing was saved.",
    /**
     * In house. docs/01 section K covers an empty wardrobe but not a wardrobe
     * that holds nothing this occasion can use, which the rules engine answers
     * with no looks at all. The line says what happened and the two ways out.
     */
    noLooksForOccasion:
      "Nothing in your wardrobe fits this occasion yet. Try another occasion, or add garments.",
    /**
     * In house. docs/01 "Global states and rules" requires an error that says
     * what happened and what to do; the flow doc writes none for a looks request
     * that did not come back.
     */
    unavailable: "Your looks could not be loaded. Try again in a moment.",
    /**
     * The accessory try on in the top look,
     * docs/09-build-order-and-demo.md Layer 6: "One accessory try on in the top
     * look (earrings or a bag) from the fashion APIs".
     *
     * All in house. docs/01-user-flow.md section K composes garments and does not
     * word this affordance. The button is a plain verb that says what happens,
     * the pending and unavailable lines follow section H's pattern the same way
     * the garment ones above do, and the three category names are the words a
     * person would use for the thing they photographed.
     */
    addAccessoryAction: "Add an accessory",
    accessoryCategoriesLabel: "Accessory",
    accessoryEarrings: "Earrings",
    accessoryBag: "Bag",
    accessoryWatch: "Watch",
    applyingAccessoryTemplate: "Applying the {accessory}",
    previewUnavailableAccessory: "Preview unavailable for this accessory.",

    /**
     * The deterministic rationale, used when the stylist call cannot run or its
     * answer fails the hard checks. docs/03-architecture.md, "Failure modes":
     * "the stylist ranks looks by the rules alone with a one line rule based
     * rationale". In house, all of it: the flow doc writes the model's example
     * sentence pair and gives the fallback no words.
     *
     * Two sentences at most, assembled by src/lib/server/looks/rationale.ts. The
     * first names the person's coloring, the second names the occasion, which is
     * the standard docs/04-integrations.md sets for the model.
     */
    rationale: {
      colorTemplate:
        "{color} sits in your {season} palette, so it holds its own next to your skin.",
      avoidColorTemplate: "{color} stays below the waist, away from your face.",
      noColorTemplate:
        "None of these colors sit in your {season} palette, so this look is put together on formality rather than color.",
      occasionTemplate: "For {occasion}, {reason}.",
      reasonOwnedPieces: "these are the pieces you own that fit",
      reasonListings:
        "every piece here is a live listing rather than something you own",
      /** The occasion inside a sentence. The chips above are its label. */
      phraseInterview: "an interview",
      phraseWeddingGuest: "a wedding",
      phraseDate: "a date",
      phraseFestival: "a festival",
      phraseEveryday: "everyday wear",
      phraseFormalEvening: "a formal evening",
    },
  },

  /** L. Profile (/profile) */
  profile: {
    rowSkinType: "Skin type",
    rowTopConcern: "Top concern",
    rowToneAndUndertone: "Tone and undertone",
    rowSeason: "Season",
    rowFaceShape: "Face shape",
    rowHairType: "Hair type",
    retakeAffordance: "Retake",
    adjustAffordance: "Adjust",
    savedHeading: "Saved",
    /**
     * In house. docs/01 section L item 2 lists "saved makeup look" as one of the
     * three saved items but gives no label for the row, and unlike the other two
     * this one has no name of its own to borrow: a saved hair choice carries its
     * style name and a saved look carries its occasion, while a saved makeup
     * look is a list of shades. So the label names the row and the shade names
     * sit in the detail beside it, which is the same shape as the rows above.
     */
    savedMakeupLabel: "Makeup look",
    dataHeading: "Data",
    keepOriginalsToggle: "Keep original photos",
    downloadAction: "Download my data",
    deleteAction: "Delete everything",
    deleteBody:
      "This removes your photos, readings, garments, and looks. It cannot be undone.",
    /** The typed confirmation token. The person types this exactly. */
    deleteConfirmWord: "DELETE",
    // In house. docs/01 section L requires a typed confirmation but gives no
    // label for the field.
    deleteConfirmLabel: "Type DELETE to confirm",
    /**
     * In house. docs/01 section L item 1 lists the six summary rows and their
     * affordances but writes no line for a row whose value was never read. An
     * empty cell or a dash would be a placeholder, which docs/02-design-system.md
     * forbids (anti slop checklist item 10), so the row says the true thing and
     * the "Retake" or "Adjust" link beside it is what to do about it.
     */
    valueUnavailable: "Not read from your photo yet.",
    /**
     * In house. docs/01 section L item 2 lists what "Saved" holds but not what
     * it says while it holds nothing. "Global states and rules": empty screens
     * invite action with one specific verb.
     */
    savedEmpty:
      "Nothing saved yet. Save a makeup look, a hair choice, or an outfit and it appears here.",
    /**
     * In house. docs/01 "Judge mode across the flow" has every screen render
     * from the saved demo profile, which nobody may write to. Word for word the
     * same as wardrobe.readOnly, because it is the same refusal: a write the
     * server declined, reported rather than dressed up as a save.
     */
    readOnly: "The demo profile is read only, so nothing was changed.",
    /**
     * In house. docs/06-safety-privacy.md, "Keys, sessions, abuse": "Judge
     * sessions cannot delete the demo profile and cannot download data", and the
     * flow doc writes no line for the refusal. The control stays on the screen
     * because docs/01 section L item 3 puts it there and only the delete control
     * is hidden from a judge, so the screen says why instead of handing the
     * person a file holding an error where their data should be.
     */
    downloadReadOnly:
      "The demo profile is read only, so it cannot be downloaded.",
    /**
     * In house. docs/01 section L item 3 mirrors the retention choice here but
     * gives no line for a choice that never reached the profile, and "Global
     * states and rules" requires one that says what happened and what to do.
     */
    keepOriginalsFailed: "Your choice was not saved. Try again.",
    /**
     * In house. docs/01 section L writes the delete copy and the "Deleted."
     * toast but nothing for a delete the server refused. Saying nothing was
     * deleted is the only honest answer: the person must never be told their
     * data is gone when it is not.
     */
    deleteFailed: "Nothing was deleted. Try again.",
    /**
     * In house. docs/01 "Global states and rules" requires an error that says
     * what happened and what to do; the flow doc writes none for a profile
     * request that did not come back. Same shape as looks.unavailable.
     */
    unavailable: "Your profile could not be loaded. Try again in a moment.",
    /**
     * In house. docs/01 section L item 1 names the row "Skin type" but gives it
     * no words. The reading itself is two zones
     * (src/lib/server/profile/skin-type.ts), so the row says the type and then
     * the two zones it was read from, in the same plain vocabulary the report
     * uses: "Combination, oily T zone and dry cheeks". Used only when the two
     * zones differ; when they agree the row is the type word on its own, because
     * "Balanced, balanced T zone and balanced cheeks" says one thing three times.
     */
    skinTypeValueTemplate: "{label}, {tZone} T zone and {cheeks} cheeks",
    /**
     * In house, for the same reason, on the "Tone and undertone" row. The tone
     * half is the depth the palette layer reads off the photo (deep, medium,
     * light) and the undertone half is the word the person can overrule on
     * /color: "Deep tone, warm undertone".
     */
    toneValueTemplate: "{depth} tone, {undertone} undertone",
  },

  /**
   * Global errors. Errors explain and direct: what happened and what to do.
   * Never "Something went wrong."
   */
  errors: {
    providerTimeout:
      "Perfect Corp did not respond in time. Your photo is safe. Try again in a moment.",
    // docs/03-architecture.md, "Failure modes and what the person sees".
    uploadFailed:
      "Upload did not complete. Your photo was not saved. Try again.",
    /** Judge session at zero, shown across the flow. docs/01 "Judge mode". */
    judgeExhausted:
      "This session has used its analyses. Exploring the saved demo profile.",
    /**
     * In house. docs/01 "Global states and rules" requires errors that say what
     * happened and what to do, but gives no line for a request that never
     * reached the server. Used by the consent post, the judge code post, and the
     * job poll.
     */
    requestFailed:
      "The app could not reach the server. Check your connection and try again.",
    /**
     * In house. The server answered 401, so requestFailed above would be untrue:
     * the app reached the server and the server said there is no session on this
     * device. docs/01 "Global states and rules" asks an error to say what
     * happened and what to do, and docs/01 section B is the door a judge is
     * meant to come through, so the line names it.
     */
    sessionMissing:
      "This screen needs a session. If you are judging, enter your access code first.",
  },

  /** Toasts: one line, sentence case, no icons, gone in 3 seconds. */
  toasts: {
    deleted: "Deleted.",
  },

  /**
   * Labels for controls the docs describe but do not name. In house, kept to the
   * smallest set that keeps every control reachable by a screen reader.
   */
  common: {
    close: "Close",
  },
} as const;

export type Copy = typeof copy;

/**
 * Copy written in house because docs/01-user-flow.md specifies the state but
 * not its words. Each path is dotted from the copy root. The safety eval checks
 * that every path still resolves, so a string cannot be quietly promoted to
 * "from the doc" or deleted without updating this list.
 *
 * Open item for the human: approve or replace every line in this list, then move
 * the approved wording into docs/01-user-flow.md so this list can shrink.
 */
export const COPY_NOT_IN_FLOW_DOC = [
  "capture.rejection.over_exposed",
  "capture.rejection.no_face",
  "capture.cameraUnavailable",
  "capture.shutterLabel",
  "judge.exploreDemoAction",
  "productCard.distanceTemplate",
  "report.maskTogglesLabel",
  "color.adjusterFailed",
  "profile.savedMakeupLabel",
  "makeup.beforeAfterLabel",
  "makeup.savedToast",
  "makeup.saveFailed",
  "makeup.shadeProductTypeTemplate",
  "hair.applyingStyleTemplate",
  "hair.applyingColorTemplate",
  "hair.previewUnavailableStyle",
  "hair.previewUnavailableColor",
  "hair.savedToast",
  "hair.saveFailed",
  "hair.saveReadOnly",
  "hair.colorsUnavailable",
  "wardrobe.filterLabel",
  "wardrobe.filterAll",
  "wardrobe.correctSheetTitle",
  "wardrobe.chipGroupType",
  "wardrobe.chipGroupPattern",
  "wardrobe.chipGroupFormality",
  "wardrobe.addFailed",
  "wardrobe.correctionFailed",
  "wardrobe.readOnly",
  "wardrobe.full",
  "looks.shopTheGapOnlineTemplate",
  "looks.occasionsLabel",
  "looks.applyingTemplate",
  "looks.previewUnavailable",
  "looks.savedToast",
  "looks.saveFailed",
  "looks.saveReadOnly",
  "looks.noLooksForOccasion",
  "looks.unavailable",
  "looks.rationale.colorTemplate",
  "looks.rationale.avoidColorTemplate",
  "looks.rationale.noColorTemplate",
  "looks.rationale.occasionTemplate",
  "looks.rationale.reasonOwnedPieces",
  "looks.rationale.reasonListings",
  "looks.rationale.phraseInterview",
  "looks.rationale.phraseWeddingGuest",
  "looks.rationale.phraseDate",
  "looks.rationale.phraseFestival",
  "looks.rationale.phraseEveryday",
  "looks.rationale.phraseFormalEvening",
  "looks.addAccessoryAction",
  "looks.accessoryCategoriesLabel",
  "looks.accessoryEarrings",
  "looks.accessoryBag",
  "looks.accessoryWatch",
  "looks.applyingAccessoryTemplate",
  "looks.previewUnavailableAccessory",
  "report.projectionHeading",
  "report.projectionFraming",
  "report.projectionAction",
  "report.projectionPending",
  "report.projectionUnavailable",
  "report.projectionConcernsTemplate",
  "report.fallbackReadingNoSkinTypeTemplate",
  "report.fallbackSecondConcernTemplate",
  "report.fallbackGoingWellTemplate",
  "report.fallbackGoingWellSingularTemplate",
  "profile.deleteConfirmLabel",
  "profile.valueUnavailable",
  "profile.savedEmpty",
  "profile.readOnly",
  "profile.downloadReadOnly",
  "profile.keepOriginalsFailed",
  "profile.deleteFailed",
  "profile.unavailable",
  "profile.skinTypeValueTemplate",
  "profile.toneValueTemplate",
  "errors.requestFailed",
  "errors.sessionMissing",
  "common.close",
  "privacy.points.0",
  "privacy.points.1",
  "privacy.points.2",
  "privacy.points.3",
  "privacy.points.4",
] as const;

/**
 * The rejection line for a quality gate reason. Indexing by the union makes a
 * missing reason a compile error, so quality.ts and copy.ts cannot drift.
 */
export function captureRejectionCopy(reason: CaptureRejectionReason): string {
  return copy.capture.rejection[reason];
}

/**
 * Fills {token} placeholders in a copy template. Throws when a token has no
 * value, because a half filled sentence must never reach a person.
 */
export function fill(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  const missing: string[] = [];
  const filled = template.replace(/\{(\w+)\}/gu, (match, token: string) => {
    const value = values[token];
    if (value === undefined) {
      missing.push(token);
      return match;
    }
    return String(value);
  });
  if (missing.length > 0) {
    throw new Error(
      `Copy template is missing values for: ${missing.join(", ")}`,
    );
  }
  return filled;
}

/**
 * The judge banner with a live count. The doc shows the plural form; the
 * singular form avoids "1 analyses remaining" at the end of a session.
 */
export function formatJudgeBanner(remaining: number): string {
  const template =
    remaining === 1 ? copy.judge.bannerTemplateSingular : copy.judge.bannerTemplate;
  return fill(template, { count: remaining });
}

/**
 * The skin age line. The estimate and its framing sentence are always returned
 * together, per docs/06-safety-privacy.md "Required framing".
 */
export function formatSkinAge(age: number): string {
  return `${fill(copy.report.skinAgeTemplate, { age })} ${copy.report.skinAgeFraming}`;
}
