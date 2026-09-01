## What this implements

Doc section: (for example, docs/01-user-flow.md section F, Skin report)

Layer: L0 / L1 / L2 / L3 / L4 / L5 / L6

## Summary

Two to four sentences. What changed, why, and anything a reviewer should look at first.

## Screenshots (UI changes only)

Attach every new or changed screen at 390px width. Note which anti slop checklist items you checked and what you removed.

## Evals

List the suites you ran and the results. Paste the key numbers.

    npm run build        pass / fail
    npm run lint         pass / fail
    npm run typecheck    pass / fail
    npm run test         pass / fail
    npm run eval:smoke   pass / fail
    Layer suites:        (name: result, key metrics)

Golden file changes and why:

## Safety

- [ ] No provider keys in client code or logs
- [ ] No new copy outside copy.ts
- [ ] No em dashes or en dashes anywhere in this change
- [ ] No medical language added
- [ ] Consent, retention, and caps unchanged (or the human approved the change and it is described above)

## Follow ups

Anything intentionally left out and where it is tracked.
