import { findPlayableInstrument } from "./scoring-agents.ts";

/** Membership proposals are not musical edits. A canonical instrument already
 * in the score is reused rather than presenting a redundant approval gate. */
export function reuseExistingInstruments<T extends { id: string; action: string; instrument: string; trackId?: string }>(
  tracks: Array<{ id: string; instrument: string }>,
  proposals: T[],
): T[] {
  const ids = new Set<string>();
  const deletes = new Set<string>();
  for (const proposal of proposals) {
    if (ids.has(proposal.id)) throw new Error("Instrument audit returned duplicate proposal IDs.");
    ids.add(proposal.id);
    if (proposal.action === "delete") {
      if (!proposal.trackId || deletes.has(proposal.trackId)) throw new Error("Instrument audit returned duplicate or missing delete targets.");
      deletes.add(proposal.trackId);
    }
  }
  const canonical = (name: string) => findPlayableInstrument(name)?.id ?? name.trim().toLowerCase();
  const retained = new Set(tracks.filter((track) => !deletes.has(track.id)).map((track) => canonical(track.instrument)));
  return proposals.filter((proposal) => {
    if (proposal.action !== "add") return true;
    const instrument = canonical(proposal.instrument);
    if (retained.has(instrument)) return false;
    retained.add(instrument);
    return true;
  });
}