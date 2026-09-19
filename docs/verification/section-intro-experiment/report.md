# Section-based 32-bar intro experiment

## Status

Exactly one isolated section-based experiment is authorized. This evidence directory is new and does not overwrite the earlier comparison. No saved project, project ID, normal route, or UI was touched. The experiment is one bounded sample and cannot establish general success or quality.

- Result: **failed closed or unapproved**
- Score: 32 bars, 4/4, 72 BPM, 128 beats
- Sections: 4 x 8 bars (32 beats), 0 writer calls
- Repair policy: up to 4 repair cycles after the initial attempt **per failed section**; observed 0 repairs
- Model: `grok-4.20-0309-non-reasoning`
- Wall time: 47060 ms; calls: 1; cumulative reported provider input tokens: 0; cumulative reported total tokens: 0

## Safeguards and source preservation

- One global Orchestrator identity loaded style, concept, and verification skills sequentially, then produced one global plan. Derived plan text was supplemental; each writer received complete original score, complete immutable source MIDI, exact section source notes, previous/next source neighbors, and staged siblings.
- There were exactly 12 owned section writer slots. A failed slot is recorded and stops promotion; it is never silently dropped. Staged siblings remain in `partial-stage.json` only and are not a candidate.
- Canonical production operation schema/checklist and `validateScoreOperations` were used. Writer regions used absolute score-relative starts and region-relative note offsets.
- Private advisory MIDI references were materialized, hash-bound, parsed by the production advisory MIDI loader, and retained as private evidence only.
- Original baseline notes/regions and track membership were compared independently of operation IDs. Candidate promotion required deterministic all-section and whole-score checks, Orchestrator verification, and a common blind evaluator.

## Observed result

```json
{
  "objective": {
    "pass": false,
    "failures": [
      "No complete candidate was staged."
    ],
    "durationBeats": 0,
    "sectionCoverage": []
  },
  "errors": [
    {
      "reason": "Global Orchestrator plan must assign one instruction per retained track."
    }
  ],
  "progress": [],
  "repairCountsBySection": {}
}
```

## Context and timing

Per-call exact UTF-16 character counts, UTF-8 byte counts, provider input/output/total tokens when returned, finish reasons, request IDs, transport attempts, and wall time are in `call-metrics.json`. Peak input bytes were 0; cumulative input bytes were 0. Missing provider usage is preserved as missing rather than estimated. No arbitrary score/source context was truncated.

## Offline gate and limitations

The offline full-flow and repair-exhaustion fixture completed before any live launch. Its checks are in `offline-fixture.json`. The offline fixture explicitly confirms all 12 section ownership slots, source preservation, four repair cycles with no sixth attempt, private advisory loader round trips, canonical prompts, verifier/evaluator negative gates, and complete-candidate-only evaluation. Directional comparison with earlier paired workflows is not a general success claim.
