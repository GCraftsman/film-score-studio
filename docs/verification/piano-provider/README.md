# Piano composition verification

## Live provider result

The saved, isolated project contained one empty Upright Piano before generation.
One real-provider generation request produced one verified task and 13 playable
notes without another instrument-approval gate. The provider encountered
instruction-validation errors, received bounded feedback, and recovered before
the candidate was merged, evaluated, and applied.

`two-feedback-loops-stream.json` contains the sanitized terminal stream, including
repair feedback and verification. Its discussion response contains no operations.

## Persistence and MIDI

- Save persisted the generated score and per-track MIDI.
- `verified-piano.mid` is the downloaded Standard MIDI File.
- `midi-parse.json` records a valid MThd header and 13 actual note-on events.
- Reload retained the 13 notes and the workflow audit.
- A discussion request left the score unchanged.
- Undo restored the previous local empty score.

Reloading after the unsaved Undo restored that local draft, as indicated by the
draft-recovery banner. A subsequent authenticated, read-only project fetch
confirmed the server still held the saved 13-note region. No saved notes were
deleted. The current UI lacks a discard-draft/revert-to-saved control; this is
separate follow-up work.

## Automated checks

`unit-tests.log` records 112 passing tests after merging the newer main-app changes, including two-repair exhaustion,
second-repair recovery, malformed instructions, relay revision validation, and
structured diagnostic persistence. `typechecks.log` records passing workspace
typechecks.

Earlier failed runs are preserved separately for comparison. They are not
successful verification evidence.