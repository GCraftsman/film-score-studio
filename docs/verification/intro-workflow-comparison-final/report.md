# 64-bar intro workflow comparison

## Run status

Exactly one corrected paired live xAI run completed from this final directory. No saved project, project ID, normal route, or UI was touched. This is a small-sample limitation: one prompt and one paired run cannot establish general quality, latency, or cost superiority, and no provider rerun is permitted.

The source freeze/hash, exact launch command, PID, and artifact locations are recorded in `source-freeze.json`, `job-info.json`, and `run-lock.json`. Per-call provider metrics are in `call-metrics.json`; no saved project or normal route was touched. The paired run did not use the locked `evaluation-feedback/run-real-xai-verification.ts` harness. The prior pilot's executed bytes were not frozen and cannot be reconstructed; its evidence remains separate and unchanged.

## Shared request and safeguards

- Request: original, neutral, non-referential cinematic intro; exactly 64 bars in 4/4 (256 beats), retained Piano, String Ensemble, and French Horn tracks. Sparse rests are allowed; the objective checks section span and new material per retained track, not continuous sound union.
- Both arms received the identical explicit segment rules: regions <=128 beats, <=512 notes/region, startBeat <=512, <=60 operations, region-relative note offsets, and full 256-beat section span; sparse rests do not fail the span check.
- Both arms used the experiment-only 16000-token completion budget for equivalent advisory/skill work. The current arm reused the production adviser-first workflow through an adapter override; normal production remains unchanged.
- The consolidated arm is one consistent Orchestrator progressively loading style only, then style+concept, then style+concept+verification at the verification stage. This prototype uses a fixed bounded style -> concept -> plan -> writers -> verification sequence, not an adaptive skill selector, and does not create separate adviser personas. Optional skill MIDI remained private.
- Current writer audit: The production writer schema itself includes 128-beat, 512-note, 512-startBeat, and 60-operation limits; this arm also received the same explicit segment rules and sparse-writing direction in safeDirection. The experiment adapter lifted adviser-stage completion budgets to 16000 tokens; normal production behavior is unchanged. Consolidated writer audit: The consolidated writer prompt repeats the exact segment rules received by the current arm; no arm gets a larger region or operation allowance.
- Both arms were checked locally for atomic validation, ownership, catalog membership, retained regions, segment bounds, semantic change, and complete coverage before approval. A failed arm is never labeled successful; a safely reconstructed candidate is stored separately as unapproved evidence.

## Observed arm results

- **current-adviser-first**: status=failed; approved=false; wall=81077 ms; calls=6; writer attempts=2; production repair events=1; repair limit=2;
  candidate=unavailable; objective=fail;
  section-span=0.00-0.00 (0.00 beats); duration=0 beats;
  coverage-density=0.00 beats (0.0%, 0/64 bars); new-material-tracks=none;
  private MIDI=5; advisory MIDI loads=2; segment-bounds=2/2.
- **consolidated-orchestrator**: status=failed; approved=false; wall=71997 ms; calls=8; writer attempts=5; shared repair attempts=2/2;
  candidate=unavailable; objective=fail;
  section-span=0.00-0.00 (0.00 beats); duration=0 beats;
  coverage-density=0.00 beats (0.0%, 0/64 bars); new-material-tracks=none;
  private MIDI=5; advisory MIDI loads=5; segment-bounds=5/5.

## Context, provider metadata, and feasibility

- Selected model: `grok-4.20-0309-non-reasoning`.
- Model limit metadata (when returned, non-secret fields only): `{"id":"grok-4.20-0309-non-reasoning"}`.
- Observed maximum request input: 53124 bytes / 53106 UTF-16 chars; observed max message content: 47609 bytes / 47591 chars. Completion budget was 16000 tokens in both arms; actual provider usage remains in call metrics.
- Per-call exact input/output character and byte counts, provider usage tokens, finish reason, request ID, transport attempts, and wall time are in `call-metrics.json`. No score or skill context was arbitrarily truncated; the report records feasibility from actual provider requests and returned usage.
- Provider input/output token counts were returned for 14/15 calls. Missing usage is reported as missing, not estimated.

## Independent post-hoc rubric

The shared evaluator used one blind rubric for opaque candidate-1 and candidate-2 only when at least one candidate existed. It did not receive either arm's self-verdict. Its result is in `outcome.json`, while the objective checks are in each arm's `objectiveRubric`. Shared evaluator status=not-run-no-candidates; candidate-1 pass=unavailable; candidate-2 pass=unavailable.

## Exact failure causes and candidate availability

- Current adviser-first: the Harmony & Voice Leading consultation initially
  failed closed with `invalid-field`, reason “adviser feedback was empty after
  safety screening”, fields `["insight"]`; production structural repair
  attempt `1/2` recovered it. The Piano writer then returned
  `invalid-timing`, index `2`, reason “note timing exceeds region duration”,
  fields `["region.notes[9].startBeat","region.notes[9].durationBeats"]`.
  Its one production musical-regeneration attempt (`1/1`) ended with xAI
  finish reason `tool_calls`; no candidate was committed. The arm recorded
  five private MIDI references and two loader dereferences, but candidate
  availability is false and no approved score/MIDI was produced.
- Consolidated Orchestrator: style, concept, plan, Piano, and String Ensemble
  completed; those two writers produced 6 staged operations total. French Horn
  had 3 provider attempts (initial plus shared-pool repairs `1/2` and `2/2`);
  all three transport responses had finish reason `stop`, but bounded response
  validation (including imported atomic production operation validation) did
  not accept a response after the two bounded repairs. The final adapter error
  was sanitized to the generic “isolated experiment failed before a verified
  score candidate was available”; the exact rejected payload and diagnostic
  were intentionally not persisted.
  Therefore no candidate was committed, verification did not run, and the
  blind evaluator was not run. The arm recorded five private MIDI references
  and five targeted loader dereferences.
- Across the one-shot pair there were 15 provider calls: discovery 1,
  current 6, consolidated 8. Total wall time was 81,077 ms current and
  71,997 ms consolidated. Provider usage metadata was present for 14/15
  calls. No candidate file is present for either arm; partial staged
  operations are not a candidate and are not promoted.

## Recommendation

Do not promote either arm. This was the one authorized final pair and must not
be rerun. The failures are provider/response and bounded-validation outcomes,
not architecture evidence; the prior pilot and corrected setup attempt remain
separate and are not architecture evidence.

Measured root causes and limitations are in each arm's errors/events and
`call-metrics.json`; do not infer a strategy quality trade-off from an arm
that failed before producing a candidate. The run tested matched completion
budgets and progressively accumulated Orchestrator context, but produced no
candidate-level quality comparison.
