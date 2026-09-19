type ScoreLike = {
  durationBeats: number;
  tracks: Array<{
    id: string;
    regions: Array<{ id: string }>;
  }>;
};

/** Five multi-agent tasks can legitimately produce more than the legacy eight
 * operations. This remains a hard server-side safety bound, independent of UI. */
export const MAX_WORKFLOW_OPERATIONS = 60;

const MAX_ID_LENGTH = 400;

/** Operation summaries are metadata only; keep them bounded and non-empty. */
export const MAX_SUMMARY_LENGTH = 1_200;
export const INVALID_SUMMARY_REASON =
  "operation summary must be a non-empty string with at most 1200 characters";

export function hasDuplicateScoreIds(score: ScoreLike): boolean {
  const trackIds = score.tracks.map((track) => track.id);
  if (new Set(trackIds).size !== trackIds.length) return true;
  const regionIds = score.tracks.flatMap((track) => track.regions.map((region) => region.id));
  return new Set(regionIds).size !== regionIds.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Backwards-compatible array API used by composition-workflow. The attached
 * non-enumerable diagnostics preserve precise details for callers that need
 * them without changing the workflow's existing array contract.
 */
export function validateScoreOperations(
  score: ScoreLike,
  proposedOperations: unknown[],
): ValidatedScoreOperations {
  const result = validateScoreOperationsDetailed(score, proposedOperations);
  const operations = result.operations as ValidatedScoreOperations;
  Object.defineProperty(operations, "diagnostics", {
    configurable: false,
    enumerable: false,
    value: result.diagnostics,
    writable: false,
  });
  return operations;
}

export type ScoreOperationValidation = {
  /** Empty whenever any diagnostic exists: operation validation is atomic. */
  operations: Record<string, unknown>[];
  diagnostics: ScoreOperationDiagnostic[];
};

const MAX_REGION_NAME_LENGTH = 600;

const ARTICULATIONS = new Set(["sustain", "legato", "staccato", "marcato", "tremolo", "pizzicato"]);

export type ScoreOperationDiagnosticCode =
  | "invalid-operations"
  | "malformed-operation"
  | "missing-field"
  | "invalid-field"
  | "unsupported-type"
  | "missing-target"
  | "duplicate-id"
  | "invalid-timing";

export type ScoreOperationObservedType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "unknown";

export type ValidatedScoreOperations = Record<string, unknown>[] & {
  readonly diagnostics: ScoreOperationDiagnostic[];
};

/**
 * Diagnostics deliberately contain only operation indexes, schema paths, and
 * IDs. They never echo summaries, region names, pitches, velocities, or note
 * data back into a model repair prompt or an API error.
 */
export type ScoreOperationDiagnostic = {
  index: number;
  code: ScoreOperationDiagnosticCode;
  reason: string;
  fields: string[];
  targetId?: string;
  duplicateId?: string;
  /**
   * Safe summary validation metadata. Never retain or echo the submitted
   * summary itself: its type and a bounded length are sufficient for repair.
   */
  observedType?: ScoreOperationObservedType;
  observedLength?: number;
  maxLength?: number;
};

const MAX_NOTES_PER_REGION = 512;

function isString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function missingFields(record: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => record[field] === undefined);
}

function operationDiagnostic(
  index: number,
  code: ScoreOperationDiagnosticCode,
  reason: string,
  fields: string[] = [],
  extras: Pick<
    ScoreOperationDiagnostic,
    "targetId" | "duplicateId" | "observedType" | "observedLength" | "maxLength"
  > = {},
): ScoreOperationDiagnostic {
  return { index, code, reason, fields, ...extras };
}

function observedValueType(value: unknown): ScoreOperationObservedType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function summaryDiagnostic(index: number, value: unknown): ScoreOperationDiagnostic {
  return operationDiagnostic(
    index,
    "invalid-field",
    INVALID_SUMMARY_REASON,
    ["summary"],
    {
      observedType: observedValueType(value),
      ...(typeof value === "string"
        ? { observedLength: Math.min(value.length, MAX_SUMMARY_LENGTH + 1) }
        : {}),
      maxLength: MAX_SUMMARY_LENGTH,
    },
  );
}

function addRegionRecord(
  operation: Record<string, unknown>,
  index: number,
  score: ScoreLike,
  globalRegionIds: Set<string>,
  trackRegionIds: Set<string>,
): ScoreOperationDiagnostic | undefined {
  const value = operation.region;
  if (!isRecord(value)) {
    return operation.region === undefined
      ? operationDiagnostic(index, "missing-field", "required field missing", ["region"])
      : operationDiagnostic(index, "invalid-field", "region must be an object", ["region"]);
  }

  const region = value;
  const required = ["id", "name", "startBeat", "durationBeats", "dynamics", "articulation", "notes"];
  const missing = missingFields(region, required);
  if (missing.length) {
    return operationDiagnostic(index, "missing-field", "required region field missing", missing.map((field) => `region.${field}`));
  }

  const invalidString = firstInvalidField(region, ["id", "name"], {
    id: MAX_ID_LENGTH,
    name: MAX_REGION_NAME_LENGTH,
  });
  if (invalidString) {
    return operationDiagnostic(index, "invalid-field", "region field has an invalid schema value", [`region.${invalidString}`]);
  }
  const regionId = region.id as string;
  if (globalRegionIds.has(regionId) || trackRegionIds.has(regionId)) {
    return operationDiagnostic(
      index,
      "duplicate-id",
      `duplicate region ID "${regionId}"`,
      ["region.id"],
      { duplicateId: regionId },
    );
  }
  if (!isFiniteNumber(region.startBeat) || region.startBeat < 0 || region.startBeat > MAX_REGION_START_BEAT) {
    return operationDiagnostic(index, "invalid-timing", "region start timing is outside the supported range", ["region.startBeat"]);
  }
  if (!isFiniteNumber(region.durationBeats) || region.durationBeats <= 0 || region.durationBeats > MAX_REGION_DURATION_BEATS) {
    return operationDiagnostic(index, "invalid-timing", "region duration timing is outside the supported range", ["region.durationBeats"]);
  }
  if (region.startBeat + region.durationBeats > score.durationBeats) {
    return operationDiagnostic(
      index,
      "invalid-timing",
      "region timing exceeds score duration",
      ["region.startBeat", "region.durationBeats"],
    );
  }
  if (typeof region.dynamics !== "string" || !DYNAMICS.has(region.dynamics)) {
    return operationDiagnostic(index, "invalid-field", "region field has an invalid schema value", ["region.dynamics"]);
  }
  if (typeof region.articulation !== "string" || !ARTICULATIONS.has(region.articulation)) {
    return operationDiagnostic(index, "invalid-field", "region field has an invalid schema value", ["region.articulation"]);
  }
  if (!Array.isArray(region.notes)) {
    return operationDiagnostic(index, "invalid-field", "region notes must be an array", ["region.notes"]);
  }
  if (region.notes.length === 0 || region.notes.length > MAX_NOTES_PER_REGION) {
    return operationDiagnostic(index, "invalid-field", "region notes have an invalid count", ["region.notes"]);
  }

  for (let noteIndex = 0; noteIndex < region.notes.length; noteIndex += 1) {
    const note = region.notes[noteIndex];
    const field = `region.notes[${noteIndex}]`;
    if (!isRecord(note)) {
      return operationDiagnostic(index, "invalid-field", "note must be an object", [field]);
    }
    const missingNoteFields = missingFields(note, ["pitch", "velocity", "startBeat", "durationBeats", "articulation"]);
    if (missingNoteFields.length) {
      return operationDiagnostic(
        index,
        "missing-field",
        "required note field missing",
        missingNoteFields.map((name) => `${field}.${name}`),
      );
    }
    if (
      !isFiniteNumber(note.pitch) || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 ||
      !isFiniteNumber(note.velocity) || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127 ||
      typeof note.articulation !== "string" || !ARTICULATIONS.has(note.articulation)
    ) {
      return operationDiagnostic(index, "invalid-field", "note field has an invalid schema value", [field]);
    }
    if (!isFiniteNumber(note.startBeat) || note.startBeat < 0 || note.startBeat > MAX_NOTE_START_BEAT) {
      return operationDiagnostic(index, "invalid-timing", "note start timing is outside the supported range", [`${field}.startBeat`]);
    }
    if (!isFiniteNumber(note.durationBeats) || note.durationBeats <= 0 || note.durationBeats > MAX_NOTE_DURATION_BEATS) {
      return operationDiagnostic(index, "invalid-timing", "note duration timing is outside the supported range", [`${field}.durationBeats`]);
    }
    if (note.startBeat + note.durationBeats > region.durationBeats) {
      return operationDiagnostic(
        index,
        "invalid-timing",
        "note timing exceeds region duration",
        [`${field}.startBeat`, `${field}.durationBeats`],
      );
    }
  }

  return undefined;
}

const MAX_NOTE_START_BEAT = 512;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function operationRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

const MAX_REGION_START_BEAT = 512;

const DYNAMICS = new Set(["pp", "p", "mp", "mf", "f", "ff"]);

function firstInvalidField(
  record: Record<string, unknown>,
  fields: string[],
  limits: Record<string, number>,
): string | undefined {
  return fields.find((field) => {
    const value = record[field];
    return typeof value !== "string" || !isString(value, limits[field] ?? Number.MAX_SAFE_INTEGER);
  });
}

/**
 * Validate model operations atomically. A malformed operation never gets
 * filtered out while valid siblings continue to a score merge.
 */
export function validateScoreOperationsDetailed(
  score: ScoreLike,
  proposedOperations: unknown[],
): ScoreOperationValidation {
  if (!Array.isArray(proposedOperations)) {
    return {
      operations: [],
      diagnostics: [operationDiagnostic(-1, "invalid-operations", "operations must be an array", ["operations"])],
    };
  }

  const operationIds = new Set<string>();
  const simulatedRegions = new Map(
    score.tracks.map((track) => [track.id, new Set(track.regions.map((region) => region.id))]),
  );
  const globalRegionIds = new Set(
    score.tracks.flatMap((track) => track.regions.map((region) => region.id)),
  );
  const diagnostics: ScoreOperationDiagnostic[] = [];
  const accepted: Record<string, unknown>[] = [];

  for (let index = 0; index < proposedOperations.length; index += 1) {
    const original = operationRecord(proposedOperations[index]);
    if (!original) {
      diagnostics.push(operationDiagnostic(index, "malformed-operation", "operation must be an object"));
      continue;
    }

    const missing = missingFields(original, ["id", "type", "trackId", "summary"]);
    if (missing.length) {
      diagnostics.push(operationDiagnostic(index, "missing-field", "required operation field missing", missing));
      continue;
    }
    const operation = translateScoreOperation(original);
    if (!operation) {
      diagnostics.push(operationDiagnostic(index, "unsupported-type", "operation type is not supported", ["type"]));
      continue;
    }
    const invalidCommon = firstInvalidField(original, ["id", "trackId"], {
      id: MAX_ID_LENGTH,
      trackId: MAX_ID_LENGTH,
    });
    if (invalidCommon) {
      diagnostics.push(operationDiagnostic(index, "invalid-field", "operation field has an invalid schema value", [invalidCommon]));
      continue;
    }
    if (!isString(original.summary, MAX_SUMMARY_LENGTH)) {
      diagnostics.push(summaryDiagnostic(index, original.summary));
      continue;
    }
    const id = original.id as string;
    if (operationIds.has(id)) {
      diagnostics.push(operationDiagnostic(index, "duplicate-id", `duplicate operation ID "${id}"`, ["id"], { duplicateId: id }));
      continue;
    }
    operationIds.add(id);

    const trackId = original.trackId as string;
    const regionIds = simulatedRegions.get(trackId);
    if (!regionIds) {
      diagnostics.push(
        operationDiagnostic(index, "missing-target", `target track ID "${trackId}" was not found`, ["trackId"], { targetId: trackId }),
      );
      continue;
    }

    if (operation.type === "remove-region") {
      const missingRemoveFields = missingFields(original, ["regionId"]);
      if (missingRemoveFields.length) {
        diagnostics.push(operationDiagnostic(index, "missing-field", "required remove target field missing", missingRemoveFields));
        continue;
      }
      const regionId = original.regionId;
      if (!isString(regionId, MAX_ID_LENGTH)) {
        diagnostics.push(operationDiagnostic(index, "invalid-field", "remove target field has an invalid schema value", ["regionId"]));
        continue;
      }
      if (!regionIds.has(regionId)) {
        diagnostics.push(
          operationDiagnostic(
            index,
            "missing-target",
            `target region ID "${regionId}" was not found on track "${trackId}"`,
            ["regionId"],
            { targetId: regionId },
          ),
        );
        continue;
      }
      regionIds.delete(regionId);
      globalRegionIds.delete(regionId);
      accepted.push(original);
      continue;
    }

    const addDiagnostic = addRegionRecord(original, index, score, globalRegionIds, regionIds);
    if (addDiagnostic) {
      diagnostics.push(addDiagnostic);
      continue;
    }
    const region = original.region as Record<string, unknown>;
    const regionId = region.id as string;
    regionIds.add(regionId);
    globalRegionIds.add(regionId);
    accepted.push(original);
  }

  if (!diagnostics.length && accepted.length > MAX_WORKFLOW_OPERATIONS) {
    diagnostics.push(
      operationDiagnostic(
        -1,
        "invalid-operations",
        `operation count exceeds the ${MAX_WORKFLOW_OPERATIONS}-operation safety limit`,
        ["operations"],
      ),
    );
  }

  return {
    operations: diagnostics.length > 0 ? [] : accepted.slice(0, MAX_WORKFLOW_OPERATIONS),
    diagnostics,
  };
}

/** Descriptive alias for callers that need the diagnostic-bearing result. */
export const validateScoreOperationsWithDiagnostics = validateScoreOperationsDetailed;

const MAX_REGION_DURATION_BEATS = 128;

const MAX_NOTE_DURATION_BEATS = 64;

/**
 * Translate a model-shaped operation to the public operation shape without
 * coercing values or inventing defaults. This is intentionally a structural
 * translation only; score targets and timing are checked by
 * validateScoreOperationsDetailed.
 */
export function translateScoreOperation(value: unknown): Record<string, unknown> | undefined {
  const operation = operationRecord(value);
  if (!operation || (operation.type !== "add-region" && operation.type !== "remove-region")) return undefined;
  if (operation.type === "remove-region") {
    return {
      id: operation.id,
      type: operation.type,
      trackId: operation.trackId,
      regionId: operation.regionId,
      summary: operation.summary,
    };
  }
  const region = operationRecord(operation.region);
  return {
    id: operation.id,
    type: operation.type,
    trackId: operation.trackId,
    summary: operation.summary,
    region: region
      ? {
          id: region.id,
          name: region.name,
          startBeat: region.startBeat,
          durationBeats: region.durationBeats,
          dynamics: region.dynamics,
          articulation: region.articulation,
          notes: Array.isArray(region.notes)
            ? region.notes.map((note) => {
                const value = operationRecord(note);
                return value
                  ? {
                      pitch: value.pitch,
                      velocity: value.velocity,
                      startBeat: value.startBeat,
                      durationBeats: value.durationBeats,
                      articulation: value.articulation,
                    }
                  : note;
              })
            : region.notes,
        }
      : operation.region,
  };
}
