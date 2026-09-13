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