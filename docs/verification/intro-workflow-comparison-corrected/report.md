# 64-bar intro workflow comparison

## Run status

One corrected paired live xAI run completed. The experiment was isolated under `docs/verification/intro-workflow-comparison-corrected`; no saved project, project ID, normal route, or UI was touched. This is a small-sample limitation: one prompt and one paired run cannot establish general quality, latency, or cost superiority, and no repeated expensive retry was made outside each arm's bounded repair policy.

The source freeze/hash, exact launch command, PID, and artifact locations are recorded in `source-freeze.json`, `job-info.json`, and `run-lock.json`; stdout/stderr is `run.log`. The paired run did not use the locked `evaluation-feedback/run-real-xai-verification.ts` harness. The prior pilot's executed bytes were not frozen and cannot be reconstructed; its evidence remains separate and unchanged.

## Shared request and safeguards

- Request: original, neutral, non-referential cinematic intro; exactly 64 bars in 4/4 (256 beats), retained Piano, String Ensemble, and French Horn tracks. Sparse rests are allowed; the objective checks section span and new material per retained track, not continuous sound union.
- Both arms received the identical explicit segment rules: regions <=128 beats, <=512 notes/region, startBeat <=512, <=60 operations, region-relative note offsets, and full 256-beat section span; sparse rests do not fail the span check.
- Both arms used the experiment-only 16000-token completion budget for equivalent advisory/skill work. The current arm reused the production adviser-first workflow through an adapter override; normal production remains unchanged.
- The consolidated arm is one consistent Orchestrator progressively loading the reusable style, concept, and verification skill documents, then accumulating replies into plan, retained-track writers, and verification. This prototype uses a fixed bounded style -> concept -> plan -> writers -> verification sequence, not an adaptive skill selector, and does not create separate adviser personas. Optional skill MIDI remained private.
- Current writer audit: The current arm did not reach a writer because its experiment adapter lacked the in-memory advisory-MIDI loader required by the reused production workflow. The production writer schema and safeDirection include the 128-beat, 512-note, 512-startBeat, 60-operation, and sparse-writing limits, but current writer presence is not observed. Consolidated writer audit: both launched writer requests contained the explicit segment bounds; the original metric detector missed the literal `60 operations` wording, so the corrected audit is documented in outcome but was not re-run.
- Both arms were checked locally for atomic validation, ownership, catalog membership, retained regions, segment bounds, semantic change, full section span, and new material on every retained track before approval; coverage density is reported separately. A failed arm is never labeled successful; a safely reconstructed candidate is stored separately as unapproved evidence.

## Observed arm results

- **current-adviser-first**: status=failed; approved=false; wall=29503 ms; calls=3; repairs=0;
  candidate=unavailable; objective=fail;
  section-span=0.00-0.00 (0.00 beats); duration=0 beats;
  coverage-density=0.00 beats (0.0%, 0/64 bars); new-material-tracks=none;
  private MIDI=4; segment-bounds=0/0.
- **consolidated-orchestrator**: status=failed; approved=false; wall=40584 ms; calls=5; repairs=0;
  candidate=unavailable; objective=fail;
  section-span=0.00-0.00 (0.00 beats); duration=0 beats;
  coverage-density=0.00 beats (0.0%, 0/64 bars); new-material-tracks=none;
   private MIDI=7; segment-bounds=2/2.

## Context, provider metadata, and feasibility

- Selected model: `grok-4.20-0309-non-reasoning`.
- Model limit metadata (when returned, non-secret fields only): `{"id":"grok-4.20-0309-non-reasoning"}`.
- Observed maximum request input: 34359 bytes / 34337 UTF-16 chars; observed max message content: 32105 bytes / 32083 chars. Completion budget was 16000 tokens in both arms; actual provider usage remains in call metrics.
- Per-call exact input/output character and byte counts, provider usage tokens, finish reason, request ID, transport attempts, and wall time are in `call-metrics.json`. No score or skill context was arbitrarily truncated; the report records feasibility from actual provider requests and returned usage.
- Provider input/output token counts were returned for 8/9 calls. Missing usage is reported as missing, not estimated.
- Provider usage totals/maxima: current adviser-first input=12,646, output=2,148, total=14,794 (max input=5,617, max output=987); consolidated Orchestrator input=29,933, output=3,485, total=33,418 (max input=8,116, max output=902). These totals exclude model-discovery, which returned no usage.

## Independent post-hoc rubric

The shared evaluator used one blind rubric for opaque candidate-1 and candidate-2 only when at least one candidate existed. It did not receive either arm's self-verdict. Its result is in `outcome.json`, while the objective checks are in each arm's `objectiveRubric`. Shared evaluator status=not-run-no-candidates; candidate-1 pass=unavailable; candidate-2 pass=unavailable.

## Recommendation

Do not promote either arm from this sample. Keep any captured candidate as unapproved evidence and address the listed objective/provider failures before another explicitly authorized experiment.

Measured root causes: the current arm completed its three 16000-token adviser/planner calls and captured private MIDI, then failed because the experiment adapter did not provide the production workflow's advisory-MIDI loader. The consolidated Orchestrator completed style, concept, plan, and two bounded 16000-token writer requests with progressively larger full-context inputs, then failed closed because the writer response did not pass atomic operation validation after its bounded replacement; no candidate was applied. The shared evaluator was correctly skipped because neither candidate existed. Do not infer a strategy quality trade-off from this incomplete pair. The matched-budget run did get past the prior low-cap setup failure, and its measured context/token/finish data are retained for review.
