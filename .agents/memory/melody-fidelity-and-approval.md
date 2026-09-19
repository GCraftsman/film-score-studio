---
name: Melody fidelity and track approval
description: Preserve source MIDI performance and distinguish track changes from musical edits.
---

Pass the complete ordered MIDI performance through every relevant AI stage, including pitch, velocity, onset, duration, and source tempo. Never replace a melody with its unique pitch set.

**Why:** A prior compact summary preserved BPM and pitch classes but discarded repeated notes and phrasing; the user reported compositions that sounded unrelated to their submitted melody.

**How to apply:** Preserve source timing explicitly in beat conversion and default to developing, not rewriting, the original melody. Any size limit must reject visibly rather than silently truncate.

Preserve the selected style's description as well as its label across approval and retry.

**Why:** Conservative name screening collapsed different musical options to the same generic title, so sending the title alone discarded which musical direction the user chose. Combining fields also requires enough capacity in the request, response, and saved-state contracts.

**How to apply:** Keep style choices distinguishable after safety screening, preserve complete selection context, and validate it against the actual API contract rather than testing only the UI helper.

Require explicit user approval for both supported instrument additions and deletions. Stage approved membership together with verified notes for one atomic commit, with Undo.

**Why:** On 2026-09-12 the user superseded automatic additions with an adviser-first workflow and explicit approval of both membership actions. Advice can revisit instrumentation, but cannot authorize a membership change.

**How to apply:** Preserve style selection, original MIDI, original adviser roster, and consumed budgets across approval and reload. Approval does not mutate the saved score; failed compositions must not leave empty added tracks behind.

Bind whether approval must continue into playable composition in the server-signed approval checkpoint; do not ask another model to reinterpret the request after approval.

**Why:** A playable composition request was reclassified as membership-only after approval, so new parts were committed with no MIDI. A later request then failed before writers, leaving the empty tracks visible.

**How to apply:** For playable requests, require writer instructions and final playable MIDI on every approved addition after all refinements. Check the final candidate, not only the first writer pass; explicit membership-only requests may still create empty tracks.