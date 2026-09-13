---
name: Live composition testing
description: Long-running live composition streams can outlast browser test execution.
---

Start long composition fetches without awaiting the entire stream in a single browser execution; collect progress in-page and check it in short calls.

**Why:** A live test on 2026-09-12 hit the test runner's 45-second execution timeout and disconnected before receiving terminal NDJSON. Server-side processing continued and produced diagnostic logs afterward. This was not evidence of an application timeout or a completed generation.

**How to apply:** Keep the browser context alive, collect the terminal event, and inspect correlated server logs if the test runner disconnects. Do not resubmit automatically, since the original provider work may still be running.