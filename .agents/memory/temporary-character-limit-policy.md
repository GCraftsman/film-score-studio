---
name: Temporary character limit policy
description: Why Film Score Studio currently uses deliberately generous text bounds.
---

Keep user- and model-facing character ceilings at least five times their earlier values until real usage shows which fields need tighter limits. Preserve non-character safety bounds such as MIDI ranges, array counts, file sizes, UUID/hash formats, and provider token budgets.

**Why:** Repeated valid composition attempts failed on narrow metadata and prose ceilings, including a writer summary exceeding its limit by one character. The user chose reliability over compact text for now and wants to evaluate tighter limits later.

**How to apply:** When adding or changing a textual field, keep the OpenAPI schema, server validation, model prompts, diagnostics, persistence normalization, client mirrors, generated bindings, and tests aligned. Do not silently reintroduce the earlier ceilings.