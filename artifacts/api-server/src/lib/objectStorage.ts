import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Storage, type File } from "@google-cloud/storage";

const SIDECAR = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: { url: `${SIDECAR}/credential`, format: { type: "json", subject_token_field_name: "access_token" } },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

function parseStoragePath(path: string): { bucketName: string; objectName: string } {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/");
  if (parts.length < 3 || !parts[1] || !parts.slice(2).join("/")) throw new Error("Invalid object path");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function privateDir(): string {
  const value = process.env.PRIVATE_OBJECT_DIR;
  if (!value) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  return value.replace(/\/+$/, "");
}

function objectNameForPath(objectPath: string): string {
  if (!/^\/objects\/projects\/[A-Za-z0-9_-]+\/[0-9a-f-]+\/[0-9a-f-]+$/.test(objectPath)) {
    throw new ObjectNotFoundError();
  }
  return `${privateDir()}/${objectPath.slice("/objects/".length)}`;
}

async function signObjectUrl(
  bucketName: string,
  objectName: string,
  method: "PUT" | "GET",
  contentType?: string,
): Promise<string> {
  const response = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      ...(contentType ? { content_type: contentType } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Failed to sign object URL (${response.status})`);
  const payload = (await response.json()) as { signed_url?: string };
  if (!payload.signed_url) throw new Error("Object storage returned no signed URL");
  return payload.signed_url;
}

export class ObjectStorageService {
  objectPath(ownerId: string, projectId: string, audioId: string = randomUUID()): string {
    if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) throw new Error("Invalid owner id");
    if (!/^[0-9a-f-]+$/.test(projectId) || !/^[0-9a-f-]+$/.test(audioId)) throw new Error("Invalid object id");
    return `/objects/projects/${ownerId}/${projectId}/${audioId}`;
  }

  trackMidiObjectPath(ownerId: string, projectId: string, objectId: string = randomUUID()): string {
    return this.objectPath(ownerId, projectId, objectId);
  }

  async createUploadUrl(objectPath: string, contentType: string): Promise<string> {
    const { bucketName, objectName } = parseStoragePath(objectNameForPath(objectPath));
    return signObjectUrl(bucketName, objectName, "PUT", contentType);
  }

  async upload(objectPath: string, bytes: Buffer, contentType: string): Promise<void> {
    const uploadURL = await this.createUploadUrl(objectPath, contentType);
    const response = await fetch(uploadURL, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
      },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Failed to upload object (${response.status})`);
  }

  async getFile(objectPath: string): Promise<File> {
    const { bucketName, objectName } = parseStoragePath(objectNameForPath(objectPath));
    const file = storage.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }

  async download(file: File): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const body = Readable.toWeb(file.createReadStream()) as ReadableStream;
    return new Response(body, {
      headers: {
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": String(metadata.size || 0),
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  async delete(objectPath: string): Promise<void> {
    try {
      const file = await this.getFile(objectPath);
      await file.delete();
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }
}

/**
 * MIDI metadata is stored in a project document, but object paths must still
 * be constrained to the authenticated owner's project prefix before a file is
 * read. This deliberately accepts only the same path shape emitted above.
 */
export function isOwnedProjectObjectPath(
  objectPath: unknown,
  ownerId: string,
  projectId: string,
): objectPath is string {
  if (typeof objectPath !== "string") return false;
  if (!/^[A-Za-z0-9_-]+$/.test(ownerId) || !/^[0-9a-f-]+$/.test(projectId)) return false;
  const prefix = `/objects/projects/${ownerId}/${projectId}/`;
  return objectPath.startsWith(prefix)
    && /^[A-Za-z0-9_-]+$/.test(objectPath.slice(prefix.length));
}