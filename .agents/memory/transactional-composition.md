---
name: Transactional composition intent
description: Why composition edits require verified MIDI changes and Orchestrator-only coordination.
---

Treat a productive-sounding agent conversation as insufficient evidence of composition success. An edit request must either produce a verified material MIDI change or explicitly fail without applying its candidate.

**Why:** The user reported piano-solo conversations that generated no music and requested a file-editing workflow instead of advice followed by unverified generation.

**How to apply:** Stage one candidate with at most five track owners, read-only advisers before and after writing, and one affected-track refinement followed by acceptance verification. Both membership actions need approval; verified changes auto-apply atomically with Undo.

Compare and merge musical events rather than MIDI binary bytes or region identifiers. A renamed region containing identical notes is not a musical modification.

**Why:** Standard MIDI files are binary and IDs/labels are editor metadata; text merges and metadata-only comparisons cannot establish that music changed.

**How to apply:** The service materializes real MIDI files from structured event edits. Keep complete source events available to the models and make any processing limits explicit rather than truncating melodies.

Use structured, deterministic specialist identifiers at model boundaries rather than comma-separated display labels, and return precise content-free validation diagnostics for bounded structural repairs.

**Why:** Live provider responses failed exact specialist matching even after a repair when the roster's labels themselves contained commas. Generic operation rejection also hid whether the model had confused timing, IDs, or required fields. Passing mocked tests did not establish provider compatibility.

**How to apply:** Keep identifier translation exact and lossless; never repair invalid musical data by dropping edits or inventing notes. Save isolated browser test projects before generation and retain terminal streams so a failure can be diagnosed without repeating provider calls.

Use read-only style/concept advisers and server-scoped track-owning instrument writers over one staged candidate, not private copies and conflict merges. Structural repair feedback must stay visible in the saved audit even when the agent ultimately succeeds.

**Why:** On 2026-09-12 the user superseded private-copy merging with adviser-first planning, same-adviser candidate review, and at most one affected-instrument refinement. The existing two-repair ceiling remains important so recurring instruction problems are not hidden behind retries.

**How to apply:** Treat two repairs as a ceiling, not a success guarantee. Keep the original score unchanged on exhaustion; distinguish instruction-format repair from musical compromise and evaluation correction.

Structural repairs must preserve musical edits that became valid in any earlier attempt, not only edits valid in the original response.

**Why:** A later repair could otherwise quietly drop a newly repaired phrase and appear successful with only the remaining edit. Structural validity alone does not prove full-batch preservation.

**How to apply:** Compare musical content independently of metadata and note ordering, retaining repeated edits with their multiplicity across repair attempts. Do not let format repair turn into unapproved musical revision.

Prevent provider cutoffs with an adequate bounded initial response budget and a deadline scaled to that budget; do not regenerate a truncated musical response as structural repair.

**Why:** A live composition hit the output limit on its original response and both repairs. When the tail is missing, the service cannot establish which notes were intended, so regeneration cannot guarantee musical preservation—even if the prefix parses.

**How to apply:** Reject token-limited completions before applying edits unless independently closed operations establish an exact recovery multiset. Preserve complete input MIDI, known valid edits, and evaluator feedback; keep format repairs for complete responses with repairable structural defects. A provider timeout has no partial response: allow the first full-context replacement to establish a baseline, then require exact multiset preservation on later bounded attempts. Keep the score transaction atomic through timeout exhaustion.
