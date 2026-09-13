---
name: Evaluation feedback safety
description: Preserve diagnostic meaning while screening model prose and grounding musical evidence.
---

Screen evaluator prose separately from service-generated diagnostic context, and derive note evidence from the actual compared scores rather than treating model claims as evidence.

**Why:** The music safety screen is intentionally conservative about capitalized names. Re-screening a combined reason, title, and identifier can erase an otherwise safe actionable musical diagnosis.

**How to apply:** Keep persisted reasons and correction instructions identical, keep routing labels separate, and test safe reasons through the complete event persistence path. Diagnostic excerpts supplement, never replace, complete score and source MIDI context.

Persist terminal rejection audits independently from score saves, and preserve the current server audit during ordinary document updates.

**Why:** A rejected candidate must not commit musical edits, but an approval-stage saved project otherwise loses the explanation of the failed continuation. Audit writes must not invalidate an in-progress score save or be erased by it.

**How to apply:** Keep audit updates owner-scoped and atomic, without incrementing the score document version. Merge server audits into local drafts on reload; never substitute model assertions for measured observations.