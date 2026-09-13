import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, projectAudioTable, projectsTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { isOwnedProjectObjectPath, ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { canReuseAudioId } from "../lib/audio-ownership";
import {
  persistProjectMidiFiles,
  ProjectMidiValidationError,
  readProjectMidiMetadata,
  withProjectMidiMetadata,
} from "../lib/project-midi-storage";
import { preserveLatestTerminalAudits } from "../lib/terminal-audit";

const router: IRouter = Router();
const storage = new ObjectStorageService();
// Complete MIDI snippets can appear in the message, onboarding, and pending
// approval records. Keep enough headroom for those intentional copies while
// still bounding authenticated project payloads.
const MAX_DOCUMENT_BYTES = 4_000_000;
const projectIdSchema = z.string().uuid();
const documentSchema = z.object({
  score: z.unknown(),
  scoreRevision: z.number().int().nonnegative(),
  messages: z.array(z.unknown()),
  undoStack: z.array(z.unknown()),
  onboarding: z.unknown().optional(),
  pendingProposals: z.array(z.unknown()).optional(),
}).passthrough();
const nameSchema = z.string().trim().min(1).max(160);

function authUser(req: Request): string {
  return (req as AuthenticatedRequest).userId;
}

function containsBinary(value: unknown, key = ""): boolean {
  if (typeof value === "string") {
    return value.startsWith("data:") || /base64|blob|bytes|arraybuffer/i.test(key);
  }
  if (Array.isArray(value)) return value.some((item) => containsBinary(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, child]) => containsBinary(child, childKey));
  }
  return false;
}

function parseDocument(input: unknown): Record<string, unknown> | null {
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success || containsBinary(parsed.data)) return null;
  if (JSON.stringify(parsed.data).length > MAX_DOCUMENT_BYTES) return null;
  return {
    ...parsed.data,
    onboarding: parsed.data.onboarding ?? { completed: false },
    pendingProposals: parsed.data.pendingProposals ?? [],
  } as Record<string, unknown>;
}

function projectResponse(project: typeof projectsTable.$inferSelect) {
  return {
    id: project.id,
    name: project.name,
    version: project.version,
    document: project.document,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function midiFilename(track: Record<string, unknown>, trackId: string): string {
  const source = typeof track.name === "string" && track.name.trim() ? track.name : trackId;
  const safe = source
    .replace(/\.mid$/i, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${safe || "track"}.mid`;
}

router.use(requireAuth);

router.get("/projects", async (req, res) => {
  const projects = await db.select({
    id: projectsTable.id,
    name: projectsTable.name,
    version: projectsTable.version,
    createdAt: projectsTable.createdAt,
    updatedAt: projectsTable.updatedAt,
  }).from(projectsTable)
    .where(eq(projectsTable.ownerId, authUser(req)))
    .orderBy(desc(projectsTable.updatedAt));
  res.json({ projects });
});

router.post("/projects", async (req, res) => {
  const name = nameSchema.safeParse(req.body?.name);
  const document = parseDocument(req.body?.document);
  if (!name.success || !document) {
    res.status(400).json({ error: "A valid name and complete workspace document are required" });
    return;
  }
  const projectId = randomUUID();
  let persistedDocument: Record<string, unknown>;
  try {
    const midiMetadata = await persistProjectMidiFiles({
      document,
      ownerId: authUser(req),
      projectId,
      storage,
    });
    persistedDocument = withProjectMidiMetadata(document, midiMetadata);
    if (JSON.stringify(persistedDocument).length > MAX_DOCUMENT_BYTES) {
      res.status(400).json({ error: "Invalid or oversized workspace document" });
      return;
    }
  } catch (error) {
    if (error instanceof ProjectMidiValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  const [project] = await db.insert(projectsTable).values({
    id: projectId,
    ownerId: authUser(req),
    name: name.data,
    document: persistedDocument,
  }).returning();
  res.status(201).json(projectResponse(project));
});

router.get("/projects/:projectId", async (req, res) => {
  const id = projectIdSchema.safeParse(req.params.projectId);
  if (!id.success) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, id.data), eq(projectsTable.ownerId, authUser(req)))).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(projectResponse(project));
});

router.patch("/projects/:projectId", async (req, res) => {
  const id = projectIdSchema.safeParse(req.params.projectId);
  if (!id.success) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const expectedVersion = z.number().int().positive().safeParse(req.body?.expectedVersion);
  if (!expectedVersion.success) {
    res.status(400).json({ error: "expectedVersion is required" });
    return;
  }
  const nextName = req.body?.name === undefined ? undefined : nameSchema.safeParse(req.body.name);
  const nextDocument = req.body?.document === undefined ? undefined : parseDocument(req.body.document);
  if (nextName && !nextName.success) {
    res.status(400).json({ error: "Invalid project name" });
    return;
  }
  if (req.body?.document !== undefined && !nextDocument) {
    res.status(400).json({ error: "Invalid or oversized workspace document" });
    return;
  }
  let persistedDocument = nextDocument;
  if (nextDocument) {
    const [current] = await db.select({
      document: projectsTable.document,
    }).from(projectsTable).where(and(
      eq(projectsTable.id, id.data),
      eq(projectsTable.ownerId, authUser(req)),
    )).limit(1);
    if (!current) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    try {
      const midiMetadata = await persistProjectMidiFiles({
        document: nextDocument,
        previousDocument: current.document as Record<string, unknown>,
        ownerId: authUser(req),
        projectId: id.data,
        storage,
      });
      persistedDocument = withProjectMidiMetadata(nextDocument, midiMetadata);
      if (JSON.stringify(persistedDocument).length > MAX_DOCUMENT_BYTES) {
        res.status(400).json({ error: "Invalid or oversized workspace document" });
        return;
      }
    } catch (error) {
      if (error instanceof ProjectMidiValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }
  const values = {
    ...(nextName ? { name: nextName.data } : {}),
    ...(persistedDocument ? { document: preserveLatestTerminalAudits(persistedDocument) } : {}),
    version: expectedVersion.data + 1,
    updatedAt: new Date(),
  };
  if (!Object.keys(values).length) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [updated] = await db.update(projectsTable).set(values)
    .where(and(
      eq(projectsTable.id, id.data),
      eq(projectsTable.ownerId, authUser(req)),
      eq(projectsTable.version, expectedVersion.data),
    )).returning();
  if (updated) {
    res.json(projectResponse(updated));
    return;
  }
  const [latest] = await db.select({ version: projectsTable.version }).from(projectsTable)
    .where(and(eq(projectsTable.id, id.data), eq(projectsTable.ownerId, authUser(req)))).limit(1);
  if (!latest) res.status(404).json({ error: "Project not found" });
  else res.status(409).json({ error: "Project changed elsewhere", code: "STALE_VERSION", version: latest.version });
});

router.delete("/projects/:projectId", async (req, res) => {
  const id = projectIdSchema.safeParse(req.params.projectId);
  if (!id.success) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [deleted] = await db.delete(projectsTable).where(and(
    eq(projectsTable.id, id.data), eq(projectsTable.ownerId, authUser(req)),
  )).returning({ id: projectsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  await db.delete(projectAudioTable).where(and(
    eq(projectAudioTable.projectId, id.data), eq(projectAudioTable.ownerId, authUser(req)),
  ));
  res.status(204).end();
});

router.post("/projects/:projectId/audio/upload-url", async (req, res) => {
  const id = projectIdSchema.safeParse(req.params.projectId);
  const contentType = z.string().regex(/^audio\//).max(120).safeParse(req.body?.contentType);
  const byteSize = z.number().int().positive().max(25 * 1024 * 1024).safeParse(req.body?.byteSize);
  const durationMs = z.number().int().positive().max(10 * 60 * 1000).optional().safeParse(req.body?.durationMs);
  const requestedAudioId = req.body?.audioId === undefined ? randomUUID() : z.string().uuid().safeParse(req.body.audioId);
  const audioId = typeof requestedAudioId === "string" ? requestedAudioId : requestedAudioId.success ? requestedAudioId.data : null;
  if (!id.success || !contentType.success || !byteSize.success || !audioId || (req.body?.durationMs !== undefined && !durationMs.success)) {
    res.status(400).json({ error: "Invalid audio upload metadata" });
    return;
  }
  const [project] = await db.select({ id: projectsTable.id }).from(projectsTable)
    .where(and(eq(projectsTable.id, id.data), eq(projectsTable.ownerId, authUser(req)))).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const objectPath = storage.objectPath(authUser(req), id.data, audioId);
  const [existingAudio] = await db.select({
    ownerId: projectAudioTable.ownerId,
    projectId: projectAudioTable.projectId,
  }).from(projectAudioTable).where(eq(projectAudioTable.id, audioId)).limit(1);
  if (!canReuseAudioId(existingAudio, authUser(req), id.data)) {
    res.status(409).json({ error: "Audio id is already associated with another owner or project", code: "AUDIO_ID_CONFLICT" });
    return;
  }
  const uploadURL = await storage.createUploadUrl(objectPath, contentType.data);
  try {
    const [insertedAudio] = await db.insert(projectAudioTable).values({
      id: audioId,
      projectId: id.data,
      ownerId: authUser(req),
      objectPath,
      contentType: contentType.data,
      byteSize: byteSize.data,
      durationMs: durationMs.success ? durationMs.data : null,
    }).onConflictDoNothing({
      target: projectAudioTable.id,
    }).returning({ id: projectAudioTable.id });
    if (!insertedAudio) {
      const [conflictingAudio] = await db.select({
        ownerId: projectAudioTable.ownerId,
        projectId: projectAudioTable.projectId,
      }).from(projectAudioTable).where(eq(projectAudioTable.id, audioId)).limit(1);
      if (!canReuseAudioId(conflictingAudio, authUser(req), id.data)) {
        res.status(409).json({ error: "Audio id is already associated with another owner or project", code: "AUDIO_ID_CONFLICT" });
        return;
      }
      await db.update(projectAudioTable).set({
        objectPath,
        contentType: contentType.data,
        byteSize: byteSize.data,
        durationMs: durationMs.success ? durationMs.data : null,
      }).where(and(
        eq(projectAudioTable.id, audioId),
        eq(projectAudioTable.ownerId, authUser(req)),
        eq(projectAudioTable.projectId, id.data),
      ));
    }
  } catch (error) {
    // A concurrent request can win the global id race after the ownership
    // check. Never let that conflict overwrite the existing association.
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "Audio id is already associated with another owner or project", code: "AUDIO_ID_CONFLICT" });
      return;
    }
    throw error;
  }
  res.json({ audioId, uploadURL, objectPath });
});

router.get("/projects/:projectId/audio/:audioId", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId);
  const audioId = z.string().uuid().safeParse(req.params.audioId);
  if (!projectId.success || !audioId.success) {
    res.status(400).json({ error: "Invalid audio path" });
    return;
  }
  const [audio] = await db.select().from(projectAudioTable).where(and(
    eq(projectAudioTable.id, audioId.data),
    eq(projectAudioTable.projectId, projectId.data),
    eq(projectAudioTable.ownerId, authUser(req)),
  )).limit(1);
  if (!audio) {
    res.status(404).json({ error: "Audio not found" });
    return;
  }
  try {
    const response = await storage.download(await storage.getFile(audio.objectPath));
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    else res.end();
  } catch (error) {
    if (error instanceof ObjectNotFoundError) res.status(404).json({ error: "Audio object not found" });
    else {
      req.log.error({ err: error }, "Audio download failed");
      res.status(500).json({ error: "Audio download failed" });
    }
  }
});

router.get("/projects/:projectId/midi/:trackId", async (req, res) => {
  const projectId = projectIdSchema.safeParse(req.params.projectId);
  const trackId = z.string().min(1).max(80).safeParse(req.params.trackId);
  if (!projectId.success || !trackId.success) {
    res.status(400).json({ error: "Invalid MIDI path" });
    return;
  }
  const [project] = await db.select({
    document: projectsTable.document,
  }).from(projectsTable).where(and(
    eq(projectsTable.id, projectId.data),
    eq(projectsTable.ownerId, authUser(req)),
  )).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const document = project.document as Record<string, unknown>;
  const score = document.score && typeof document.score === "object" && !Array.isArray(document.score)
    ? document.score as Record<string, unknown>
    : null;
  const tracks = score && Array.isArray(score.tracks) ? score.tracks : [];
  const track = tracks.find((value): value is Record<string, unknown> => (
    Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).id === trackId.data
  ));
  const midiFile = readProjectMidiMetadata(document)[trackId.data];
  if (!track || !midiFile || !isOwnedProjectObjectPath(midiFile.objectPath, authUser(req), projectId.data)) {
    res.status(404).json({ error: "MIDI track not found" });
    return;
  }

  try {
    const response = await storage.download(await storage.getFile(midiFile.objectPath));
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Content-Disposition", `attachment; filename="${midiFilename(track, trackId.data)}"`);
    if (response.body) Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    else res.end();
  } catch (error) {
    if (error instanceof ObjectNotFoundError) res.status(404).json({ error: "MIDI object not found" });
    else {
      req.log.error({ err: error }, "MIDI download failed");
      res.status(500).json({ error: "MIDI download failed" });
    }
  }
});

export default router;