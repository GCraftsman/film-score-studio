export type AudioOwnership = {
  ownerId: string;
  projectId: string;
};

/**
 * Audio ids are client-generated UUIDs, but the database keeps a legacy
 * global primary key for compatibility. Never replace a row when the same id
 * belongs to another owner or project; callers must return a conflict.
 */
export function canReuseAudioId(
  existing: AudioOwnership | undefined,
  ownerId: string,
  projectId: string,
): boolean {
  return !existing || (existing.ownerId === ownerId && existing.projectId === projectId);
}