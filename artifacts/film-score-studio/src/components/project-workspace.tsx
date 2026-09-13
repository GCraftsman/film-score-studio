import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Cloud, Download, Loader2, Save } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { useUser } from "@clerk/react";
import { downloadProjectTrackMidi } from "@workspace/api-client-react";
import Workspace from "@/pages/workspace";
import { useProject, useSaveProject } from "@/hooks/use-projects";
import { mergeTerminalAudits } from "@/lib/workspace-state";
import {
  documentFingerprint,
  clearProjectDraft,
  hydrateProjectAudio,
  preserveLocalWorkspace,
  projectDraftDisposition,
  PROJECT_EXTRAS_KEY,
  PROJECT_STORAGE_KEY,
  readProjectDraft,
  readWorkspaceDocument,
  shouldApplyRemoteWorkspaceSnapshot,
  uploadPendingAudio,
  writeProjectDraft,
  writeWorkspaceDocument,
  type ProjectDraftRecord,
  type WorkspaceDocument,
} from "@/lib/project-manager";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type DraftNotice = {
  kind: "restored" | "offer";
  draft: ProjectDraftRecord;
  remoteVersion: number;
};

type SavedMidiTrack = {
  id: string;
  name: string;
  instrument: string;
};

function savedMidiTracks(document: WorkspaceDocument): SavedMidiTrack[] {
  const score = document.score;
  if (!score || typeof score !== "object" || !Array.isArray((score as { tracks?: unknown }).tracks)) return [];
  return (score as { tracks: unknown[] }).tracks.flatMap((track) => {
    if (!track || typeof track !== "object") return [];
    const candidate = track as Partial<SavedMidiTrack>;
    return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.instrument === "string"
      ? [{ id: candidate.id, name: candidate.name, instrument: candidate.instrument }]
      : [];
  });
}

function midiFilename(track: SavedMidiTrack): string {
  const basename = `${track.name}-${track.instrument}`
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `${basename || "score-track"}.mid`;
}

export default function ProjectWorkspace() {
  const [, params] = useRoute("/workspace/:projectId");
  const [, setLocation] = useLocation();
  const { user } = useUser();
  const userId = user?.id;
  const projectId = params?.projectId;
  const project = useProject(projectId, Boolean(userId));
  const save = useSaveProject();
  const [workspaceKey, setWorkspaceKey] = useState("loading");
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [draftNotice, setDraftNotice] = useState<DraftNotice | null>(null);
  const [downloadingTrackId, setDownloadingTrackId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const baselineRef = useRef("");
  const versionRef = useRef(0);
  const loadRef = useRef("");
  const dirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const tracks = useMemo(
    () => project.data ? savedMidiTracks(project.data.document as WorkspaceDocument) : [],
    [project.data],
  );

  useEffect(() => {
    if (!userId || !project.data) return;
    const nextLoadKey = `${project.data.id}:${project.data.version}`;
    if (!shouldApplyRemoteWorkspaceSnapshot({
      currentLoadKey: loadRef.current,
      nextLoadKey,
      localFingerprint: documentFingerprint(readWorkspaceDocument(userId)),
      baselineFingerprint: baselineRef.current,
      saveInFlight: saveInFlightRef.current,
    })) return;
    loadRef.current = nextLoadKey;
    const remoteDocument = project.data.document as WorkspaceDocument;
    const draft = readProjectDraft(userId, project.data.id);
    const draftDisposition = projectDraftDisposition(draft, project.data.id, project.data.version);
    const serverTerminalAudits = [
      ...(Array.isArray(remoteDocument.terminalAudits) ? remoteDocument.terminalAudits : []),
      ...(Array.isArray((project.data as { terminalAudits?: unknown }).terminalAudits)
        ? (project.data as unknown as { terminalAudits: unknown[] }).terminalAudits
        : []),
    ];
    // Keep a local draft's score and approval checkpoint intact, while merging
    // server-owned terminal evidence that may have been recorded after the
    // last document save. The audit is deliberately independent of score
    // commit state.
    const document = draftDisposition === "restore" && draft
      ? {
        ...draft.document,
        terminalAudits: mergeTerminalAudits(draft.document.terminalAudits, serverTerminalAudits),
      }
      : {
        ...remoteDocument,
        terminalAudits: mergeTerminalAudits(remoteDocument.terminalAudits, serverTerminalAudits),
      };
    preserveLocalWorkspace(userId);
    writeWorkspaceDocument(document, userId);
    // A restored draft is dirty relative to the server baseline and must stay
    // explicitly saveable. The remote document remains the optimistic-lock
    // baseline, not the draft itself.
    baselineRef.current = documentFingerprint(remoteDocument);
    versionRef.current = project.data.version;
    dirtyRef.current = draftDisposition === "restore";
    setDraftNotice(draft && draftDisposition !== "none" ? {
      kind: draftDisposition === "restore" ? "restored" : "offer",
      draft,
      remoteVersion: project.data.version,
    } : null);
    setReady(false);
    void hydrateProjectAudio(project.data.id, document, userId).finally(() => {
      setWorkspaceKey(`${project.data.id}:${project.data.version}:${Date.now()}`);
      setReady(true);
      setIsDirty(draftDisposition === "restore");
      setSaveState(draftDisposition === "restore" ? "dirty" : "saved");
      setSaveError("");
    });
  }, [project.data, userId]);

  // The existing editor owns its state and local recovery store. Polling this
  // tiny JSON snapshot keeps the integration non-invasive while still making
  // the explicit project Save button authoritative.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const current = readWorkspaceDocument(userId);
      const dirty = documentFingerprint(current) !== baselineRef.current;
      dirtyRef.current = dirty;
      setIsDirty(dirty);
      if (userId && projectId && dirty && current) {
        writeProjectDraft(userId, projectId, versionRef.current, current);
      }
      if (dirty && saveState === "saved") setSaveState("dirty");
    }, 500);
    return () => {
      window.clearInterval(timer);
      // Route changes can happen before the 500ms persistence tick. Capture
      // this project's draft on unmount so opening another project can never
      // accidentally reuse the previous project's local document.
      const current = readWorkspaceDocument(userId);
      if (userId && projectId && documentFingerprint(current) !== baselineRef.current && current) {
        writeProjectDraft(userId, projectId, versionRef.current, current);
      }
    };
  }, [projectId, ready, saveState, userId]);

  const saveCurrent = useCallback(async () => {
    if (!userId || !project.data || save.isPending || saveInFlightRef.current) return;
    const document = readWorkspaceDocument(userId);
    if (!document) {
      setSaveError("The local workspace snapshot is unavailable. Your existing local project was not erased.");
      setSaveState("error");
      return;
    }
    const submittedFingerprint = documentFingerprint(document);
    saveInFlightRef.current = true;
    setSaveState("saving");
    setSaveError("");
    try {
      await uploadPendingAudio(project.data.id, document, userId);
      const updated = await save.mutateAsync({
        projectId: project.data.id,
        expectedVersion: versionRef.current,
        document,
      });
      versionRef.current = updated.version;
      baselineRef.current = submittedFingerprint;
      // The editor may have continued writing D1 while D0 was uploading or
      // being patched. Keep that newer local snapshot instead of loading the
      // D0 query result returned by the mutation.
      loadRef.current = `${updated.id}:${updated.version}`;
      const currentFingerprint = documentFingerprint(readWorkspaceDocument(userId));
      const changedDuringSave = currentFingerprint !== submittedFingerprint;
      dirtyRef.current = changedDuringSave;
      setIsDirty(changedDuringSave);
      if (changedDuringSave) {
        const current = readWorkspaceDocument(userId);
        if (current) writeProjectDraft(userId, updated.id, updated.version, current);
      } else {
        clearProjectDraft(userId, updated.id);
      }
      setDraftNotice(null);
      setSaveState(changedDuringSave ? "dirty" : "saved");
    } catch (cause) {
      const error = cause as { status?: number; message?: string };
      setSaveState(error.status === 409 ? "conflict" : "error");
      setSaveError(error.status === 409
        ? "This project changed in another tab or device. Reload it before saving to avoid overwriting newer work."
        : error.message || "Could not save the project. Your local workspace remains available.");
      dirtyRef.current = documentFingerprint(readWorkspaceDocument(userId)) !== baselineRef.current;
      setIsDirty(dirtyRef.current);
      const current = readWorkspaceDocument(userId);
      if (current) writeProjectDraft(userId, project.data.id, versionRef.current, current);
    } finally {
      saveInFlightRef.current = false;
    }
  }, [project.data, save, userId]);

  const restoreDraft = useCallback(() => {
    if (!userId || !project.data || !draftNotice) return;
    const remoteDocument = project.data.document as WorkspaceDocument;
    const serverTerminalAudits = [
      ...(Array.isArray(remoteDocument.terminalAudits) ? remoteDocument.terminalAudits : []),
      ...(Array.isArray((project.data as { terminalAudits?: unknown }).terminalAudits)
        ? (project.data as unknown as { terminalAudits: unknown[] }).terminalAudits
        : []),
    ];
    const restoredDocument = {
      ...draftNotice.draft.document,
      terminalAudits: mergeTerminalAudits(draftNotice.draft.document.terminalAudits, serverTerminalAudits),
    };
    const current = readWorkspaceDocument(userId);
    if (current) preserveLocalWorkspace(userId);
    writeWorkspaceDocument(restoredDocument, userId);
    writeProjectDraft(userId, project.data.id, draftNotice.draft.baseVersion, restoredDocument);
    baselineRef.current = documentFingerprint(project.data.document as WorkspaceDocument);
    versionRef.current = project.data.version;
    dirtyRef.current = true;
    setIsDirty(true);
    setSaveState("dirty");
    setSaveError("");
    setDraftNotice({ ...draftNotice, kind: "restored" });
    setWorkspaceKey(`${project.data.id}:${project.data.version}:draft:${Date.now()}`);
  }, [draftNotice, project.data, userId]);

  const keepServerDraft = useCallback(() => {
    if (!userId || !project.data) return;
    clearProjectDraft(userId, project.data.id);
    setDraftNotice(null);
  }, [project.data, userId]);

  const downloadTrack = useCallback(async (track: SavedMidiTrack) => {
    if (!userId || !project.data || downloadingTrackId) return;
    const localDocument = readWorkspaceDocument(userId);
    const hasUnsavedChanges = documentFingerprint(localDocument) !== baselineRef.current;
    if (hasUnsavedChanges) {
      dirtyRef.current = true;
      setIsDirty(true);
      setDownloadError("Save first: MIDI downloads are generated from the saved project score.");
      return;
    }
    setDownloadingTrackId(track.id);
    setDownloadError("");
    try {
      const midi = await downloadProjectTrackMidi(project.data.id, track.id, { responseType: "blob" });
      if (midi.size === 0) throw new Error("The saved track did not contain downloadable MIDI data.");
      const url = URL.createObjectURL(midi);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = midiFilename(track);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "Could not download the saved MIDI track.");
    } finally {
      setDownloadingTrackId(null);
    }
  }, [downloadingTrackId, project.data, userId]);

  const leave = () => {
    if (userId && project.data && isDirty) {
      const current = readWorkspaceDocument(userId);
      if (current) writeProjectDraft(userId, project.data.id, versionRef.current, current);
    }
    if (isDirty && !window.confirm("You have unsaved changes. Leave without saving? Your local workspace remains recoverable.")) return;
    setLocation("/user-portal");
  };

  if (project.isLoading || !ready) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening project…</div>;
  }
  if (project.error || !project.data) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 text-center">
        <AlertTriangle className="mb-4 h-8 w-8 text-destructive" />
        <h1 className="font-display text-xl">Project unavailable</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">It may have been deleted, or you may not have access to it. Projects are strictly private to the signed-in account.</p>
        <button onClick={() => setLocation("/user-portal")} className="mt-5 rounded-lg border border-border px-4 py-2 text-sm hover:bg-white/5">Back to projects</button>
      </div>
    );
  }

  return (
    <div className="relative h-[100dvh]">
      <Workspace key={workspaceKey} userId={userId} projectId={projectId} />
      <div className="pointer-events-none absolute inset-x-0 top-32 z-40 flex flex-wrap items-start justify-between gap-2 p-3 md:inset-x-auto md:right-0 md:top-0 md:w-[480px]">
        <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card/95 px-2 py-1.5 shadow-xl backdrop-blur">
          <button onClick={leave} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Projects
          </button>
          <div className="h-5 w-px bg-border" />
          <span className="max-w-36 truncate px-1 font-display text-sm sm:max-w-44">{project.data.name}</span>
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-xl border border-border bg-card/95 px-2 py-1.5 shadow-xl backdrop-blur">
          {tracks.length > 0 && (
            <details className="relative">
              <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground ${isDirty ? "text-amber-300" : ""}`}>
                <Download className="h-3.5 w-3.5" /> {isDirty ? "Save first" : "MIDI"}
              </summary>
              <div className="absolute right-0 top-9 z-50 w-60 rounded-lg border border-border bg-card p-2 shadow-xl">
                <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Saved score tracks</p>
                {isDirty && <p className="px-2 pb-2 text-[10px] leading-relaxed text-amber-300">Save first so the download matches your current score.</p>}
                <div className="space-y-1">
                  {tracks.map((track) => (
                    <button
                      key={track.id}
                      type="button"
                      disabled={isDirty || downloadingTrackId !== null}
                      onClick={() => void downloadTrack(track)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-[11px] hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{track.name}</span>
                        <span className="block truncate text-[9px] text-muted-foreground">{track.instrument}</span>
                      </span>
                      {downloadingTrackId === track.id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : <Download className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  ))}
                </div>
              </div>
            </details>
          )}
          <span className={`flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider ${
            saveState === "error" || saveState === "conflict" ? "text-destructive" : saveState === "dirty" ? "text-amber-300" : "text-emerald-400"
          }`}>
            {saveState === "saving" && <Loader2 className="h-3 w-3 animate-spin" />}
            {saveState === "saved" && <Check className="h-3 w-3" />}
            {saveState === "dirty" && <Cloud className="h-3 w-3" />}
            {saveState === "conflict" ? "Conflict" : saveState === "error" ? "Save failed" : saveState === "saving" ? "Saving" : saveState === "dirty" ? "Unsaved" : "Saved"}
          </span>
          <button onClick={() => void saveCurrent()} disabled={saveState === "saving" || !isDirty} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
            <Save className="h-3.5 w-3.5" /> Save
          </button>
        </div>
      </div>
      {saveError && (
        <div className="pointer-events-auto absolute right-3 top-[13rem] z-40 flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-card/95 p-3 text-xs text-destructive shadow-xl md:top-16">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}
      {downloadError && (
        <div className="pointer-events-auto absolute right-3 top-[16rem] z-40 flex max-w-sm items-start gap-2 rounded-lg border border-amber-500/30 bg-card/95 p-3 text-xs text-amber-300 shadow-xl md:top-28">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{downloadError}</span>
        </div>
      )}
      {draftNotice && (
        <div className="pointer-events-auto absolute left-3 top-[13rem] z-40 flex max-w-lg items-center gap-3 rounded-lg border border-primary/30 bg-card/95 p-3 text-xs text-primary shadow-xl md:left-auto md:right-3 md:top-24">
          <span>
            {draftNotice.kind === "restored"
              ? `Unsaved changes restored for this project from revision ${draftNotice.draft.baseVersion}. Save when ready.`
              : `An unsaved draft from revision ${draftNotice.draft.baseVersion} is available; the server is at revision ${draftNotice.remoteVersion}.`}
          </span>
          {draftNotice.kind === "offer" && (
            <span className="flex shrink-0 gap-2">
              <button onClick={restoreDraft} className="rounded border border-primary/40 px-2 py-1 font-semibold hover:bg-primary/10">Restore draft</button>
              <button onClick={keepServerDraft} className="rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5">Keep server</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export { PROJECT_STORAGE_KEY, PROJECT_EXTRAS_KEY };