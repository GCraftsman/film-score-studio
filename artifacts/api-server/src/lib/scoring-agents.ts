export const SCORING_AGENTS = {
  instrument: [
    "Strings",
    "Brass",
    "Woodwinds",
    "Percussion",
    "Keyboards & Harp",
    "Choir & Voice",
    "Synths & Sound Design",
  ],
  style: [
    "Classical & Romantic",
    "Modernist & Avant-Garde",
    "Jazz & Big Band",
    "Electronic & Hybrid",
    "Folk & World Traditions",
    "Minimalism & Ambient",
    "Contemporary Cinematic",
  ],
  concept: [
    "Dramatic Arc",
    "Theme & Leitmotif",
    "Harmony & Voice Leading",
    "Rhythm & Kinetics",
    "Texture & Register",
    "Continuity & Transitions",
    "Sync & Pacing",
  ],
} as const;

/**
 * Instrument proposals must resolve to a sound that the browser's sample
 * catalog can actually play. Keep this allow-list aligned with the client
 * catalog IDs, names, roles, SoundFont bank/programs, and General MIDI
 * programs. Legacy tracks are routed only when their saved identity resolves
 * to one of these entries; unsupported identities are intentionally omitted.
 */
export const PLAYABLE_INSTRUMENTS = [
  { id: "piano", name: "Upright Piano", aliases: ["Piano"], role: "keyboards", midiProgram: 0, soundfont: { bankId: "upright-piano-kw", bank: 128, program: 0 } },
  { id: "string-ensemble", name: "String Ensemble", role: "strings", midiProgram: 48, soundfont: { bankId: "gm", bank: 0, program: 48 } },
  { id: "violin", name: "Violin", role: "strings", midiProgram: 40, soundfont: { bankId: "gm", bank: 0, program: 40 } },
  { id: "cello", name: "Cello", role: "strings", midiProgram: 42, soundfont: { bankId: "gm", bank: 0, program: 42 } },
  { id: "french-horn", name: "French Horn", role: "brass", midiProgram: 60, soundfont: { bankId: "gm", bank: 0, program: 60 } },
  { id: "trombone", name: "Trombone", role: "brass", midiProgram: 57, soundfont: { bankId: "gm", bank: 0, program: 57 } },
  { id: "flute", name: "Flute", role: "woodwinds", midiProgram: 73, soundfont: { bankId: "gm", bank: 0, program: 73 } },
  { id: "timpani", name: "Timpani", role: "percussion", midiProgram: 47, soundfont: { bankId: "gm", bank: 0, program: 47 } },
  { id: "synth-bass", name: "Electronic Bass", role: "synths", midiProgram: 38, soundfont: { bankId: "gm", bank: 0, program: 38 } },
  { id: "synth-lead", name: "Electronic Lead", role: "synths", midiProgram: 81, soundfont: { bankId: "gm", bank: 0, program: 81 } },
  { id: "synth-pad", name: "Atmospheric Pad", role: "synths", midiProgram: 89, soundfont: { bankId: "gm", bank: 0, program: 89 } },
  { id: "electric-keys", name: "Electric Keys", role: "keyboards", midiProgram: 4, soundfont: { bankId: "gm", bank: 0, program: 4 } },
  { id: "electric-bass", name: "Electric Bass", role: "bass", midiProgram: 33, soundfont: { bankId: "gm", bank: 0, program: 33 } },
  { id: "modern-drum-kit", name: "Modern Drum Kit", role: "percussion", midiProgram: 0, soundfont: { bankId: "gm", bank: 128, program: 0, isDrum: true } },
] as const;

/**
 * Compact, canonical catalog text for early model prompts.  Keep the
 * membership authority in the orchestrator validators; this is grounding
 * context only, so advisers can mention a creative timbre without inventing
 * a playable track.
 */
export function playableInstrumentCatalogPrompt(): string {
  const catalog = PLAYABLE_INSTRUMENTS
    .map(({ name, role, midiProgram }) => `${name} (${role}, program ${midiProgram})`)
    .join("; ");
  return `Supported playable instrument catalog (name, role, General MIDI program): ${catalog}. Use only these names for track proposals. If a creative timbre reference is not in this catalog, keep it as prose only and explicitly map it to the closest supported catalog instrument, describing achievable technique, articulation, register, dynamics, and texture; never propose the unsupported timbre as a track.`;
}

function normalizeInstrument(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findPlayableInstrument(value: string | number): (typeof PLAYABLE_INSTRUMENTS)[number] | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return PLAYABLE_INSTRUMENTS.find((instrument) => instrument.midiProgram === value);
  }
  if (typeof value !== "string") return undefined;
  const normalized = normalizeInstrument(value);
  return PLAYABLE_INSTRUMENTS.find((instrument) =>
    normalizeInstrument(instrument.id) === normalized ||
    normalizeInstrument(instrument.name) === normalized ||
    ("aliases" in instrument && instrument.aliases.some((alias) => normalizeInstrument(alias) === normalized)),
  );
}

export type AgentGroup = keyof typeof SCORING_AGENTS;

export type AdviserSelection = {
  agent: string;
  group: "style" | "concept";
  question: string;
};

/**
 * The workflow deliberately chooses from this small read-only roster before
 * asking any track owner to write.  Instrument agents are not advisers: their
 * authority is established only by an assigned, existing track.
 */
export function defaultReadOnlyAdvisers(): AdviserSelection[] {
  return [
    {
      agent: "Contemporary Cinematic",
      group: "style",
      question: "Which original style, palette, and dynamics best serve the requested material?",
    },
    {
      agent: "Harmony & Voice Leading",
      group: "concept",
      question: "What concrete harmonic, melodic, and register choices serve the requested material?",
    },
  ];
}

export type TrackForAgent = {
  id: string;
  instrument: string;
  role: string;
};

/**
 * Agent names for instrument work are deliberately derived from the score.
 * A score may contain an instrument that is not part of the broad category
 * roster (for example, "Bass Clarinet"), so routing must never invent a
 * category agent or consult an instrument that is not on a real track.
 */
export function instrumentAgentForTrack(track: TrackForAgent): string | undefined {
  return findPlayableInstrument(track.instrument)?.name;
}

export function getInstrumentAgents(tracks: TrackForAgent[]): Array<{
  agent: string;
  trackId: string;
  group: "instrument";
}> {
  return tracks.flatMap((track) => {
    const agent = instrumentAgentForTrack(track);
    return agent ? [{
      agent,
      trackId: track.id,
      group: "instrument" as const,
    }] : [];
  });
}

export function getAgentRoster(tracks: TrackForAgent[] = []): string {
  const fixedAgents = Object.entries(SCORING_AGENTS)
    .filter(([group]) => group !== "instrument")
    .flatMap(([group, agents]) =>
      agents.map((agent) => `${agent} (${group})`),
    );
  const trackAgents = getInstrumentAgents(tracks)
    .map(({ agent, trackId }) => `${agent} (instrument, track ${trackId})`);
  return [...trackAgents, ...fixedAgents].join(", ");
}

/**
 * There are 60,000 milliseconds in a minute and one beat is one quarter note
 * at the snippet BPM. Keeping this conversion in the scoring library makes it
 * harder for an agent prompt or client to accidentally use the score tempo
 * instead of the source MIDI tempo.
 */
export function midiMillisecondsToBeats(milliseconds: number, bpm: number): number {
  if (!Number.isFinite(milliseconds) || !Number.isFinite(bpm) || bpm <= 0) {
    return 0;
  }
  return milliseconds * bpm / 60_000;
}

export type OrderedMidiSnippet = {
  id: string;
  tempo: number;
  durationMs: number;
  notes: Array<{
    note: number;
    velocity: number;
    startMs: number;
    durationMs: number;
  }>;
};

/**
 * Serialize every source event in order for each specialist/orchestrator.
 * This deliberately has no note-count or snippet-count slice.
 */
export function fullMidiMaterial(snippets: OrderedMidiSnippet[]): string {
  return JSON.stringify(snippets.map((snippet) => ({
    id: snippet.id,
    bpm: snippet.tempo,
    tempo: snippet.tempo,
    durationMs: snippet.durationMs,
    notes: snippet.notes.map((note) => ({
      pitch: note.note,
      note: note.note,
      velocity: note.velocity,
      startMs: note.startMs,
      durationMs: note.durationMs,
      startBeat: midiMillisecondsToBeats(note.startMs, snippet.tempo),
      durationBeats: midiMillisecondsToBeats(note.durationMs, snippet.tempo),
    })),
  })));
}

export const agentRoster = Object.entries(SCORING_AGENTS)
  .flatMap(([group, agents]) =>
    agents.map((agent) => `${agent} (${group})`),
  )
  .join(", ");

export function findAgentGroup(name: string, tracks: TrackForAgent[] = []): AgentGroup | undefined {
  if (getInstrumentAgents(tracks).some((track) => track.agent === name)) {
    return "instrument";
  }
  return (Object.keys(SCORING_AGENTS) as AgentGroup[]).find((group) =>
    group !== "instrument" &&
    SCORING_AGENTS[group].some((agent) => agent === name),
  );
}