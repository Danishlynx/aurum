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
  },

  /** Product card, used on /report, /makeup, /hair, and /looks. */
  productCard: {
    viewListing: "View listing",
    notSponsored: "Chosen from live listings, not sponsored.",
    noListing: "No listing found near you yet",
    /** Location not allowed, docs/01 section K states. */
    onlineListing: "Online listing",
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
  },

  /** H. Makeup (/makeup) */
  makeup: {
    before: "Before",
    after: "After",
    rowLip: "Lip",
    rowBlush: "Blush",
    rowFoundation: "Foundation",
    rowEye: "Eye",
    saveLookAction: "Save this look",
    /** Render pending, for example "Applying rust lip". */
    applyingTemplate: "Applying {shade} {category}",
    previewUnavailable: "Preview unavailable for this shade.",
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
  },

  /** J. Wardrobe (/wardrobe) */
  wardrobe: {
    emptyBody:
      "Add what you own. Photos of a shirt, trousers, a jacket, shoes. Flat on a bed or hanging both work.",
    addAction: "Add garments",
    skipLine: "Or skip this. Looks can be built from new pieces near you.",
    correctChipsHint: "Tap a chip to correct it.",
    classificationFailed: "Could not read this one. Tap to fill in details.",
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
  "profile.deleteConfirmLabel",
  "errors.requestFailed",
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
