# 00. Product

## One line

AURUM turns one selfie into a personal aesthetic profile, then uses that profile to decide skin routine, flattering colors, makeup, hair, and outfits, with every product grounded in a real listing you can buy near you.

## The problem, stated specifically

A person who wants to look their best for something (an interview, a wedding, a date, a festival) today opens four unrelated apps: a skin quiz that only recommends one brand's shelf, a color analysis tool that assumes light skin, a hairstyle try on that knows nothing about their skin tone, and a closet app that cannot tell them what suits their coloring. None of them share a model of the person. Each starts from zero, and each one's advice contradicts the others.

Three specific failures underneath that:

1. Brand locked advice. The skin analysis tools most people encounter are embedded in a brand's site and exist to sell that brand's products. The analysis is a funnel to a predetermined answer. The person never learns whether a cheaper product from another brand would serve their skin better.

2. Tools built for light skin. Peer reviewed work shows skin algorithms lose accuracy on darker skin, and the Fitzpatrick scale most tools rely on was built in 1975 to predict sunburn, compressing most of the world's skin tones into a few types. The concerns that dominate deeper and olive skin (hyperpigmentation, dark spots, uneven tone, post acne marks) are treated as afterthoughts by tools tuned for wrinkles and redness. Color advice built on that foundation is wrong for most of humanity.

3. No shared profile. Skin tone decides which lipstick shade works, which hair color flatters, which clothing colors sit well, and which foundation to buy. The information exists after one photo, but no product carries it across decisions. The person re answers the same questions in every app and still guesses at the end.

## Who it is for

Primary: adults (18 plus) who care about presenting well and are tired of guessing. The wedge audience is people with deeper and olive skin tones (Indian, South and East Asian, Black, Middle Eastern, Latin) because they are the most underserved by existing tools and the most likely to feel the difference immediately. The product works for every skin tone; it leads with the ones others fail.

Secondary, later: salons, makeup artists, and retailers who want a neutral consultation tool that does not push a single brand.

## Why now

- Perfect Corp's API now exposes the full stack in one place: dermatologist verified skin analysis with per concern scores and pixel masks, Fitzpatrick typing, detection of skin tone plus eye and hair color, face shape, hair type, makeup try on across 13 categories, hairstyle and hair color try on, cloth try on, and nine accessory try on APIs launched in January 2026. Two years ago building this required five vendors and a computer vision team.
- Live product data is one API call away. SerpApi returns structured Google Shopping and Maps results, so a recommendation can be a real listing with a price and a store, not a generic "use a gentle cleanser".
- Frontier models can now read fourteen interacting skin scores and write one coherent, specific story, and can look at a photo of a shirt and describe its color, pattern, and formality. The synthesis layer that used to require a human consultant is now a well designed prompt with guardrails.

## What we are building

A mobile first web app with one spine and several lenses.

The spine is the aesthetic profile. From one guided selfie we derive:

- skin concerns with scores and masks
- Fitzpatrick type and detected skin tone
- undertone (warm, cool, neutral), confirmed or adjusted by the person
- eye color and natural hair color
- face shape
- hair type (texture, curl pattern)

The lenses read from the profile:

- Skin report and routine: concerns ranked tone first, an AM and PM routine where every step is tied to a detected concern, every product a live listing.
- Color identity: a seasonal palette derived from tone, undertone, eye and hair color, with colors to wear and colors to avoid. This single layer drives makeup shades and clothing colors, which is what makes the app feel like one product.
- Makeup: recommended shades rendered on the person's own selfie, with products.
- Hair: styles that suit the face shape and hair type, colors that sit inside the palette, rendered as try ons.
- Wardrobe and Looks: the person uploads garments; the app classifies them, composes occasion ready combinations using color harmony and formality rules, has a stylist model rank them with reasons, renders the hero garment on the person, and shops the gaps within their palette and near their location.

## What we are not building

- Not a medical product. No diagnoses, no disease names, no prescription products. See docs/06-safety-privacy.md.
- Not real time AR. Perfect Corp's web API is photo in, result out, with async polling. Live mirror try on is their native SDK and is out of scope. The experience is designed around one great capture and a beautiful reveal.
- Not a marketplace. We show listings and link out. We do not process payments in this build. See docs/07-payments-and-judge-mode.md.
- Not a social app. No feeds, no sharing of other people's faces.

## Positioning and differentiation

Say this plainly in the pitch, name the alternatives, and state the wedge. Never claim empty space.

- Versus brand embedded skin quizzes: they analyze your skin to sell their shelf. AURUM analyzes your skin and finds the best product at any price from any brand, with the listing as proof. The neutrality is a business model position, not a feature.
- Versus generic consumer skin apps: they rank wrinkles and redness first and monetize through sponsored placement. AURUM leads with the concerns that dominate deeper and olive skin, and grounds every product in a live listing rather than a curated, stale catalog.
- Versus closet and outfit apps: they know your clothes but not your coloring. AURUM composes outfits from a palette derived from your actual skin, hair, and eyes.
- Versus one feature try on tools: they answer one question and forget you. AURUM keeps one profile that every decision reads from, so using one feature improves the next.

The differentiator, in one sentence: not the analysis, the profile and the incentive. One profile every decision reads from, and no horse in the race.

## The hackathon lens

Overall judges score Progress (how much was built), Concept (does it solve a real problem), Feasibility (could it be a company). The Top 5 are shown as videos on a stage; there is no live pitch. Perfect Corp judges want at least one of their APIs integrated meaningfully, clear consumer or retail value, a 1 to 3 minute video, and a project page with write up and screenshots.

Implications for how we build:

- Progress is visible surface area that works end to end. Finish layers; do not half build all of them. See docs/09-build-order-and-demo.md.
- Concept is the specific problem above, told in one sentence in the first ten seconds of the video.
- Feasibility is the company thesis below, said out loud, with alternatives named.
- The video is the pitch. The reveal on the person's own face is the signature moment. Design for it.

## Company thesis

Demand: anyone who gets ready for anything. Willingness to pay is proven by the beauty consultation, personal styling, and color analysis industries, which today are human services priced from tens to hundreds of dollars per session.

Who pays and how (details in docs/07-payments-and-judge-mode.md):

- Affiliate commission on grounded products. Every recommendation already links to a real listing; commission is the natural first revenue with zero friction for the person.
- Premium tier: progress tracking over time (Perfect Corp's skin simulation for before and after), unlimited looks, seasonal refreshes, priority renders. Razorpay for India, Stripe globally, added after the hackathon.
- B2B licensing later: a neutral consultation tool for salons, makeup artists, and multi brand retailers who want to recommend across brands.

Moat, honestly:

- The profile is data gravity. It gets richer with every feature used, and a person does not rebuild it elsewhere.
- Neutrality is counter positioning. Brand embedded tools cannot copy a cross brand recommender without cannibalizing their own shelf.
- Tone first expertise compounds. Every correction a person makes to their undertone or palette is training signal for the population existing tools serve worst.

Risks to say out loud: skin apps exist and try on tools exist; the incumbents could add cross brand recommendations; the wardrobe combination logic is stylist reasoning, not a trained aesthetic model. The answer to each is the profile, the neutrality, and the tone first wedge.

## Success for this build

- A judge with the access code can go from landing to a finished skin report with grounded products in under two minutes on a phone.
- The color identity, makeup, and hair layers read from the same profile without re capturing.
- At least one complete Look composed from uploaded garments for a chosen occasion, with a rendered try on and shoppable gaps.
- A 1 to 3 minute video whose first ten seconds state the problem and whose first thirty seconds show the reveal.
- Zero medical language in any generated copy, verified by the safety eval.

## Voice

Calm, precise, warm. The app speaks like a good consultant who respects the person's time: plain verbs, sentence case, specific claims, no hype. It never flatters emptily and never shames. It explains why, briefly, every time it recommends.
