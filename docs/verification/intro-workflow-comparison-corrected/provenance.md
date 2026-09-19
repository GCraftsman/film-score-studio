# Corrected-run provenance

The first pilot's executed source was not frozen before launch, so its exact
bytes cannot be reconstructed. The original pilot evidence remains unchanged
under `../intro-workflow-comparison/`.

This corrected harness was copied from the prior experiment adapter, then
changed only in this separate directory to lift matched advisory/skill output
budgets, load explicit reusable skill documents into one Orchestrator context,
measure section span and per-track new material, skip blind evaluation when
both candidates are absent, and add refusal/fixture/source-freeze checks.
The executed source snapshot and SHA-256 are recorded in
`experiment.executed.ts` and `source-freeze.json` before the live launch.

After the one authorized paired run completed, an unexecuted adapter fix was
made to add the missing in-memory `loadAdvisoryMidiRef` hook identified by the
current-arm root cause. The post-run working source hash is
`1eed26f1191624ad5adfda345ca0bb8d6ecc36fb1ed9dfdb43179090e4752275`; it is
deliberately different from the frozen executed hash and was not live-run.