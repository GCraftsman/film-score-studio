---
name: Adviser repair safety
description: Distinguish harmless envelope drift from write attempts and preserve review decisions.
---

Repair harmless empty adviser envelope fields, but reject actual write or membership payloads rather than asking a repair to remove them.

**Why:** Review demonstrated that a repair could sanitize a nonempty edit payload into accepted advice, masking a read-only contract violation.

**How to apply:** Classify capability violations before retrying. Keep diagnostics content-free and the structural repair ceiling bounded.

Preserve valid review decisions and affected-track selections as well as advice text during structural repair.

**Why:** A repair that retains feedback prose but changes a refinement flag or clears affected tracks can silently bypass the refinement round.

**How to apply:** Enforce preservation in validation, not only prompts. Test with repair-capable mocks; unexpected-call exceptions can otherwise make rejection tests pass for the wrong reason.

Advertise an adviser prose target below the validator ceiling, and let overlength recovery rewrite concisely rather than byte-preserving an impossible response.

**Why:** Providers repeatedly returned just over 500 characters despite a 450-character target, and repair instructions once required exact preservation. Normal actionable advice around 505 characters should not block writers.

**How to apply:** Use the current feedback ceiling and lower prompt target (see the temporary character-limit policy). Never mechanically truncate; preserve actionable constraints and valid review decisions.

Safety-rejected prose must be rewritten, not byte-preserved, while valid review decisions remain immutable.

**Why:** A provider repeated the same rejected review through both repairs when instructed to preserve readable advice. Quotation screening also mistook possessive apostrophes for quotation boundaries.

**How to apply:** Explicitly request unquoted neutral musical wording for safety failures. Keep ordinary structural repairs lossless, retain named-reference protections, and distinguish word-internal apostrophes from quotes. Any neutral-quotation exemption must stay narrowly bounded.

Ground style, adviser, and Orchestrator prompts in the playable catalog. Unsupported timbres may appear only as mapped creative references to a supported instrument with achievable technique.

**Why:** Early style bots lacked catalog limits, while broad instrument-name safety exemptions created title/name bypasses and suppressed normal multi-instrument advice.

**How to apply:** Share one catalog prompt. Safety exceptions may cover exact catalog/timbre spans in natural musical prose only when they are not embedded in adjacent title-cased words. Preserve specific instruction verbs rather than exempting arbitrary words after punctuation.

Make explicit adviser track targets authoritative; use canonical instrument matching only when a suggestion has no track targets.

**Why:** Combining exact-track and instrument matches with OR routing leaked a violin suggestion to a second violin writer that was not named by the adviser.

**How to apply:** Apply the same precedence in initial and refinement rounds. Test isolation with at least two tracks using the same instrument, and materialize advisory MIDI only after the writer passes this routing filter.

Treat invalid optional advisory MIDI as absent while keeping independently valid prose; never repair, persist, materialize, or apply the bad clip.

**Why:** A live provider repeatedly supplied one invalid note in an optional clip, which exhausted adviser repairs and discarded otherwise valid advice before writers could run.

**How to apply:** Keep strict clip validation as the default. Only the adviser-ingress path may deterministically omit an invalid optional clip; malformed score operations and loaded references still fail the whole transaction.

For candidate reviews, the explicit `needsRefinement` boolean controls writer capability. If it is false, ignore extra valid affected-track IDs.

**Why:** A live final adviser accepted the candidate but repeated a prior affected track, exhausting repairs after both writers had produced valid candidate notes.

**How to apply:** Still reject malformed, duplicate, or unknown track IDs and require at least one valid ID when refinement is true. Never infer refinement from IDs when the explicit decision is false.

Optional structured suggestions must not make valid adviser prose fail. Discard malformed suggestion entries individually without remapping targets, while preserving valid siblings.

**Why:** A provider used an instrument label where an exact track ID was required. Repairing that label could target the wrong same-instrument track, but rejecting the whole adviser response discarded safe prose.

**How to apply:** Keep exact target validation strict. Invalid optional entries receive no writer or MIDI capability; valid suggestions remain available, and malformed score operations still fail the transaction.