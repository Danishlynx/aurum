# 08. Git workflow

The repo is public and must stay public after the hackathon (a hackathon rule; if the repo or the video goes private, winners can be re selected). Build as if every commit will be read by a judge, because it might be.

## Branches

    main        production. Protected. Deploys to the live URL. Only receives merges from develop or hotfix branches.
    develop     integration. Protected. Every feature PR targets develop. Deploys to a preview URL.
    feature/*   one branch per layer or per concern, cut from develop
    fix/*       bug fixes, cut from develop
    hotfix/*    urgent fixes cut from main, merged to main and back to develop
    docs/*      documentation only
    chore/*     tooling, dependencies, config

Naming: feature/L1-skin-report, feature/L2-color-identity, feature/L4-wardrobe-classifier, fix/capture-exposure-gate, chore/eslint-dash-rule, docs/devpost-writeup. Lowercase, hyphens, the layer number where it applies.

## Protection rules (set in GitHub)

- main and develop: require a pull request, require the CI checks to pass, require linear history (squash merge only), no force pushes, no direct commits.
- Required checks: build, lint, typecheck, test, eval:smoke.
- Delete head branches on merge.

## Commits

Conventional commits, present tense, under 72 characters in the subject, no em dashes or en dashes anywhere in the message.

    feat(report): render concern masks with tone first ranking
    fix(capture): reject frames with blown highlights on the forehead
    chore(ci): add em dash lint rule
    docs(flow): add wardrobe empty state copy
    eval(palette): add golden files for three fixture profiles

Body when needed: what changed and why, and the doc section it implements ("Implements docs/01-user-flow.md section F").

Never commit: .env files, provider keys, real people's photos, recorded provider responses that contain a real person's data, node_modules, build output.

## Pull requests

- One layer or one concern per PR. Prefer several small PRs over one large one.
- Use the template in .github/pull_request_template.md. Fill every section; delete none.
- Include: the doc section implemented, screenshots at 390px for any UI change, eval results for the affected suites, and any golden file changes with a reason.
- Self review against the anti slop checklist before requesting review.
- Squash merge into develop. The squash message follows the commit convention.

## Releases and tags

- Merge develop into main when a layer is complete and verified on the preview URL.
- Tag on main: v0.1.0-L1 after Layer 1, v0.2.0-L2 after Layer 2, and so on. Semantic version plus the layer.
- Before the deadline: tag hackathon-submission on the exact commit deployed at the live URL. Put the tag and the commit sha on the Devpost page. Do not push to main after the tag until judging ends; use develop for anything further.

## CI (GitHub Actions)

On every PR to develop or main:

1. npm ci
2. npm run lint (includes the dash rule and the no hex in components rule)
3. npm run typecheck
4. npm run build
5. npm run test
6. npm run eval:smoke

On a schedule (nightly, manual dispatch allowed): eval:consistency and the live grounding check, using a dedicated low quota key, with results uploaded as artifacts. These spend credits, so they never run on PRs.

Secrets for CI are GitHub Actions secrets. The build step verifies that no provider key prefix appears in the client bundle.

## How Claude Code works in this repo

1. Start every task by reading CLAUDE.md and the doc section for the layer.
2. git checkout develop, git pull, then git checkout -b feature/L<n>-<name>.
3. Implement with real copy from copy.ts and real tokens from the design system.
4. Run build, lint, typecheck, test, and the layer's eval suites locally. Fix before committing.
5. Commit in small, conventional commits.
6. Take the 390px screenshots, run the anti slop checklist, fix, then open the PR with the template filled in.
7. After merge, check the develop preview URL on a phone.
8. Never merge to main yourself unless the human asked for a release.

## Hackathon submission hygiene

- README.md at the root: what it is in three sentences, a screenshot of the reveal, the live URL, the judge access note, setup instructions that work from a clean clone, the stack, and a one line per sponsor note on where Perfect Corp and SerpApi do real work.
- LICENSE: choose one and include it.
- .env.example complete and current.
- No secrets in history. If one ever lands, rotate it immediately and rewrite history before the submission tag.
