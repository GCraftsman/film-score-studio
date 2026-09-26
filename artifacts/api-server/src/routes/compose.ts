import { randomUUID } from "node:crypto";
import {
  ComposeWithOrchestratorBody,
  ComposeWithOrchestratorResponse,
} from "@workspace/api-zod";
import { approvalCheckpointConsumptionsTable, db } from "@workspace/db";
import { Router, type IRouter } from "express";
import {
  findPlayableInstrument,
  fullMidiMaterial,
  PLAYABLE_INSTRUMENTS,
  playableInstrumentCatalogPrompt,
} from "../lib/scoring-agents";
import {
  normalizeMusicDirection,
  screenMusicText,
} from "../lib/ai-music-safety";
import { hasDuplicateScoreIds } from "../lib/score-operations";
import { reuseExistingInstruments } from "../lib/instrument-proposals";
import { normalizeStyleSuggestions, styleSuggestionSystemPrompt } from "../lib/style-suggestions";
import {
  classifyIntent,
  runCompositionWorkflow,
  type ModelMessage,
  type WorkflowIntent,
  type WorkflowModel,
  type WorkflowEvent,
  type RejectedAdviserTextDiagnostic,
  type ScoreValue,
  WorkflowFailure,
  OperationValidationError,
  type WorkflowDiagnostic,
} from "../lib/composition-workflow";
import {
  composeRequestId,
  createComposeDiagnosticSink,
  terminalComposeAudit,
  workflowProgress,
  type ComposeProgressEvent,
} from "./compose-diagnostics";
import { persistTerminalAudit, projectBelongsToOwner } from "../lib/terminal-audit";
import {
  diagnosticSummary,
  envelopeShape,
  normalizeModelCompletion,
  parseModelJson,
  safeProviderMetadata,
  type ModelCallContext,
  ModelResponseError,
  throwForCompletionFailure,
} from "../lib/model-diagnostics";
import { requireAuth } from "../middlewares/requireAuth";
import type { AuthenticatedRequest } from "../middlewares/requireAuth";
import {
  ApprovalContextIntegrityError,
  accumulateApprovedMembershipProposals,
  assertApprovedProposalSubset,
  consumeApprovalCheckpoint,
  distinctMembershipProposals,
  reconcileNewMembershipProposals,
  signApprovalContext,
  suppressRejectedMembershipProposals,
  verifyApprovalContext,
} from "../lib/composition-approval-integrity";
import {
  chatDetailed,
  providerRequestTimeoutMs,
} from "../lib/xai-chat-completion";
import { createXaiProvider, type XaiProvider } from "../lib/xai-provider";
import { xaiLaunchLimiter } from "../lib/chat-limiter";
import { logTemporaryRejectedAdviserText } from "../lib/temporary-rejected-adviser-text";
import { ObjectStorageService } from "../lib/objectStorage";
import { loadAdvisoryMidiRef, persistAdvisoryMidiClip } from "../lib/adviser-suggestions";
import type { AdviserSuggestion, AdvisoryMidiRef } from "../lib/adviser-suggestions";
import { composeRequestAbortController } from "../lib/compose-cancellation";

const router: IRouter = Router();
router.use(requireAuth);
const advisoryMidiStorage = new ObjectStorageService();

// Keep the timeout sizing helper available to route-level callers and tests.
export { providerRequestTimeoutMs };

function safetyNormalizedHistory(history: unknown[]): unknown[] {
  return history.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const message = entry as Record<string, unknown>;
    return typeof message.content === "string"
      ? { ...message, content: screenMusicText(normalizeMusicDirection(message.content)) }
      : message;
  });
}

async function getModel(provider: XaiProvider, signal?: AbortSignal): Promise<string> {
  const proxyFetch = provider.createProxyFetch("xai");
  const response = await xaiLaunchLimiter.schedule(
    () => proxyFetch("/v1/language-models", { method: "GET", signal }),
    signal,
  );
  if (!response.ok) throw new Error(`xAI model discovery failed (${response.status})`);
  const payload = await response.json() as { models?: Array<{ id?: string }>; data?: Array<{ id?: string }> };
  const models = payload.models ?? payload.data ?? [];
  const preferred = models.find((candidate) => candidate.id?.includes("grok-4") && candidate.id.includes("fast"))
    ?? models.find((candidate) => candidate.id?.includes("grok-4")) ?? models[0];
  if (!preferred?.id) throw new Error("xAI returned no language models");
  return preferred.id;
}

async function chat(
  provider: XaiProvider,
  model: string,
  messages: ModelMessage[],
  maxTokens: number,
  jsonMode = false,
  signal?: AbortSignal,
): Promise<string> {
  const completion = await chatDetailed(provider, model, messages, maxTokens, jsonMode, undefined, signal);
  throwForCompletionFailure(normalizeModelCompletion(completion));
  return completion.content;
}

async function modelJson(
  model: WorkflowModel,
  messages: ModelMessage[],
  maxTokens: number,
  context: ModelCallContext,
  onDiagnostic?: (diagnostic: WorkflowDiagnostic) => void,
): Promise<Record<string, unknown>> {
  try {
    const result = model.completeDetailed
      ? await model.completeDetailed(messages, maxTokens, true)
      : model.complete
        ? await model.complete(messages, maxTokens, true)
        : undefined;
    const completion = normalizeModelCompletion(result);
    throwForCompletionFailure(completion);
    return parseModelJson(completion.content, { provider: completion.metadata });
  } catch (error) {
    if (error instanceof ModelResponseError) {
      const diagnostic = { ...error.diagnostic, ...context };
      error.message = diagnosticSummary(diagnostic, context);
      onDiagnostic?.(diagnostic);
    } else {
      onDiagnostic?.({
        code: "model-request-failure",
        reason: "The model request failed before a safe response could be classified.",
        responseChars: 0,
        envelope: envelopeShape(undefined),
        ...context,
      });
    }
    throw error;
  }
}

async function semanticSafetyText(
  model: WorkflowModel,
  rawText: string,
  purpose: "preflight" | "final",
  onDiagnostic?: (diagnostic: WorkflowDiagnostic) => void,
): Promise<string> {
  const safePayload = await modelJson(model, [
    {
      role: "system",
      content: [
        `You are a ${purpose} music-safety filter, not a composer.`,
        "Return JSON only: {\"safeText\":\"...\"}.",
        "Replace identifiable artists, works, characters, lyrics, melodies, motifs, recordings, and sound-alike requests with neutral original musical attributes. Do not repeat names or titles.",
        purpose === "preflight"
          ? "Return a self-contained, safe composer direction. Preserve safe editing intent."
          : "Preserve the concrete workflow summary while removing identifiable references.",
      ].join("\n"),
    },
    { role: "user", content: rawText },
  ], 360, { stage: "initial", agent: purpose === "preflight" ? "Safety preflight" : "Safety final" }, onDiagnostic);
  const safeText = safePayload.safeText;
  if (typeof safeText !== "string" || !safeText.trim()) throw new Error("MUSIC_SAFETY_REVIEW_UNAVAILABLE");
  return screenMusicText(normalizeMusicDirection(safeText));
}

function baseResponse(response: string, operations: unknown[] = []) {
  return {
    response,
    workflow: "composition" as const,
    styleSuggestions: [],
    trackProposals: [],
    consultations: [],
    usageGuard: "Bounded read-only adviser consultation, one writer per assigned track, an isolated staged candidate, and final verification protect the saved score. Proposed track additions and removals always require explicit approval.",
    operations,
  };
}

function normalizeApprovedMembership(
  proposals: unknown[] | undefined,
  approvedIds: string[] | undefined,
  score: { tracks: Array<{ id: string; instrument: string }> },
) {
  if (!proposals?.length && !approvedIds?.length) return [];
  if (!proposals || !approvedIds || proposals.length > 32 || approvedIds.length > 32) {
    throw new WorkflowFailure("Approved instrument membership must include the exact selected addition or deletion proposals.");
  }
  const existing = new Set(score.tracks.map((track) => findPlayableInstrument(track.instrument)?.id));
  const seen = new Set<string>();
  const deletedTrackIds = new Set<string>();
  const approvedIdSet = new Set(approvedIds);
  if (approvedIdSet.size !== approvedIds.length) throw new WorkflowFailure("Approved instrument membership contained duplicate proposal IDs.");
  const result = proposals.map((item) => {
    if (!item || typeof item !== "object") throw new WorkflowFailure("Approved instrument membership was malformed.");
    const value = item as Record<string, unknown>;
    const playable = findPlayableInstrument(typeof value.instrument === "string" ? value.instrument : "");
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const action = value.action;
    if (!playable || (action !== "add" && action !== "delete") || !id || id.length > 370 || seen.has(id) || !approvedIdSet.has(id)) {
      throw new WorkflowFailure("Approved instrument membership was unsupported, duplicated, or not selected.");
    }
    seen.add(id);
    if (action === "add" && existing.has(playable.id)) {
      throw new WorkflowFailure("Approved instrument addition was already present.");
    }
    const targetTrackId = typeof value.trackId === "string" ? value.trackId : undefined;
    const targetTrack = targetTrackId ? score.tracks.find((track) => track.id === targetTrackId) : undefined;
    if (action === "delete" && (!targetTrack || findPlayableInstrument(targetTrack.instrument)?.id !== playable.id)) {
      throw new WorkflowFailure("Approved instrument deletion did not match the current score.");
    }
    if (action === "delete" && deletedTrackIds.has(targetTrackId!)) {
      throw new WorkflowFailure("Approved instrument membership deleted the same track more than once.");
    }
    if (action === "add") existing.add(playable.id);
    if (action === "delete") deletedTrackIds.add(targetTrackId!);
    return {
      id,
      action,
      ...(action === "add" ? { trackId: `track-${id}` } : { trackId: targetTrackId! }),
      instrument: playable.name,
      role: playable.role,
      midiProgram: playable.midiProgram,
      summary: screenMusicText(typeof value.summary === "string" ? value.summary.slice(0, 1_200) : "", `${action === "add" ? "Add" : "Remove"} ${playable.name}.`),
      reason: screenMusicText(typeof value.reason === "string" ? value.reason.slice(0, 2_500) : "", "Explicit composer approval."),
    };
  });
  if (seen.size !== approvedIdSet.size) throw new WorkflowFailure("Approved instrument membership was missing a selected proposal.");
  return result;
}

async function styleGate(
  model: WorkflowModel,
  direction: string,
  selectedStyle?: string,
  sourceMidi?: unknown,
  onDiagnostic?: (diagnostic: WorkflowDiagnostic) => void,
): Promise<Record<string, unknown>> {
  if (!selectedStyle) {
    const plan = await modelJson(model, [
       { role: "system", content: styleSuggestionSystemPrompt() },
      { role: "user", content: JSON.stringify({ direction, completeSourceMidi: sourceMidi }) },
    ], 1200, { stage: "initial", agent: "Style specialist" }, onDiagnostic);
    const styles = normalizeStyleSuggestions(plan.styleSuggestions);
    return {
      ...baseResponse(screenMusicText(typeof plan.response === "string" ? plan.response : "", "Choose a scoring style before creating tracks.")),
      workflow: "style-intake",
      styleSuggestions: styles,
      editWorkflow: { intent: "discussion", status: "discussion", summary: "Style selection is required before composition.", tasks: [], events: [], changedFiles: [] },
    };
  }
  const proposal = await modelJson(model, [
    { role: "system", content: `You are the instrument-approval specialist. Return JSON only: {"response":"...","trackProposals":[{"id":"...","action":"add","instrument":"exact catalog instrument","role":"...","midiProgram":0,"summary":"...","reason":"..."}]}. These are pending approval only: do not create score operations. ${playableInstrumentCatalogPrompt()}` },
    { role: "user", content: JSON.stringify({ direction, selectedStyle, completeSourceMidi: sourceMidi }) },
  ], 1200, { stage: "initial", agent: "Instrument approval specialist" }, onDiagnostic);
  const rawTrackProposals = proposal.trackProposals;
  if (!Array.isArray(rawTrackProposals) || rawTrackProposals.length > 32) throw new WorkflowFailure("Instrument approval returned malformed proposals.");
  const trackProposals = rawTrackProposals.map((item) => {
    if (!item || typeof item !== "object") throw new WorkflowFailure("Instrument approval returned a malformed proposal.");
    const value = item as Record<string, unknown>;
    const playable = findPlayableInstrument(typeof value.instrument === "string" ? value.instrument : "");
    if (!playable || value.action !== "add" || typeof value.id !== "string" || !value.id ||
      typeof value.summary !== "string" || !value.summary || typeof value.reason !== "string" || !value.reason) {
      throw new WorkflowFailure("Instrument approval returned a malformed or unsupported proposal.");
    }
    return {
      id: value.id,
      action: "add" as const, instrument: playable.name, role: playable.role, midiProgram: playable.midiProgram,
       summary: screenMusicText(value.summary, `Pending ${playable.name} approval`).slice(0, 1_200),
      reason: screenMusicText(value.reason, "Pending explicit approval."),
    };
  });
  return {
    ...baseResponse(screenMusicText(typeof proposal.response === "string" ? proposal.response : "", "Review the proposed instruments before approval.")),
    workflow: "instrument-approval",
    selectedStyle,
    trackProposals: reuseExistingInstruments([], trackProposals),
    editWorkflow: { intent: "discussion", status: "discussion", summary: "Instrument proposals remain pending approval.", tasks: [], events: [], changedFiles: [] },
  };
}

async function instrumentAudit(
  model: WorkflowModel,
  direction: string,
  score: { tracks: Array<{ id: string; instrument: string; role: string; midiProgram: number }> },
  sourceMidi: unknown,
  onDiagnostic?: (diagnostic: WorkflowDiagnostic) => void,
): Promise<Array<Record<string, unknown>>> {
  const payload = await modelJson(model, [
    {
      role: "system",
      content: [
        "You are the instrument-approval auditor. Inspect the existing score before composition.",
        "Return JSON only: {\"trackProposals\":[{\"id\":\"...\",\"action\":\"delete\",\"trackId\":\"required\",\"instrument\":\"catalog instrument\",\"role\":\"...\",\"midiProgram\":0,\"summary\":\"...\",\"reason\":\"...\"}]}.",
         "Propose only deletions here. Every membership change requires explicit user approval. Never output score operations or claim a track changed.",
        "Reuse existing score.tracks by default, including empty saved tracks. A request to compose, generate, or play piano uses the existing Piano; it is NOT a request to add another Piano.",
        "Return an empty trackProposals array when the existing instruments can perform the request. This editor reuses one track per catalog instrument; melody and accompaniment can share one piano track.",
          `Existing instruments may be deleted only when necessary. Any separately proposed additions must use this supported catalog. ${playableInstrumentCatalogPrompt()}`,
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ direction, score, completeSourceMidi: sourceMidi }) },
  ], 1200, { stage: "initial", agent: "Instrument approval auditor" }, onDiagnostic);
  const raw = payload.trackProposals;
  if (!Array.isArray(raw) || raw.length > 32) throw new WorkflowFailure("Instrument audit returned malformed proposals; no score change was made.");
  const byId = new Map(score.tracks.map((track) => [track.id, track]));
  const proposals = raw
    // Additions are no longer an approval gate at this early audit. They are
    // rediscovered and expanded automatically by planning/evaluation.
    .filter((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).action === "add"))
    .map((item, index) => {
      if (!item || typeof item !== "object") throw new WorkflowFailure("Instrument audit returned a malformed proposal.");
      const proposal = item as Record<string, unknown>;
      const action = proposal.action;
      const id = typeof proposal.id === "string" ? proposal.id : "";
      const summary = typeof proposal.summary === "string" ? proposal.summary : "";
      const reason = typeof proposal.reason === "string" ? proposal.reason : "";
      if (!id || !summary || !reason || action !== "delete") {
        throw new WorkflowFailure("Instrument audit returned a malformed proposal.");
      }
      const track = byId.get(typeof proposal.trackId === "string" ? proposal.trackId : "");
      if (!track) throw new WorkflowFailure("Instrument audit proposed deleting an unknown track.");
      return {
        id, action, trackId: track.id, instrument: track.instrument, role: track.role, midiProgram: track.midiProgram,
        summary: screenMusicText(summary, "Pending instrument removal").slice(0, 1_200),
        reason: screenMusicText(reason, "Pending explicit approval."),
      };
    });
  return reuseExistingInstruments(score.tracks, proposals).filter((proposal) => proposal.action === "delete");
}

async function hasRemainingNoteEdit(
  model: WorkflowModel,
  message: string,
  history: unknown[],
  score: unknown,
  selectedStyle: string | undefined,
  onDiagnostic?: (diagnostic: WorkflowDiagnostic) => void,
): Promise<boolean> {
  const result = await modelJson(model, [
    {
      role: "system",
      content: "After explicit membership authorization, semantically decide whether this exact request still asks to alter notes, regions, timing, pitch, velocity, or other playable score material. Deletions may already be reflected in the score; approved additions are committed only with a verified result. Return JSON only: {\"noteEdit\":boolean}. Approval/confirmation of a membership change alone is false. Do not use keyword matching.",
    },
    { role: "user", content: JSON.stringify({ message, history, currentApprovedScore: score, selectedStyle }) },
  ], 240, { stage: "initial", agent: "Membership continuation classifier" }, onDiagnostic);
  if (typeof result.noteEdit !== "boolean") throw new WorkflowFailure("The membership continuation could not be classified safely.");
  return result.noteEdit;
}

router.post(["/compose", "/compose/stream"], async (req, res): Promise<void> => {
  // projectId is intentionally read from the raw request body rather than
  // generated API validation. Stream composition is a local NDJSON contract,
  // and the project id is only used for owner-scoped terminal-audit storage.
  const projectId = req.body?.projectId;
  const parsed = ComposeWithOrchestratorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = (req as AuthenticatedRequest).userId;
  if (projectId !== undefined && (typeof projectId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId))) {
    res.status(400).json({ error: "Invalid project identifier." });
    return;
  }
  if (projectId && !await projectBelongsToOwner(userId, projectId)) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const terminalEvents: WorkflowEvent[] = [];
  const createdAdvisoryObjectPaths: string[] = [];
  const streaming = req.path.endsWith("/stream");
  const workflowId = randomUUID();
  const requestId = composeRequestId(req.id);
  const requestCancellation = composeRequestAbortController(
    req,
    res,
  );
  const requestSignal = requestCancellation.signal;
  const throwIfRequestAborted = () => {
    if (!requestSignal.aborted) return;
    const error = new Error("The composition request was disconnected.");
    error.name = "AbortError";
    throw error;
  };
  const emit = (event: ComposeProgressEvent) => {
    if (event.type === "workflow-progress") {
      terminalEvents.push(event as WorkflowEvent);
      if (terminalEvents.length > 100) terminalEvents.shift();
    }
    if (!requestSignal.aborted && streaming && !res.writableEnded && !res.destroyed) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };
  if (streaming) {
    res.status(200).set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
  }
  try {
    if (hasDuplicateScoreIds(parsed.data.score)) throw new WorkflowFailure("Score track and region IDs must be unique.");
    const approvedMembership = parsed.data.approvedTrackProposalIds !== undefined ||
      parsed.data.approvedTrackProposals !== undefined;
    if (parsed.data.approvalContext && !approvedMembership) {
      throw new ApprovalContextIntegrityError("A saved approval checkpoint may only be used with its explicit membership decision.");
    }
    if (approvedMembership && !parsed.data.approvalContext) {
      throw new ApprovalContextIntegrityError("This membership approval is missing its server-signed checkpoint. Request a new composition plan before approving tracks.");
    }
    const verifiedCheckpoint = parsed.data.approvalContext
      ? verifyApprovalContext(parsed.data.approvalContext, userId, parsed.data.score)
      : undefined;
    if (verifiedCheckpoint && verifiedCheckpoint.context.projectId !== projectId) {
      throw new ApprovalContextIntegrityError("The saved approval checkpoint is bound to a different project.");
    }
    if (approvedMembership) {
      assertApprovedProposalSubset(
        parsed.data.approvedTrackProposals,
        parsed.data.approvedTrackProposalIds,
        verifiedCheckpoint!.offeredTrackProposals,
      );
    }
    const approvedMembershipProposals = approvedMembership
      ? normalizeApprovedMembership(
        parsed.data.approvedTrackProposals as unknown[] | undefined,
        parsed.data.approvedTrackProposalIds,
        parsed.data.score,
      )
      : [];
    const approvedMembershipIds = new Set(approvedMembershipProposals.map((proposal) => proposal.id));
    const accumulatedApprovedMembershipProposals = accumulateApprovedMembershipProposals(
      verifiedCheckpoint?.accumulatedApprovedTrackProposals ?? [],
      approvedMembershipProposals,
    );
    const declinedMembershipProposals = verifiedCheckpoint
      ? distinctMembershipProposals([
        ...verifiedCheckpoint.declinedTrackProposals,
        ...verifiedCheckpoint.offeredTrackProposals.filter((proposal) => {
        const id = proposal && typeof proposal === "object" && typeof (proposal as Record<string, unknown>).id === "string"
          ? (proposal as Record<string, unknown>).id as string
          : "";
        return !approvedMembershipIds.has(id);
        }),
      ])
      : [];
    if (verifiedCheckpoint) {
      // INSERT ... ON CONFLICT is the durable, atomic claim. It runs before
      // connector/model work, so a replay can never reset a paused workflow's
      // shared budgets or create a second staged candidate.
      await consumeApprovalCheckpoint(async () => {
        const [claimed] = await db.insert(approvalCheckpointConsumptionsTable)
          .values({
            checkpointId: verifiedCheckpoint!.checkpointId,
            signature: parsed.data.approvalContext!.signature,
            ownerId: userId,
          })
          .onConflictDoNothing({ target: approvalCheckpointConsumptionsTable.checkpointId })
          .returning({ checkpointId: approvalCheckpointConsumptionsTable.checkpointId });
        return Boolean(claimed);
      });
    }
    // A continuation is a signed checkpoint, not a new user message. Every
    // model-visible source input comes from it so mutable request JSON cannot
    // change intent classification, preflight direction, style, or context.
    const sourceMessage = verifiedCheckpoint?.context.originalMessage ?? parsed.data.message;
    const sourceHistory = verifiedCheckpoint?.context.originalHistory ?? parsed.data.history;
    // The checkpoint was parsed by the generated request contract before its
    // signature was verified; preserve that MIDI shape while discarding every
    // mutable request source field on a resume.
    const sourceMidi = verifiedCheckpoint?.context.originalMidi ?? parsed.data.midiSnippets;
    const sourceStyle = verifiedCheckpoint?.context.selectedStyle ?? parsed.data.selectedStyle;
    const provider = createXaiProvider();
    const modelId = await getModel(provider, requestSignal);
    const model: WorkflowModel = {
      complete: (messages, maxTokens, jsonMode) =>
        chat(provider, modelId, messages, maxTokens, jsonMode, requestSignal),
      completeDetailed: (messages, maxTokens, jsonMode) =>
        chatDetailed(provider, modelId, messages, maxTokens, jsonMode, undefined, requestSignal),
    };
    const logDiagnostic = (
      diagnostic: WorkflowDiagnostic,
      correlatedRequestId = requestId,
      correlatedWorkflowId: string = workflowId,
    ) => {
      req.log.warn({
        requestId: correlatedRequestId,
        workflowId: correlatedWorkflowId,
        taskId: diagnostic.taskId,
        agent: diagnostic.agent,
        stage: diagnostic.stage,
        repairAttempt: diagnostic.attempt,
        code: diagnostic.code,
        reason: diagnostic.reason,
        operationIndex: diagnostic.index,
        operationFields: diagnostic.fields,
        operationTargetId: diagnostic.targetId,
        operationDuplicateId: diagnostic.duplicateId,
        operationObservedType: diagnostic.observedType,
        operationObservedLength: diagnostic.observedLength,
        operationMaxLength: diagnostic.maxLength,
        maxTokens: diagnostic.maxTokens,
        responseChars: diagnostic.responseChars,
        requestedTokens: diagnostic.requestedTokens,
        envelopeKeys: diagnostic.envelope.keys,
        envelopeTypes: diagnostic.envelope.types,
        envelopeUnknownKeyCount: diagnostic.envelope.unknownKeyCount,
        provider: diagnostic.provider,
      }, "composition model response diagnostic");
    };
    const emitDiagnostic = createComposeDiagnosticSink(requestId, workflowId, emit, logDiagnostic);

    // This is intentionally the very first model call for every composer
    // message. No keyword or regex path may mutate a question.
    const intent = await classifyIntent(model, sourceMessage, sourceHistory, sourceMidi, emitDiagnostic);
    emit(workflowProgress({ stage: "intent-classified", message: `Semantic intent classified as ${intent}.`, agent: "Orchestrator" }));
    const safeDirection = await semanticSafetyText(model, [
      `Composer direction: ${sourceMessage || "(MIDI only)"}`,
      "Complete attached MIDI material:",
      fullMidiMaterial(sourceMidi),
    ].join("\n"), "preflight", emitDiagnostic);
    const safeOriginalMessage = screenMusicText(normalizeMusicDirection(sourceMessage));
    const safeHistory = safetyNormalizedHistory(sourceHistory);
    // An explicit empty decision means "continue with the current instruments",
    // not "ask for membership approval again".
    const phase = approvedMembership
      ? "composition"
      : parsed.data.score.tracks.length === 0
      ? (sourceStyle ? "instrument-approval" : "style-intake")
      : (parsed.data.phase ?? "composition");

    // Approval gates remain non-mutating even when the semantic intent was
    // edit. A question bypasses them to a discussion-only Orchestrator reply.
    if (intent === "edit" && phase !== "composition" && !sourceStyle) {
      const result = ComposeWithOrchestratorResponse.parse(await styleGate(
        model,
        safeDirection,
        sourceStyle,
        sourceMidi,
        emitDiagnostic,
      ));
      throwIfRequestAborted();
      if (streaming) { emit({ type: "result", result }); res.end(); } else res.json(result);
      return;
    }
    // New checkpoints bind this decision in the initial Orchestrator plan and
    // therefore never reclassify the mutable approval continuation. Legacy
    // checkpoints lack the field and retain the bounded compatibility
    // classifier until they are replaced by a fresh plan.
    const membershipOnly = approvedMembership && (
      verifiedCheckpoint?.context.requiresPlayableMaterial !== undefined
        ? !verifiedCheckpoint.context.requiresPlayableMaterial
        : !await hasRemainingNoteEdit(
          model,
          sourceMessage,
          sourceHistory,
          parsed.data.score,
          sourceStyle,
          emitDiagnostic,
        )
    );
    // Track membership is audited before any region-edit specialists run.
    // Returned additions/deletions are proposals only; the workflow never
    // changes approved tracks and the client must obtain explicit approval.
    // The composition workflow owns the adviser-first membership plan. Do not
    // run a second route-level audit that can bypass that shared budget or
    // regenerate an approval gate after a persisted continuation resumes.
    const trackProposals: Array<Record<string, unknown>> = [];
    if (trackProposals.length) {
      const result = ComposeWithOrchestratorResponse.parse({
        ...baseResponse("Instrument membership changes are pending your explicit approval; no score material was changed."),
        workflow: "instrument-approval",
        selectedStyle: parsed.data.selectedStyle,
        trackProposals,
        editWorkflow: {
          intent: "discussion",
          status: "discussion",
          summary: "Approve or reject the proposed instrument membership changes before composition resumes.",
          tasks: [],
          events: [{ stage: "instrument-approval", message: "Track membership proposals are waiting for explicit approval.", agent: "Orchestrator" }],
          changedFiles: [],
        },
      });
      emit(workflowProgress({ stage: "instrument-approval", message: "Track membership proposals are waiting for explicit approval.", agent: "Orchestrator" }));
      throwIfRequestAborted();
      if (streaming) { emit({ type: "result", result }); res.end(); } else res.json(result);
      return;
    }
    // Deletions are client-applied before this continuation call. Approved
    // additions remain authorization metadata until a verified workflow result
    // returns them alongside any operations, so they can be committed
    // atomically. If an approved deletion leaves no playable tracks,
    // completing that membership transaction is the only valid result; no
    // region agent is invoked and no proposal is regenerated.
    if (membershipOnly) {
      const result = ComposeWithOrchestratorResponse.parse({
        ...baseResponse("Approved instrument membership changes are recorded. No further note or region edit was requested."),
        selectedStyle: sourceStyle,
         trackProposals: accumulatedApprovedMembershipProposals,
        editWorkflow: {
          intent: "edit",
          status: "verified",
           summary: "Approved membership change was verified without a region edit.",
          tasks: [],
           events: [{ stage: "membership-verified", message: "Approved track membership was atomically applied; no region MIDI was changed.", agent: "Orchestrator" }],
          changedFiles: [],
        },
      });
      emit(workflowProgress({ stage: "membership-verified", message: "Approved track membership was recorded; no region MIDI was changed.", agent: "Orchestrator" }));
      throwIfRequestAborted();
      if (streaming) { emit({ type: "result", result }); res.end(); } else res.json(result);
      return;
    }

     const workflowInput = {
      model,
       message: sourceMessage,
      safeDirection: declinedMembershipProposals.length
        ? `${safeDirection}\n\nApproval state: the composer declined these offered membership changes (${declinedMembershipProposals.map((proposal) => {
          const value = proposal as Record<string, unknown>;
          return `${value.action === "delete" ? "remove" : "add"} ${typeof value.instrument === "string" ? value.instrument : "instrument"}`;
        }).join(", ")}). Continue the original request using the approved/current membership; do not propose those declined members again in this continuation.`
        : safeDirection,
      intent,
      score: parsed.data.score,
       sourceMidi,
      projectId,
        approvedTrackProposals: accumulatedApprovedMembershipProposals,
      workflowId,
      requestId,
      originalMessage: safeOriginalMessage,
       selectedStyle: sourceStyle,
      history: safeHistory,
       onEvent: (event: WorkflowEvent) => {
         emit(workflowProgress(event));
       },
      onDiagnostic: logDiagnostic,
      // TEMPORARY SENSITIVE DIAGNOSTIC: this callback is gated and production
      // hard-disabled; remove it with the helper after false positives are diagnosed.
      onRejectedAdviserText: (diagnostic: RejectedAdviserTextDiagnostic) => {
        logTemporaryRejectedAdviserText(req.log, diagnostic);
      },
      persistAdvisoryMidiClip: projectId
        ? async (suggestion: AdviserSuggestion, score: ScoreValue) => {
          if (!suggestion.midiClip) {
            throw new WorkflowFailure("Advisory MIDI persistence was requested without a validated clip.");
          }
          const ref = await persistAdvisoryMidiClip({
            ownerId: userId,
            projectId,
            suggestion,
            clip: suggestion.midiClip,
            score,
            storage: advisoryMidiStorage,
          });
          createdAdvisoryObjectPaths.push(ref.objectPath);
          return ref;
        }
        : undefined,
      loadAdvisoryMidiRef: projectId
        ? async (ref: AdvisoryMidiRef) => loadAdvisoryMidiRef({
          ownerId: userId,
          projectId,
          ref,
          storage: advisoryMidiStorage,
        })
        : undefined,
      ...(verifiedCheckpoint ? { approvalContext: verifiedCheckpoint.context } : {}),
      };
     const workflow = await runCompositionWorkflow(workflowInput);
     const response = await semanticSafetyText(model, workflow.summary, "final", emitDiagnostic);
       const approvalContext = workflow.approvalContext;
      // A membership proposal is never an implicit permission to alter the
      // saved score. This also fail-closes older workflow implementations that
      // still return verified operations alongside an unapproved proposal.
        // Do not use proposal IDs alone here: an agent can accidentally reuse
        // one for a different add/delete request. Exact reissues are already
        // authorized, while semantic collisions are reissued for approval.
        const unapprovedWorkflowProposals = reconcileNewMembershipProposals(
          workflow.trackProposals,
          accumulatedApprovedMembershipProposals,
        );
       const rejectedMembership = suppressRejectedMembershipProposals(
         unapprovedWorkflowProposals,
         declinedMembershipProposals,
       );
       const suppressedRejectedMembership = rejectedMembership.suppressed.length > 0;
      const pendingWorkflowProposals = unapprovedWorkflowProposals.length > 0
         ? rejectedMembership.allowed
        : !approvedMembership && workflow.status === "discussion"
          ? workflow.trackProposals
          : [];
      const approvalRequired = pendingWorkflowProposals.length > 0;
       if (approvalRequired && !approvalContext) {
         throw new WorkflowFailure("The membership checkpoint could not be secured. No score material was changed.");
       }
       const verifiedMembership = approvalRequired
        ? pendingWorkflowProposals
         : suppressedRejectedMembership
           ? []
           : accumulatedApprovedMembershipProposals;
       const safeWorkflow = approvalRequired || suppressedRejectedMembership ? {
        ...workflow,
        status: "discussion" as const,
        operations: [],
        events: [...workflow.events, {
           stage: suppressedRejectedMembership ? "membership-reproposal-suppressed" : "instrument-approval",
           message: suppressedRejectedMembership
             ? "Previously declined track membership was not proposed again; no staged candidate was applied."
             : "Track additions or removals are waiting for explicit composer approval; the staged candidate was not applied.",
          agent: "Orchestrator",
        }],
        changedFiles: [],
      } : workflow;
      const signedResultApprovalContext = approvalContext && approvalRequired
        ? signApprovalContext(
          {
            ...approvalContext,
            // A resumed checkpoint never re-signs mutable request context.
            // Bind the next pause to the exact trusted source used above.
            originalMessage: verifiedCheckpoint?.context.originalMessage ?? approvalContext.originalMessage,
            originalHistory: verifiedCheckpoint?.context.originalHistory ?? approvalContext.originalHistory,
            originalMidi: sourceMidi,
            ...(sourceStyle ? { selectedStyle: sourceStyle } : {}),
          },
          userId,
          parsed.data.score,
          pendingWorkflowProposals,
          declinedMembershipProposals,
          accumulatedApprovedMembershipProposals,
        )
        : undefined;
      const result = ComposeWithOrchestratorResponse.parse({
        ...baseResponse(response, approvalRequired || suppressedRejectedMembership ? [] : workflow.operations),
        workflow: approvalRequired ? "instrument-approval" : "composition",
       selectedStyle: sourceStyle,
        trackProposals: approvalRequired ? pendingWorkflowProposals : verifiedMembership,
      consultations: workflow.consultations,
        ...(signedResultApprovalContext ? { approvalContext: signedResultApprovalContext } : {}),
      editWorkflow: {
         intent: safeWorkflow.intent,
         status: safeWorkflow.status,
        summary: response,
         tasks: safeWorkflow.tasks,
         events: safeWorkflow.events,
         changedFiles: safeWorkflow.changedFiles,
      },
    });
    throwIfRequestAborted();
    if (streaming) { emit({ type: "result", result }); res.end(); } else res.json(result);
  } catch (error) {
    // Advisory clips are temporary and are never score material. Remove
    // objects created by a failed transaction on a best-effort basis; if the
    // provider/storage is unavailable they remain private under the
    // authenticated owner/project prefix and can never be loaded elsewhere.
    await Promise.all(createdAdvisoryObjectPaths.map(async (objectPath) => {
      try {
        await advisoryMidiStorage.delete(objectPath);
      } catch {
        // Failure cleanup must not mask the original composition diagnostic.
      }
    }));
    // Disconnects are expected cancellation, not workflow failures. In
    // particular, do not persist a terminal audit or attempt to write an
    // error after the composer has stopped listening.
    if (requestSignal.aborted) return;
    if (error instanceof OperationValidationError) {
      // Operation diagnostics are already content-free. Preserve the exact
      // safe reason and bounded schema observations for audit/debugging,
      // while never logging operation summaries, notes, or repair prompts.
      req.log.warn({
        requestId,
        workflowId,
        operationCode: error.diagnostic.code,
        operationIndex: error.diagnostic.index,
        operationFields: error.diagnostic.fields,
        operationReason: error.diagnostic.reason,
        operationObservedType: error.diagnostic.observedType,
        operationObservedLength: error.diagnostic.observedLength,
        operationMaxLength: error.diagnostic.maxLength,
      }, "composition operation validation failed");
    } else if (!(error instanceof ModelResponseError)) {
      req.log.error({
        requestId,
        workflowId,
        errorType: error instanceof Error ? error.name : "unknown",
      }, "composition workflow failed");
    }
    const message = error instanceof WorkflowFailure || error instanceof ApprovalContextIntegrityError
      ? error.message
      : error instanceof ModelResponseError
        ? error.message
      : error instanceof Error && error.message === "MUSIC_SAFETY_REVIEW_UNAVAILABLE"
        ? "The music safety review could not complete, so no AI response was shown. Please try again."
        : "The scoring room could not respond just now.";
    const diagnostics = terminalComposeAudit(workflowId, requestId, message, terminalEvents);
    req.log.warn({ terminalAudit: diagnostics }, "composition terminal audit");
    let auditSaved = !projectId;
    if (projectId) {
      try {
        auditSaved = await persistTerminalAudit(userId, projectId, diagnostics);
      } catch (auditError) {
        req.log.warn({
          requestId,
          workflowId,
          errorType: auditError instanceof Error ? auditError.name : "unknown",
        }, "terminal composition audit was not persisted");
      }
    }
    const terminalMessage = auditSaved ? message :
      `${message} The server could not save this failure audit; save the project to retain the local copy.`;
    if (streaming) {
      emit({ type: "error", error: terminalMessage, diagnostics });
      res.end();
    } else res.status(error instanceof WorkflowFailure || error instanceof ApprovalContextIntegrityError || error instanceof ModelResponseError ? 422 : 502).json({ error: terminalMessage, diagnostics });
  } finally {
    requestCancellation.dispose();
  }
});

export default router;
