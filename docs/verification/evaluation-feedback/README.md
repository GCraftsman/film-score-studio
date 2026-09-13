# Evaluation-feedback provider verification

## Recorded result

The single live run on 2026-09-11 passed task and overall evaluation with xAI
`grok-4.20-0309-non-reasoning`. Two atomically validated operations replaced the
existing eight-note region with an expressive velocity shape. All eight pitches,
onsets, durations, and region timing remained unchanged; the applied candidate's
MIDI fingerprint changed. The saved baseline was not mutated and no user project
was touched. See `outcome.json`, `events.json`, and `applied-score.json`.

This run did not reproduce a musical rejection, so it cannot establish the
musical cause of an earlier failed trace. The new deterministic tests establish
that task/overall rejection reasons reach corrections and persist at final
failure. The live run establishes the alternative successful outcome: verified
notes can apply. No second provider run was made.

Verification: all 139 unit tests passed, workspace typechecks passed, and the API
workflow rebuilt and started successfully. After the live run, checks found an
empty-score diagnostic fallback bug; that was corrected and covered by the
passing no-change tests. Required evaluator agent-array validation was also
tightened; the recorded provider verdicts already satisfied that contract.

This directory contains the one-shot verification harness for the updated
`runCompositionWorkflow`. It is intentionally separate from any saved user
project. `baseline.json` is a synthetic one-track piano score with an existing
eight-note phrase.

## Run protocol

Do not run the live harness until the evaluation-fix worker explicitly reports
that its implementation is ready. After that report, run exactly once from the
repository root:

```sh
node --experimental-strip-types docs/verification/evaluation-feedback/run-real-xai-verification.ts --run
```

The harness uses the installed `@replit/connectors-sdk` xAI adapter pattern from
`artifacts/api-server/src/routes/compose.ts`; it does not read or request an
API key. It calls the exported `runCompositionWorkflow` directly with the
synthetic score, captures workflow events, and never writes a project score.

The first invocation writes `run-lock.json`. A lock or outcome prevents a
second live run. Do not delete the lock or outcome to retry: a new verification
requires explicit review and a new evidence directory.

## Expected evidence

- `events.json` — safety-screened workflow events from the one provider run.
- `outcome.json` — provider/workflow result, actionable failure if rejected, or
  verified operation and score comparisons.
- `applied-score.json` — written only after all returned operations validate and
  the applied notes are verified.
- `unchanged-comparison.json` — written only on failure; it asserts complete
  structural and MIDI-semantic equality with the baseline.

For success, the harness verifies that the existing piano track remains the
only target, pitch/onset/duration and region timing remain unchanged, and at
least one note velocity changes. For any failure, it applies nothing to the
baseline and asserts the complete baseline is unchanged.

The run is provider-dependent and may fail because of model discovery,
authentication/connection health, rate limiting, timeout, malformed provider
output, evaluator rejection, or a correction that cannot be verified. Those
are recorded as limitations rather than treated as a successful evaluation.