# 64-bar intro workflow comparison

## Run status

One paired live xAI run completed. The experiment was isolated under `docs/verification/intro-workflow-comparison`; no saved project, project ID, normal route, or UI was touched. This is a small-sample limitation: one prompt and one paired run cannot establish general quality, latency, or cost superiority, and no repeated expensive retry was made outside each arm's bounded repair policy.

The exact successful launch command, PID, and artifact locations are recorded in `job-info.json`; the corrected paired run was launched once in the foreground (PID 1995), with stdout/stderr at `run.log`. A background launch probe exited before starting and is not counted as a provider run. An earlier implementation probe exposed an incorrect 1024-beat arithmetic constant, produced no outcome, and was discarded before the corrected 256-beat run; its provider calls are not included in this comparison's evidence. The paired run did not use the locked `evaluation-feedback/run-real-xai-verification.ts` harness.

## Shared request and safeguards

- Request: original, neutral, non-referential cinematic intro; exactly 64 bars in 4/4 (256 beats), retained Piano, String Ensemble, and French Horn tracks.
- Both arms received the identical explicit segment rules: regions <=128 beats, <=512 notes/region, startBeat <=512, <=60 operations, region-relative note offsets, and full 256-beat coverage.
- The current arm reused the production adviser-first workflow and its atomic operation/evaluator safeguards through an experiment-only adapter. No current instrument writer call launched because the first adviser hit the provider token limit; therefore writer-prompt presence is not claimed as observed. The production writer schema includes 128-beat, 512-note, 512-startBeat, and 60-operation limits, and safeDirection carried the same explicit segment rules.
- The consolidated arm sequentially called the on-demand style skill (which returned one private MIDI suggestion) then the concept skill; the concept call hit the provider token limit, so no retained-track writer or Orchestrator verification call launched. Its intended writer prompt repeats the exact segment rules, but that prompt was not observed in a non-launched call. Its verdict was not used as the independent evaluator.
- Both arms were checked locally for atomic validation, ownership, catalog membership, retained regions, segment bounds, semantic change, and complete coverage before approval. A failed arm is never labeled successful; a safely reconstructed candidate is stored separately as unapproved evidence.

## Observed arm results

- **current-adviser-first**: status=failed; approved=false; wall=27641 ms; calls=1; repairs=0;
  candidate=unavailable; objective=fail;
  duration=0 beats; max note end=0.00;
  coverage=0.00 beats (0.0%, 0/64 bars);
  private MIDI=0; segment-bounds=0/0.
- **consolidated-orchestrator**: status=failed; approved=false; wall=24833 ms; calls=2; repairs=0;
  candidate=unavailable; objective=fail;
  duration=0 beats; max note end=0.00;
  coverage=0.00 beats (0.0%, 0/64 bars);
  private MIDI=1; segment-bounds=0/0.

## Context, provider metadata, and feasibility

- Selected model: `grok-4.20-0309-non-reasoning`.
- Model limit metadata (when returned, non-secret fields only): `{"id":"grok-4.20-0309-non-reasoning"}`.
- Observed maximum request input: 18411 bytes / 18411 UTF-16 chars; observed max message content: 16990 bytes / 16990 chars.
- Per-call exact input/output character and byte counts, provider usage tokens, finish reason, request ID, transport attempts, and wall time are in `call-metrics.json`. No score or skill context was arbitrarily truncated; the report records feasibility from actual provider requests and returned usage.
- Provider input/output token counts were returned for 4/5 calls. Missing usage is reported as missing, not estimated.

## Independent post-hoc rubric

The shared evaluator used one blind rubric for opaque candidate-1 and candidate-2. It did not receive either arm's self-verdict. Its result is in `outcome.json`, while the objective checks are in each arm's `objectiveRubric`. Shared evaluator status=verified; candidate-1 pass=false; candidate-2 pass=false.

## Recommendation

Do not promote either arm from this sample. Keep any captured candidate as unapproved evidence and address the listed objective/provider failures before another explicitly authorized experiment.

Observed strategy trade-off: the current adviser-first path has more lifecycle calls (initial advisers, planner, retained writers, review, and bounded refinements) but reuses the production transaction. The consolidated path makes style/concept context sequential and explicit before retained writers, reducing role fragmentation in its experiment adapter at the cost of a large repeated Orchestrator context. For long scores, keep full score/source MIDI context, preserve bounded segment output, instrument actual usage, and make any future comparison use matched policies and another explicitly authorized paired sample.
