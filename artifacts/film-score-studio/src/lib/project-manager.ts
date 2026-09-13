import { getAudioBlob, saveAudioBlob } from "./audio-storage.ts";

/** Legacy pre-auth keys. Authenticated documents must use workspaceStorageKeys. */
export const PROJECT_STORAGE_KEY = "film-score-studio:project:v2";
export const PROJECT_EXTRAS_KEY = "film-score-studio:project:extras:v1";
export const LOCAL_RECOVERY_KEY = "film-score-studio:local-recovery:v1";
export const PREAUTH_RECOVERY_KEY = "film-score-studio:preauth-recovery:v1";

export type WorkspaceStorageKeys = {
  document: string;
  extras: string;
  recovery: string;
  draftPrefix: string;
  authenticated: boolean;
};

function scopeSegment(userId: string): string {
  return encodeURIComponent(userId.trim());
}

/**
 * Keep this helper as the one key contract shared with the core workspace
 * hook. Passing a Clerk user id always produces isolated keys; omitting it is
 * reserved for the explicit pre-auth/legacy flow and must never be used by an
 * authenticated workspace.
 */
export function workspaceStorageKeys(userId?: string | null): WorkspaceStorageKeys {
  if (typeof userId === "string" && userId.trim()) {
    const scope = scopeSegment(userId);
    return {
      document: `film-score-studio:user:${scope}:project:v2`,
      extras: `film-score-studio:user:${scope}:project:extras:v1`,
      recovery: `film-score-studio:user:${scope}:local-recovery:v1`,
      draftPrefix: `film-score-studio:user:${scope}:project-draft:`,
      authenticated: true,
    };
  }
  return {
    document: PROJECT_STORAGE_KEY,
    extras: PROJECT_EXTRAS_KEY,
    recovery: LOCAL_RECOVERY_KEY,
    draftPrefix: "film-score-studio:project-draft:",
    authenticated: false,
  };
}

export type WorkspaceDocument = {
  score: unknown;
  scoreRevision: number;
  messages: unknown[];
  undoStack: unknown[];
  onboarding: unknown;
  pendingProposals: unknown[];
  /** Safe evaluator failures persisted independently of score commit state. */
  terminalAudits?: unknown[];
  [key: string]: unknown;
};

export type ProjectDraftRecord = {
  projectId: string;
  baseVersion: number;
  document: WorkspaceDocument;
  updatedAt: string;
};

function projectDraftKey(userId: string, projectId: string): string {
  if (!userId.trim() || !projectId.trim()) throw new Error("A user and project are required for draft storage.");
  return `${workspaceStorageKeys(userId).draftPrefix}${encodeURIComponent(projectId)}`;
}

function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<WorkspaceDocument>;
  return Boolean(document.score)
    && Number.isInteger(document.scoreRevision)
    && Array.isArray(document.messages)
    && Array.isArray(document.undoStack)
    && Array.isArray(document.pendingProposals);
}

export function readProjectDraft(userId: string, projectId: string): ProjectDraftRecord | null {
  try {
    const raw = window.localStorage.getItem(projectDraftKey(userId, projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProjectDraftRecord>;
    if (parsed.projectId !== projectId || !Number.isInteger(parsed.baseVersion) || parsed.baseVersion! < 1 || !isWorkspaceDocument(parsed.document)) return null;
    return {
      projectId,
      baseVersion: parsed.baseVersion!,
      document: parsed.document,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeProjectDraft(userId: string, projectId: string, baseVersion: number, document: WorkspaceDocument): void {
  window.localStorage.setItem(projectDraftKey(userId, projectId), JSON.stringify({
    projectId,
    baseVersion,
    document,
    updatedAt: new Date().toISOString(),
  } satisfies ProjectDraftRecord));
}

export function clearProjectDraft(userId: string, projectId: string): void {
  window.localStorage.removeItem(projectDraftKey(userId, projectId));
}

export function projectDraftDisposition(
  draft: ProjectDraftRecord | null,
  projectId: string,
  remoteVersion: number,
): "none" | "restore" | "offer" {
  if (!draft || draft.projectId !== projectId) return "none";
  return draft.baseVersion === remoteVersion ? "restore" : "offer";
}

export type ProjectSummary = {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRecord = ProjectSummary & {
  document: WorkspaceDocument;
};

export type ApiError = Error & { status?: number; code?: string };

const EMPTY_DOCUMENT: WorkspaceDocument = {
  score: { tempo: 96, durationBeats: 64, tracks: [] },
  scoreRevision: 0,
  messages: [{
    id: "init",
    role: "assistant",
    content: "Workspace initialized. Describe a musical change to begin.",
  }],
  undoStack: [],
  onboarding: { completed: false },
  pendingProposals: [],
  terminalAudits: [],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function defaultWorkspaceDocument(): WorkspaceDocument {
  return clone(EMPTY_DOCUMENT);
}

export function readWorkspaceDocument(userId?: string | null): WorkspaceDocument | null {
  try {
    const keys = workspaceStorageKeys(userId);
    const raw = window.localStorage.getItem(keys.document);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceDocument>;
    if (!parsed.score || !Array.isArray(parsed.messages) || !Array.isArray(parsed.undoStack)) return null;
    const extras = JSON.parse(window.localStorage.getItem(keys.extras) || "{}") as Record<string, unknown>;
    return {
      ...parsed,
      scoreRevision: Number.isInteger(parsed.scoreRevision) ? parsed.scoreRevision! : 0,
      onboarding: parsed.onboarding ?? extras.onboarding ?? { completed: false },
      pendingProposals: Array.isArray(parsed.pendingProposals)
        ? parsed.pendingProposals
        : Array.isArray(extras.pendingProposals) ? extras.pendingProposals : [],
    } as WorkspaceDocument;
  } catch {
    return null;
  }
}

export function writeWorkspaceDocument(document: WorkspaceDocument, userId?: string | null): void {
  const keys = workspaceStorageKeys(userId);
  const { onboarding, pendingProposals, ...core } = document;
  window.localStorage.setItem(keys.document, JSON.stringify(core));
  window.localStorage.setItem(keys.extras, JSON.stringify({ onboarding, pendingProposals }));
}

/**
 * Keep the pre-cloud editor snapshot before opening a different project. This
 * makes the old local workspace explicitly recoverable instead of silently
 * replacing it with a remote document.
 */
export function preserveLocalWorkspace(userId?: string | null): WorkspaceDocument | null {
  const current = readWorkspaceDocument(userId);
  if (!current) return null;
  window.localStorage.setItem(workspaceStorageKeys(userId).recovery, JSON.stringify(current));
  return current;
}

/** Authenticated callers must pass their Clerk user id. */
export function readRecoveredWorkspace(userId: string): WorkspaceDocument | null {
  if (!userId.trim()) return null;
  try {
    const raw = window.localStorage.getItem(workspaceStorageKeys(userId).recovery);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceDocument;
    return parsed?.score && Array.isArray(parsed.messages) && Array.isArray(parsed.undoStack) ? parsed : null;
  } catch {
    return null;
  }
}

/** Explicit-only access for a user-initiated pre-auth recovery flow. */
export function readPreauthRecovery(): WorkspaceDocument | null {
  try {
    const raw = window.localStorage.getItem(PREAUTH_RECOVERY_KEY) || window.localStorage.getItem(LOCAL_RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceDocument;
    return parsed?.score && Array.isArray(parsed.messages) && Array.isArray(parsed.undoStack) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Move an old unscoped snapshot out of the active workspace namespace. This
 * runs on auth transitions so a second account can never inherit the prior
 * account's legacy local document. Importing this snapshot remains an
 * explicit, separately-owned recovery flow.
 */
export function quarantineLegacyWorkspace(): void {
  try {
    const legacy = readWorkspaceDocument();
    if (legacy && !window.localStorage.getItem(PREAUTH_RECOVERY_KEY)) {
      window.localStorage.setItem(PREAUTH_RECOVERY_KEY, JSON.stringify(legacy));
    }
    window.localStorage.removeItem(PROJECT_STORAGE_KEY);
    window.localStorage.removeItem(PROJECT_EXTRAS_KEY);
    window.localStorage.removeItem(LOCAL_RECOVERY_KEY);
  } catch {
    // A storage quota/private-mode failure must not block account transitions.
  }
}

export function documentFingerprint(document: WorkspaceDocument | null): string {
  return JSON.stringify(document ?? null);
}

export function shouldApplyRemoteWorkspaceSnapshot(input: {
  currentLoadKey: string;
  nextLoadKey: string;
  localFingerprint: string;
  baselineFingerprint: string;
  saveInFlight: boolean;
}): boolean {
  if (input.currentLoadKey === input.nextLoadKey) return false;
  if (!input.currentLoadKey) return true;
  return !input.saveInFlight && input.localFingerprint === input.baselineFingerprint;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string; code?: string };
      detail = body.error || detail;
      const error = new Error(detail) as ApiError;
      error.status = response.status;
      error.code = body.code;
      throw error;
    } catch (error) {
      if (error instanceof Error && (error as ApiError).status) throw error;
      throw new Error(detail);
    }
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listProjects(): Promise<{ projects: ProjectSummary[] }> {
  return request("/api/projects");
}

export async function getProject(projectId: string): Promise<ProjectRecord> {
  return request(`/api/projects/${encodeURIComponent(projectId)}`);
}

export async function createProject(name: string, document: WorkspaceDocument): Promise<ProjectRecord> {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, document }),
  });
}

export async function saveProject(
  projectId: string,
  expectedVersion: number,
  document: WorkspaceDocument,
): Promise<ProjectRecord> {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion, document }),
  });
}

export async function renameProject(
  projectId: string,
  expectedVersion: number,
  name: string,
): Promise<ProjectRecord> {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion, name }),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export async function uploadProjectAudio(
  projectId: string,
  audioId: string,
  blob: Blob,
  durationMs?: number,
): Promise<void> {
  const metadata = await request<{ uploadURL: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/audio/upload-url`,
    {
      method: "POST",
      body: JSON.stringify({
        audioId,
        contentType: blob.type || "audio/webm",
        byteSize: blob.size,
        ...(durationMs ? { durationMs } : {}),
      }),
    },
  );
  const uploadResponse = await fetch(metadata.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!uploadResponse.ok) throw new Error(`Audio upload failed (${uploadResponse.status})`);
}

function collectAudioIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAudioIds(item, ids));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.audioAttachments)) {
      record.audioAttachments.forEach((attachment) => {
        if (attachment && typeof attachment === "object" && typeof (attachment as { id?: unknown }).id === "string") {
          ids.add((attachment as { id: string }).id);
        }
      });
    }
    Object.values(record).forEach((item) => collectAudioIds(item, ids));
  }
  return ids;
}

/** Uploads local microphone bytes without ever serializing them into JSON. */
export async function uploadPendingAudio(projectId: string, document: WorkspaceDocument, userId: string): Promise<void> {
  if (!userId.trim()) throw new Error("An authenticated audio cache scope is required.");
  const ids = collectAudioIds(document.messages);
  for (const audioId of ids) {
    const blob = await getAudioBlob(audioId, userId);
    if (!blob) continue;
    await uploadProjectAudio(projectId, audioId, blob);
  }
}

/** Hydrates IndexedDB so the existing audio attachment renderer works offline. */
export async function hydrateProjectAudio(projectId: string, document: WorkspaceDocument, userId: string): Promise<void> {
  if (!userId.trim()) throw new Error("An authenticated audio cache scope is required.");
  const ids = collectAudioIds(document.messages);
  for (const audioId of ids) {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/audio/${encodeURIComponent(audioId)}`, {
        credentials: "same-origin",
      });
      if (response.ok) await saveAudioBlob(audioId, await response.blob(), userId);
    } catch {
      // Missing optional audio should not prevent a score from opening.
    }
  }
}