---
name: Consultation request pacing
description: Shared request pacing is necessary for parallel AI consultations.
---

Pace AI request starts globally across orchestration, instrument audits, specialists, and retries while allowing calls already started to run concurrently.

**Why:** The installed service rejected a real post-approval consultation at 11 requests per second against a 10-per-second limit. Limiting each stage independently would still allow overlapping stages or users to exceed it.

**How to apply:** Keep bounded Retry-After-aware retries and preserve original MIDI/style on retry. Do not work around rate limits by dropping agents or summarizing the submitted melody.