---
name: Transactional composition intent
description: Why composition edits require verified MIDI changes and Orchestrator-only coordination.
---

Treat a productive-sounding agent conversation as insufficient evidence of composition success. An edit request must either produce a verified material MIDI change or explicitly fail without applying its candidate.

**Why:** The user reported piano-solo conversations that generated no music and requested a file-editing workflow instead of advice followed by unverified generation.

**How to apply:** Stage one candidate with scoped track owners and optional read-only advice before writing. Both membership actions need approval; deterministically validated MIDI changes auto-apply atomically with Undo. Do not require a post-write AI musical verdict.

Compare and merge musical events rather than MIDI binary bytes or region identifiers. A renamed region containing identical notes is not a musical modification.

**Why:** Standard MIDI files are binary and IDs/labels are editor metadata; text merges and metadata-only comparisons cannot establish that music changed.

**How to apply:** The service materializes real MIDI files from structured event edits. Keep complete source events available to the models and make any processing limits explicit rather than truncating melodies.

Use structured, deterministic specialist identifiers at model boundaries rather than comma-separated display labels, and return precise content-free validation diagnostics for bounded structural repairs.

**Why:** Live provider responses failed exact specialist matching even after a repair when the roster's labels themselves contained commas. Generic operation rejection also hid whether the model had confused timing, IDs, or required fields. Passing mocked tests did not establish provider compatibility.

**How to apply:** Keep identifier translation exact and lossless; never repair invalid musical data by dropping edits or inventing notes. Save isolated browser test projects before generation and retain terminal streams so a failure can be diagnosed without repeating provider calls.

Use read-only style/concept advisers and server-scoped track-owning instrument writers over one staged candidate, not private copies and conflict merges. Structural repair feedback must stay visible in the saved audit even when the agent ultimately succeeds.

**Why:** The user superseded private-copy merging with adviser-first planning and scoped instrument writing. They later explicitly removed final AI review after valid section generation repeatedly failed the review stage.

**How to apply:** Keep repair budgets explicit and bounded, and keep the original score unchanged on validation exhaustion. Distinguish instruction-format repair from musical regeneration; do not reintroduce subjective evaluation as a commit gate.

Valid MIDI with correct requested timing/length should reach the score without final adviser or Orchestrator musical approval.

**Why:** The user explicitly chose direct application over final AI review after section-writing tests completed but independent review failed.

**How to apply:** Preserve deterministic MIDI/schema, timing, ownership, membership approval, source constraints, and atomic application. This decision removes subjective rejection, not technical validation. Do not silently reinstate an evaluator or a review-driven rewrite loop.

Use concrete valid values in model-facing JSON examples; never put pipe-delimited enum alternatives in a JSON value.

**Why:** A writer copied a pseudo-enum such as `pp|p|mp|mf|f|ff` into region dynamics, then repeated it because the repair prompt also prohibited changing musical fields.

**How to apply:** List allowed values outside the JSON example. Structural repair may change only metadata/envelopes. Missing whole regions and invalid targets still fail closed; explicit bounded musical regeneration is the exception for eligible invalid musical fields.

Allow one explicitly identified musical regeneration across a composition run, consuming the existing shared recovery budget rather than adding an independent retry pool.

**Why:** The user authorized bounded regeneration after repeated writer timing failures, while retaining transactional score safety. This supersedes the earlier blanket rejection of every invalid musical field.

**How to apply:** Keep complete original context and prominent pre-response checks. Regenerate only eligible musical defects; preserve valid siblings and their multiplicity, operation count/order and targets. Reject mixed unrelated structural/capability defects. Regenerated output receives normal validation and MIDI verification; failure never partially commits.

Stopping a signed track-approval continuation must offer a fresh-plan retry, never replay the original approval checkpoint.

**Why:** The server may consume a single-use approval before the client disconnects. Simply restoring the approval button leaves the composer with an unusable capability even though no score edit was committed.

**How to apply:** Invalidate the client request generation before aborting, discard late results, supersede the stopped membership proposal, and retain original context for a fresh plan. Style-selection cancellation can instead restore its selectable gate because it is not a signed membership capability.

Structural repairs must preserve musical edits that became valid in any earlier attempt, not only edits valid in the original response.

**Why:** A later repair could otherwise quietly drop a newly repaired phrase and appear successful with only the remaining edit. Structural validity alone does not prove full-batch preservation.

**How to apply:** Compare musical content independently of metadata and note ordering, retaining repeated edits with their multiplicity across repair attempts. Do not let format repair turn into unapproved musical revision.

Prevent provider cutoffs with an adequate bounded initial response budget and a deadline scaled to that budget; do not regenerate a truncated musical response as structural repair.

**Why:** A live composition hit the output limit on its original response and both repairs. When the tail is missing, the service cannot establish which notes were intended, so regeneration cannot guarantee musical preservation—even if the prefix parses.

**How to apply:** Reject token-limited completions before applying edits unless independently closed operations establish an exact recovery multiset. Preserve complete input MIDI, known valid edits, and evaluator feedback; keep format repairs for complete responses with repairable structural defects. A provider timeout has no partial response: allow the first full-context replacement to establish a baseline, then require exact multiset preservation on later bounded attempts. Keep the score transaction atomic through timeout exhaustion.
