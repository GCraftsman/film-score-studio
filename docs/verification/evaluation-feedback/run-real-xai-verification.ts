import { createHash, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  AI_MUSIC_SAFETY_POLICY,
  screenMusicText,
} from "../../../artifacts/api-server/src/lib/ai-music-safety.ts";
import {
  CHAT_MAX_ATTEMPTS,
  parseRetryAfter,
  providerRequestTimeoutMs,
  retryDelayMs,
  xaiLaunchLimiter,
} from "../../../artifacts/api-server/src/lib/chat-limiter.ts";
import {
  runCompositionWorkflow,
  semanticMidiFingerprint,
  type ModelMessage,
  type ScoreValue,
  type WorkflowModel,
} from "../../../artifacts/api-server/src/lib/composition-workflow.ts";
import { validateScoreOperations } from "../../../artifacts/api-server/src/lib/score-operations.ts";

/**
 * This is deliberately an explicit, one-shot verification harness. It invokes
 * the same exported workflow used by the compose route, while the xAI adapter
 * follows compose.ts: ReplitConnectors resolves the installed xAI connection;
 * no API key or secret is read by this script.
 */

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "baseline.json");
const lockPath = join(here, "run-lock.json");
const eventsPath = join(here, "events.json");
const outcomePath = join(here, "outcome.json");
const appliedScorePath = join(here, "applied-score.json");
const unchangedPath = join(here, "unchanged-comparison.json");

const request = {
  message: "For the existing piano phrase, keep every pitch, onset, note duration, and region timing unchanged. Change only the note velocities to a gently rising expressive accent shape. Do not add or remove tracks.",
  safeDirection: "Edit the existing piano phrase by changing only note velocities to a gentle rising expressive accent shape; preserve pitches, onsets, durations, and region timing.",
  selectedStyle: "gentle expressive piano",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function getModel(connectors: ReplitConnectors): Promise<string> {
  const response = await xaiLaunchLimiter.schedule(() =>
    connectors.proxy("xai", "/v1/language-models", { method: "GET" }),
  );
  if (!response.ok) throw new Error(`xAI model discovery failed (${response.status})`);
  const payload = await response.json() as {
    models?: Array<{ id?: string }>;
    data?: Array<{ id?: string }>;
  };
  const models = payload.models ?? payload.data ?? [];
  const preferred = models.find((candidate) => candidate.id?.includes("grok-4") && candidate.id.includes("fast"))
    ?? models.find((candidate) => candidate.id?.includes("grok-4"))
    ?? models[0];
  if (!preferred?.id) throw new Error("xAI returned no language models");
  return preferred.id;
}

async function chat(
  connectors: ReplitConnectors,
  model: string,
  messages: ModelMessage[],
  maxTokens: number,
  jsonMode = false,
): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [{ role: "system", content: AI_MUSIC_SAFETY_POLICY }, ...messages],
    temperature: 0.45,
    max_completion_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
  const proxyFetch = connectors.createProxyFetch("xai");
  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt += 1) {
    const response = await xaiLaunchLimiter.schedule(() => proxyFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(providerRequestTimeoutMs(maxTokens)),
    }));
    if (response.ok) {
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (content) return content;
      throw new Error("xAI returned an empty completion");
    }
    const detail = clip(await response.text(), 500);
    if (response.status === 429 && attempt < CHAT_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(
        resolve,
        retryDelayMs(attempt, parseRetryAfter(response.headers.get("retry-after"))),
      ));
      continue;
    }
    throw new Error(`xAI completion failed (${response.status}): ${detail}`);
  }
  throw new Error("xAI completion retry budget exhausted");
}

type NoteShape = {
  trackId: string;
  pitch: number;
  startBeat: number;
  durationBeats: number;
};

function noteShape(score: ScoreValue): NoteShape[] {
  return score.tracks.flatMap((track) => track.regions.flatMap((region) =>
    region.notes.map((note) => ({
      trackId: track.id,
      pitch: note.pitch,
      startBeat: region.startBeat + note.startBeat,
      durationBeats: note.durationBeats,
    })),
  )).sort((left, right) =>
    left.trackId.localeCompare(right.trackId)
    || left.startBeat - right.startBeat
    || left.pitch - right.pitch
    || left.durationBeats - right.durationBeats,
  );
}

function regionTimingShape(score: ScoreValue): Array<{
  trackId: string;
  startBeat: number;
  durationBeats: number;
}> {
  return score.tracks.flatMap((track) => track.regions.map((region) => ({
    trackId: track.id,
    startBeat: region.startBeat,
    durationBeats: region.durationBeats ?? 0,
  }))).sort((left, right) =>
    left.trackId.localeCompare(right.trackId)
    || left.startBeat - right.startBeat
    || left.durationBeats - right.durationBeats,
  );
}

function velocityShape(score: ScoreValue): Array<{
  trackId: string;
  pitch: number;
  startBeat: number;
  velocity: number;
}> {
  return score.tracks.flatMap((track) => track.regions.flatMap((region) =>
    region.notes.map((note) => ({
      trackId: track.id,
      pitch: note.pitch,
      startBeat: region.startBeat + note.startBeat,
      velocity: note.velocity,
    })),
  )).sort((left, right) =>
    left.trackId.localeCompare(right.trackId)
    || left.startBeat - right.startBeat
    || left.pitch - right.pitch,
  );
}

function applyOperations(score: ScoreValue, operations: Record<string, unknown>[]): ScoreValue {
  const next = clone(score);
  for (const operation of operations) {
    const track = next.tracks.find((candidate) => candidate.id === operation.trackId);
    if (!track) throw new Error(`Verified operation targeted missing track "${String(operation.trackId)}".`);
    if (operation.type === "remove-region") {
      const before = track.regions.length;
      track.regions = track.regions.filter((region) => region.id !== operation.regionId);
      if (track.regions.length === before) {
        throw new Error(`Verified operation targeted missing region "${String(operation.regionId)}".`);
      }
      continue;
    }
    if (operation.type === "add-region") {
      const region = operation.region;
      if (!region || typeof region !== "object") throw new Error("Verified add-region operation had no region.");
      track.regions.push(clone(region as ScoreValue["tracks"][number]["regions"][number]));
      continue;
    }
    throw new Error(`Verified operation had unsupported type "${String(operation.type)}".`);
  }
  return next;
}

function unchangedComparison(baseline: ScoreValue, attempted: ScoreValue): Record<string, unknown> {
  const baselineJson = stable(baseline);
  const attemptedJson = stable(attempted);
  return {
    status: "unchanged",
    completeBaselineUnchanged: baselineJson === attemptedJson,
    semanticBaselineUnchanged: semanticMidiFingerprint(baseline) === semanticMidiFingerprint(attempted),
    baselineSha256: sha256(baselineJson),
    attemptedScoreSha256: sha256(attemptedJson),
    baseline,
  };
}

function failureText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return screenMusicText(
    clip(raw, 800),
    "The isolated provider workflow failed before a verified edit; inspect the recorded provider stage and retry only after triage.",
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || !process.argv.includes("--run")) {
    throw new Error("This harness is one-shot. Run exactly once with --run after evaluation-fix reports implementation ready.");
  }
  if (await exists(lockPath) || await exists(outcomePath)) {
    throw new Error("The isolated real-provider run is already locked or has an outcome; no repeated live run is permitted.");
  }

  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as ScoreValue;
  const baselineJson = stable(baseline);
  const baselineForWorkflow = clone(baseline);
  const startedAt = new Date().toISOString();
  await writeJson(lockPath, {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt,
    provider: "xai",
    workflow: "runCompositionWorkflow",
    baselinePath: "baseline.json",
    baselineSha256: sha256(baselineJson),
    note: "One isolated synthetic verification run. The baseline is not a user project.",
  });

  const events: unknown[] = [];
  let attemptedScore = baselineForWorkflow;
  try {
    const connectors = new ReplitConnectors();
    const modelId = await getModel(connectors);
    const model: WorkflowModel = {
      complete: (messages, maxTokens, jsonMode) => chat(connectors, modelId, messages, maxTokens, jsonMode),
    };
    const workflow = await runCompositionWorkflow({
      model,
      message: request.message,
      safeDirection: request.safeDirection,
      originalMessage: request.message,
      selectedStyle: request.selectedStyle,
      intent: "edit",
      history: [],
      score: baselineForWorkflow,
      sourceMidi: { kind: "synthetic-baseline", score: baselineForWorkflow },
      onEvent: (event) => events.push(event),
    });

    const operations = workflow.operations;
    const validated = validateScoreOperations(baselineForWorkflow, operations);
    const diagnostics = (validated as unknown as { diagnostics?: unknown[] }).diagnostics ?? [];
    if (diagnostics.length || validated.length !== operations.length || !operations.length) {
      throw new Error(`Workflow returned operations that could not be verified atomically (${diagnostics.length} diagnostics).`);
    }
    if (operations.some((operation) => operation.trackId !== "track-piano")) {
      throw new Error("Workflow returned an operation outside the existing piano track.");
    }

    attemptedScore = applyOperations(baselineForWorkflow, validated);
    const beforeShape = noteShape(baselineForWorkflow);
    const afterShape = noteShape(attemptedScore);
    const beforeTiming = regionTimingShape(baselineForWorkflow);
    const afterTiming = regionTimingShape(attemptedScore);
    const beforeVelocity = velocityShape(baselineForWorkflow);
    const afterVelocity = velocityShape(attemptedScore);
    const velocityChanged = stable(beforeVelocity) !== stable(afterVelocity);
    if (!beforeShape.length || stable(beforeShape) !== stable(afterShape)) {
      throw new Error("Applied operations changed pitch, onset, or note duration instead of only velocity.");
    }
    if (stable(beforeTiming) !== stable(afterTiming)) {
      throw new Error("Applied operations changed region timing instead of only velocity.");
    }
    if (!velocityChanged) throw new Error("Applied operations did not change any note velocity.");

    await writeJson(eventsPath, events);
    await writeJson(appliedScorePath, attemptedScore);
    await writeJson(outcomePath, {
      schemaVersion: 1,
      status: "verified",
      provider: "xai",
      model: modelId,
      workflow: "runCompositionWorkflow",
      startedAt,
      completedAt: new Date().toISOString(),
      request,
      baselinePath: "baseline.json",
      eventsPath: "events.json",
      appliedScorePath: "applied-score.json",
      operationCount: operations.length,
      operations,
      workflowSummary: workflow.summary,
      workflowStatus: workflow.status,
      tasks: workflow.tasks,
      changedFiles: workflow.changedFiles,
      scoreComparison: {
        semanticBaselineFingerprint: semanticMidiFingerprint(baselineForWorkflow),
        semanticAppliedFingerprint: semanticMidiFingerprint(attemptedScore),
        semanticChanged: semanticMidiFingerprint(baselineForWorkflow) !== semanticMidiFingerprint(attemptedScore),
        verifiedNotes: attemptedScore.tracks.flatMap((track) => track.regions.flatMap((region) =>
          region.notes.map((note) => ({
            trackId: track.id,
            regionId: region.id,
            pitch: note.pitch,
            velocity: note.velocity,
            startBeat: region.startBeat + note.startBeat,
            durationBeats: note.durationBeats,
          })),
        )),
        velocityOnlyAssertions: {
          notePitchOnsetDurationUnchanged: stable(beforeShape) === stable(afterShape),
          regionTimingUnchanged: stable(beforeTiming) === stable(afterTiming),
          velocityChanged,
        },
      },
      assertions: {
        completeBaselineUnchangedBeforeApply: stable(baseline) === stable(baselineForWorkflow),
        operationsValidatedAtomically: true,
        appliedOperationsVerified: true,
      },
    });
  } catch (error) {
    const unchanged = unchangedComparison(baseline, baselineForWorkflow);
    if (!unchanged.completeBaselineUnchanged || !unchanged.semanticBaselineUnchanged) {
      throw new Error("Safety assertion failed: the complete synthetic baseline changed on failure.");
    }
    await writeJson(eventsPath, events);
    await writeJson(unchangedPath, unchanged);
    await writeJson(outcomePath, {
      schemaVersion: 1,
      status: "failed-unchanged",
      provider: "xai",
      workflow: "runCompositionWorkflow",
      startedAt,
      completedAt: new Date().toISOString(),
      request,
      baselinePath: "baseline.json",
      eventsPath: "events.json",
      unchangedComparisonPath: "unchanged-comparison.json",
      actionableFailure: failureText(error),
      scoreComparison: unchanged,
      assertions: {
        completeBaselineUnchangedOnFailure: unchanged.completeBaselineUnchanged,
        semanticBaselineUnchangedOnFailure: unchanged.semanticBaselineUnchanged,
        appliedScoreWritten: false,
      },
    });
  }
}

await main();