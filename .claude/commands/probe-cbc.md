---
description: Re-verify the cbc control protocol (e.g. after upgrading cbc)
argument-hint: "[what to check]"
---
Re-check cbc's stream-json protocol against `docs/cbc-protocol.md`. Focus: $ARGUMENTS (if empty, check everything in the doc).

- Run `cbc --version` and compare it with the version in the doc.
- Drive cbc with `tools/probe.mjs` (run `npm run build` first), or write a small throwaway script in the scratchpad that pipes NDJSON into it. Always keep `--strict-mcp-config`. Never write `~/.codebuddy/settings.json`; if a test might touch it, back it up first and compare bytes after.
- For each claim you test, record measured vs documented. Update `docs/cbc-protocol.md` (and the version line) only with what you observed, and flag anything that would break `src/session.ts` or `src/gate.ts`.
