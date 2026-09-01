# 02. Design system

Direction, chosen by the human: dark luxe. Black, subtle gold, spa like. Follow it exactly. Where the brief leaves an axis free, do not spend that freedom on a default. The generic version of "dark with an accent" is a cold tinted black with one bright acid color, identical rounded cards with the same soft shadow, all caps eyebrow labels, and a fade up on every section. We are not building that.

## The idea behind the look

A spa at night. Warm stone, candlelight, brushed brass, linen. The screen is not a black rectangle with neon on it; it is a dim, warm room where the only bright thing is the person's own face. Gold is a material, not a highlighter: it appears as thin hairlines, as the translucent leaf that settles over the face during the reveal, and as the one primary action on a screen. Everything else is quiet.

The signature element is the reveal: the person's selfie with concern masks blooming in translucent antique gold and settling into swatches. Spend all the boldness there. Every other screen is disciplined.

## Tokens

Define these as CSS variables in src/styles/tokens.css and expose them through the Tailwind theme. Components use tokens only; no raw hex in components.

Color

- canvas, Obsidian: #0C0A09. A warm black with a trace of brown, because candle and stone light is warm. Not blue black, not neutral grey black.
- surface, Basalt: #171310. Cards, sheets, skeleton rows.
- raised, Umber: #26201B. Hairlines, dividers, raised rows, disabled fills.
- text, Ivory: #F1E9DB. Primary text.
- text-muted, Sand: #A89C88. Secondary text, captions, disabled text.
- accent, Antique gold: #B7955A. Primary button fill, selected hairlines, score bars, the one accent per screen.
- accent-bright, Champagne: #E2C88F. Used only for the selected swatch ring and the live "Good. Tap to capture" frame. Never for text blocks.
- mask, Leaf: rgba(183, 149, 90, 0.42). The translucent overlay for concern masks on the face.
- positive, Olive: #7F8A5E. "Going well" indicators only.
- caution, Amber: #B0783A. Borderline capture frames only.
- There is no red. Errors are Ivory text on Basalt with a gold hairline; the words carry the meaning.

Contrast, verified: Ivory on Obsidian about 16:1. Sand on Obsidian about 8:1. Antique gold on Obsidian about 6.9:1, which passes AA for body text, so gold captions are allowed. Ivory on gold fails, so primary buttons use Obsidian text on a gold fill.

Typography

- Display: Cormorant Garamond, weights 300 and 400, italic 400 for occasional single word emphasis inside a sentence (rare, never in headlines). Used for the headline, section titles, the reading, and swatch names. Loaded with next/font/google.
- Body: Manrope, weights 400, 500, 600. Used for body copy, buttons, chips, labels, and numbers. Loaded with next/font/google.
- The two families are clearly distinct on purpose: a high contrast old style serif against a soft geometric sans.

Type scale (size / line height), mobile first

- display-1: 44 / 48, Cormorant 300, letter spacing -0.01em (landing headline only)
- display-2: 32 / 38, Cormorant 300 (screen titles)
- title: 24 / 30, Cormorant 400 (section titles, swatch names)
- reading: 19 / 30, Cormorant 400 (the consultant reading blocks; serif body gets the extra line height)
- body: 16 / 24, Manrope 400
- body-strong: 16 / 24, Manrope 600
- small: 14 / 20, Manrope 400 (captions, product meta)
- micro: 12 / 16, Manrope 500 (banner, chips)

Line length: body under 70 characters; reading blocks under 64.

Spacing: a 4px base. Use 4, 8, 12, 16, 24, 32, 48, 64. Section rhythm on a screen is 32 between sections, 16 between rows, 8 between a label and its content.

Radius: exactly two values plus one shape. radius-sm 6px for chips, fields, buttons. radius-md 12px for product cards and sheets. The capture frame is an oval. Nothing else is rounded; the hero selfie is square cornered.

Elevation: none. No drop shadows anywhere. Depth comes from tonal layering: Obsidian canvas, Basalt surfaces, Umber raised rows, and 1px hairlines in Umber. A selected or focused element gets a 1px Antique gold hairline. That is the whole elevation system.

Iconography: Lucide, 1.5px stroke, 20px, Sand by default, Ivory when active. No filled icons, no sparkles, no wand, no stars, no "AI" badge of any kind. Icons never appear without a text label except the shutter and the back control.

## Layout

Mobile first at 390px. Content column has 20px side padding. On desktop, the app renders a 480px column centered on the Obsidian canvas with the same padding; it never reflows into multi column dashboards.

Alignment: left aligned throughout. The only centered elements are the landing headline, the judge access field, and the shutter control.

Screen skeleton

    ┌──────────────────────────────┐
    │ judge banner (if active)      │  micro, gold hairline below
    │ back        title    profile  │  display-2 title, left aligned
    ├──────────────────────────────┤
    │ hero (selfie or swatch)       │  square, full column width
    │ reading block                 │  serif, 19/30
    │ section title                 │  Cormorant 24
    │ row                           │  16 between rows
    │ row                           │
    │ ...                           │
    ├──────────────────────────────┤
    │ bottom nav (5 items)          │  Manrope micro, Sand, active Ivory
    └──────────────────────────────┘

## Components

Button

- primary: Antique gold fill, Obsidian text, Manrope 600 16, height 52, radius-sm, full width on mobile. One per screen.
- secondary: transparent, 1px Umber hairline, Ivory text. Hover and focus move the hairline to gold.
- quiet: text only, Sand, underlined on focus. For "Retake photo" and similar.
- Labels are verbs that say what happens: "Start with a selfie", "Save this look", "Delete everything". Never "Submit", never "OK", never an arrow appended.
- Disabled: Umber fill, Sand text, no opacity tricks.

Chip: Manrope 500 12, height 32, radius-sm, Basalt fill, Umber hairline. Selected: gold hairline, Ivory text. Used for occasions, garment attributes, concern toggles.

Swatch: a square of the color with a 1px Umber hairline, name below in Cormorant 24 for palette swatches or Manrope 14 for shade rows. Selected: Champagne ring 2px. Tapping opens one line of why below the row, not a tooltip.

MaskToggle: a chip row above the hero. The active one shows its Leaf mask on the face. Exactly one active at a time.

ReadingBlock: Cormorant 19/30 in Ivory on the canvas, no box, no border. Maximum five sentences.

RoutineRow: step name (Manrope 600), the concern tag ("for pigmentation") in gold micro, one sentence of why in Sand, then the ProductCard. The routine is a real sequence, so numbering the steps is appropriate here and only here.

ProductCard: radius-md, Basalt fill, 1px Umber hairline. A 1:1 image frame on the left (product image on Basalt with 8px padding, never cropped edge to edge). Name in Ivory body, price and store in Sand small, distance in Sand small when known, "View listing" as a quiet link. A single Sand micro line under the card: "Chosen from live listings, not sponsored."

SkeletonRow: the exact shape of the content it replaces, in Basalt, static. No shimmer, no pulse.

Banner (judge): full width, Basalt, gold hairline below, Manrope 12 in Sand with the count in Ivory.

Sheet: slides up from the bottom, Basalt, radius-md on the top corners, a 32px Umber drag handle. Used for the undertone adjuster, the privacy sheet, and confirmations.

Field: Basalt fill, Umber hairline, Ivory text, gold hairline on focus, 52 height. Placeholder in Sand.

Toast: bottom, Basalt, Ivory text, one line, 3 seconds, no icon.

## Motion

- One orchestrated, non user triggered moment in the whole app: the reveal on /analyzing (and its preview on the landing hero). Masks bloom over 600ms with an ease out curve, then settle over 300ms. Steps are driven by job completion, never by timers.
- Everything else moves only in answer to a tap: sheets 280ms, toggles 180ms, hero re render crossfade 240ms. Ease out for entrances, ease in out for state changes.
- No fade up on sections, no hover lift on cards, no parallax, no floating blobs, no gradient sweeps, no typing effects.
- prefers-reduced-motion: the reveal shows masks without animation and all durations drop to 0. Status text still updates.

## Imagery

- The only hero image in the product is the person's own face. Landing uses a consented fixture face for the reveal preview.
- No stock photography, no illustrations, no 3D renders, no abstract "AI" art.
- Product images come from SerpApi thumbnails and sit inside the fixed 1:1 frame with padding so mismatched sizes still look composed.
- Try on renders replace the hero with a 240ms crossfade; the previous render stays at 70 percent while the next one loads.

## Writing inside the design

- Sentence case everywhere. No all caps labels, no eyebrow labels above headings.
- Plain verbs. Buttons say what happens. Errors say what happened and what to do next.
- Specific over clever. "Pigmentation on the cheekbones" beats "your skin story".
- No exclamation marks. No "amazing", "perfect", "flawless", "glow", "unlock", "elevate", "journey".
- No em dashes or en dashes. Use commas, colons, periods, parentheses.
- Numbers are quiet. A concern score is a thin bar with the number in Sand small beside it, never a large display figure.

## Anti slop checklist

Run this on every screen screenshot before opening a PR. Any hit is a fix, not a note.

1. Is there a gradient anywhere other than the single radial vignette behind the hero on /analyzing? Remove it.
2. Is there a drop shadow? Remove it; use tonal layering.
3. Is there an all caps label, an eyebrow above a heading, or a "01 / 02 / 03" marker on content that is not a sequence? Remove it.
4. Are there three or more identical cards in a grid with the same radius and the same shadow? Rework into rows with hairlines, or vary hierarchy.
5. Is there an arrow appended to a button or link, or middle dots joining meta text? Remove them.
6. Is there an icon without a label, a sparkle, a wand, a star rating, or an "AI" badge? Remove it.
7. Is anything animating that the person did not trigger, other than the reveal? Remove it.
8. Is there a spinner over a face, or a shimmer on a skeleton? Replace with static Basalt skeletons.
9. Is the hero a big number with a small label? Replace with the person's face or a swatch.
10. Is any copy an exclamation, a superlative, an em dash, or a placeholder? Rewrite from copy.ts.
11. Does the screen still make sense at 390px with 20px padding and a 44px minimum tap target? Fix it.
12. Is keyboard focus visible (gold hairline) and does reduced motion disable the reveal animation? Fix it.
13. Chanel's rule: remove one thing. If the screen survives, it was decoration.

## Tailwind wiring

- src/styles/tokens.css declares the variables on :root.
- tailwind.config.ts extends colors with canvas, surface, raised, text, text-muted, accent, accent-bright, positive, caution; extends fontFamily with display and body; sets borderRadius to sm 6px and md 12px only; disables boxShadow.
- next/font/google loads Cormorant Garamond (300, 400, 400 italic) and Manrope (400, 500, 600) with display swap and CSS variables that the Tailwind fontFamily entries reference.
- ESLint includes a rule that fails on any hex color literal inside src/components and src/app.
