# Film Score Studio

A conversational AI scoring room where composers combine direction and MIDI material while an Orchestrator consults bounded specialist agents.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/film-score-studio run dev` — run the web studio
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Integrations: xAI connector — powers Orchestrator and specialist responses

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/film-score-studio/src/pages/workspace.tsx` — composition workspace
- `artifacts/film-score-studio/src/hooks/use-recording.ts` — MIDI, metronome, Web Audio, and draft snippets
- `artifacts/api-server/src/routes/compose.ts` — bounded xAI agent orchestration
- `lib/api-spec/openapi.yaml` — API contract

## Architecture decisions

- The composer talks only to the Orchestrator; specialist advice is synthesized into that conversation.
- The Orchestrator may delegate to any or all roster specialists in one parallel round; each specialist replies once and recursive agent loops remain disabled.
- MIDI stays client-side until the user explicitly submits the composer draft.
- The metronome doubles as recording state; incoming MIDI automatically starts it, and turning it off commits a snippet.
- Piano and metronome playback use locally bundled VCSL Kawai/woodblock samples released under CC0. Score transport uses section-specific VSCO 2 CE orchestral WAV banks, also CC0; keep both source notices and license texts with the assets.

## Product

- Read-only stacked score tracks and transport controls
- Hardware Web MIDI plus a two-octave multitouch onscreen keyboard
- Sampled Kawai piano playback with accented woodblock metronome clicks and an explicit browser-audio unlock control
- Metronome, numeric and tap tempo, multi-snippet composer drafts, audition and delete
- Instrument, style, and concept expert rosters backed by xAI

## User preferences

- All score edits should happen through agents rather than direct timeline editing.
- Text and multiple MIDI snippets belong to one combined chat submission.

## Gotchas

- Regenerate API clients after every OpenAPI change before editing callers.
- Never put xAI credentials in frontend code; use the installed connector from the API server.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
