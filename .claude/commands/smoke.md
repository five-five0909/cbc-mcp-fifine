---
description: Build and run the end-to-end smoke tests against a real cbc
argument-hint: "[model id]"
---
Run the cbc-mcp end-to-end tests.

1. `npm run build`. Stop and fix any TypeScript errors first.
2. Run `node test/smoke.mjs $ARGUMENTS`, `node test/smoke-control.mjs $ARGUMENTS` and `node test/smoke-steer.mjs $ARGUMENTS` one after another. Each makes real model calls; allow up to ~2 minutes each and run them in the background if needed. If no model was given and `CBC_TEST_MODEL` is unset, run `cbc_models` or `node tools/probe.mjs` with `/ctl get_available_models` first and pick a fast model.
3. Report PASS/FAIL per check. For any FAIL, open the session's raw log under `%TEMP%/cbc-mcp/` and say what cbc actually sent before proposing a fix. Check `CLAUDE.md` "Bugs already hit" before changing `session.ts` wait/notify logic.
