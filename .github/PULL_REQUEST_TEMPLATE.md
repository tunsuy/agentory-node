## Summary

<!-- What does this PR change, in 1–3 bullets? -->

-

## Motivation

<!-- Why is this needed? Link issues if any. -->

## Type of change

- [ ] New / updated adapter (`adapters/<id>`)
- [ ] Host / CLI fix (runtime-agnostic)
- [ ] Docs / CI / DX
- [ ] Other

## Test plan

- [ ] `npm test` passes locally
- [ ] Fixture coverage for discover / align (if adapter)
- [ ] No secrets or `.env` in the diff

## Checklist

- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] Capabilities in the adapter manifest match what is implemented
- [ ] Align writes refuse unless `confirmed` (if touching applyAlign)
- [ ] Write paths are limited (no default full home-directory scan)
