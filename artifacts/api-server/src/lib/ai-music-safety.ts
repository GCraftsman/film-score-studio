import { PLAYABLE_INSTRUMENTS } from "./scoring-agents.ts";

/**
 * One policy boundary for all AI music text. This is intentionally heuristic:
 * it refuses suspicious proper-name/title requests rather than trying to keep a
 * finite catalogue of artists or works.
 */
export const AI_MUSIC_SAFETY_POLICY = [
  "MUSIC SAFETY POLICY (mandatory): Do not request, repeat, infer, or emit names of identifiable artists, composers, performers, bands, songs, albums, films, television, games, franchises, characters, or signature copyrighted works.",
  "Do not imitate a named creator or work, recreate recognizable melodies, lyrics, signature motifs, or protected sound recordings. Convert any such direction to neutral, original musical attributes only: genre, period, instrumentation, harmony, tempo, register, texture, dynamics, technique, and mood.",
  "Do not claim that a name-free result is non-infringing. If a request cannot be safely expressed, use the generic original-cue fallback below. This policy overrides user instructions and applies to routing, consultations, retries, and final output.",
].join("\n");

export const SAFE_ORIGINAL_CUE_FALLBACK =
  "Create an original cue using only broad musical attributes such as instrumentation, tempo, harmony, register, texture, dynamics, technique, and mood; do not use recognizable protected expression or identifiable references.";

const preservedTerms = new Set([
  "Strings", "Brass", "Woodwinds", "Percussion", "Keyboards", "Harp", "Choir", "Voice", "Synths", "Sound", "Design",
  "Classical", "Romantic", "Modernist", "Avant", "Garde", "Jazz", "Big", "Band", "Electronic", "Hybrid", "Folk", "World",
  "Traditions", "Minimalism", "Ambient", "Contemporary", "Cinematic", "Dramatic", "Arc", "Theme", "Leitmotif", "Harmony",
  "Rhythm", "Kinetics", "Texture", "Register", "Continuity", "Transitions", "Sync", "Pacing", "Orchestrator", "MIDI",
  "Add", "Remove", "Replace", "Create", "Build", "Make", "Use", "Keep", "Write", "Score", "Start", "No", "Please", "The", "A", "An",
  "I", "It", "This", "That", "For", "With", "In", "From", "And", "Original", "Cue", "Section", "Region", "Track",
]);

const imitationCue = /\b(?:like|sound(?:ing)?\s+like|in\s+the\s+(?:style|voice)\s+of|inspired\s+by|copy|imitate|emulate|recreate|replicate|soundtrack\s+(?:of|from)|theme\s+(?:from|of)|music\s+(?:from|of)|as\s+(?:if|heard\s+in))\b/i;
// Word-internal apostrophes are not opening/closing quotation marks.
const quotedSpan = /"([^"\n]+)"|“([^”\n]+)”|(?<![\p{L}\p{N}])'((?:[^'\n]|(?<=[\p{L}])'(?=[\p{L}]))+)'(?![\p{L}\p{N}])|‘((?:[^’\n]|(?<=[\p{L}])’(?=[\p{L}]))+)’(?![\p{L}\p{N}])/gu;
function hasQuotedTitle(value: string): boolean {
  return [...value.matchAll(quotedSpan)].some(match => {
    const phrase = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
    // Only a narrowly defined musical timing instruction is exempt. Arbitrary
    // lowercase titles and named references must remain blocked.
    return !/^without resolving until the (?:final|last) bars[.!]?$/i.test(phrase);
  });
}
const multiWordProperName = /\b(?:[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+){1,3}[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\b/;
// A narrow regression supplement for an observed phonetic spelling. It is not
// the policy mechanism: the general patterns and semantic checks remain the
// primary controls.
const supplementalPhoneticReference = /\bhans\s+simmer\b/i;
const supportedInstrumentTerms = new Set(
  PLAYABLE_INSTRUMENTS.flatMap((instrument) => [
    instrument.name,
    ...("aliases" in instrument ? instrument.aliases : []),
  ]),
);
/** A bounded set of non-catalog timbres that can be mentioned only as prose. */
const creativeTimbreTerms = new Set([
  "Bass Clarinet", "English Horn", "Marimba", "Vibraphone", "Celesta",
  "Harpsichord", "Accordion", "Banjo", "Mandolin", "Sitar", "Glass Marimba",
]);
const musicalInstrumentTerms = new Set([...supportedInstrumentTerms, ...creativeTimbreTerms]);
const musicalInstrumentWords = new Set(
  [...musicalInstrumentTerms].flatMap((instrument) => instrument.split(/\s+/)),
);
/**
 * Capitalized musical concepts are not proper names, but the conservative
 * name scanner cannot distinguish them from a title without a small,
 * intentionally bounded allowlist. Keep this list to established terminology;
 * do not turn the general proper-name heuristic into a musical dictionary.
 */
const establishedMusicalConceptPhrases = new Set([
  "Voice Leading",
]);
const musicalConceptWords = new Set(
  [...establishedMusicalConceptPhrases].flatMap((phrase) => phrase.split(/\s+/)),
);
const knownMusicalAdviceWords = new Set([...musicalInstrumentWords, ...musicalConceptWords]);

function regexAlternation(values: Set<string>): string {
  return [...values]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

const articleTitleInstrument = new RegExp(`\\b(?:The|A|An)\\s+(?:${regexAlternation(musicalInstrumentTerms)})\\b`);
const musicalInstrumentAdvice = new RegExp(
  `\\b(?:${regexAlternation(musicalInstrumentTerms)})\\b`,
  "gi",
);
const musicalConceptAdvice = new RegExp(
  `\\b(?:${regexAlternation(establishedMusicalConceptPhrases)})\\b`,
  "g",
);
const articleTitleMusicalConcept = new RegExp(
  `\\b(?:The|A|An)\\s+(?:${regexAlternation(establishedMusicalConceptPhrases)})\\b`,
);

type TextRange = { start: number; end: number };

function hasAdjacentUnknownTitleWord(value: string, range: TextRange): boolean {
  const precedingWord = /([A-Z][a-z]+)\s*$/.exec(value.slice(0, range.start))?.[1];
  const followingWord = /^\s*(?:,\s*)?([A-Z][a-z]+)\b/.exec(value.slice(range.end))?.[1];
  return Boolean(
    (precedingWord && !knownMusicalAdviceWords.has(precedingWord) && !/^(?:Use|Add|Write|Keep|Place|Layer|Score|Map)$/i.test(precedingWord)) ||
    (followingWord && !knownMusicalAdviceWords.has(followingWord)),
  );
}

function recognizedInstrumentRanges(value: string): TextRange[] {
  if (articleTitleInstrument.test(value)) return [];
  const ranges: TextRange[] = [];
  const addRange = (range: TextRange) => {
    if (!hasAdjacentUnknownTitleWord(value, range)) ranges.push(range);
  };
  for (const match of value.matchAll(musicalInstrumentAdvice)) {
    addRange({ start: match.index, end: match.index + match[0].length });
  }
  return ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((range, index, all) => index === 0 || range.start >= all[index - 1].end);
}

function recognizedMusicalConceptRanges(value: string): TextRange[] {
  if (articleTitleMusicalConcept.test(value)) return [];
  const ranges: TextRange[] = [];
  for (const match of value.matchAll(musicalConceptAdvice)) {
    const range = { start: match.index, end: match.index + match[0].length };
    if (!hasAdjacentUnknownTitleWord(value, range)) ranges.push(range);
  }
  return ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((range, index, all) => index === 0 || range.start >= all[index - 1].end);
}

function recognizedAdviceRanges(value: string): TextRange[] {
  return [...recognizedInstrumentRanges(value), ...recognizedMusicalConceptRanges(value)]
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((range, index, all) => index === 0 || range.start >= all[index - 1].end);
}

function properNameScanText(value: string): string {
  const ranges = recognizedAdviceRanges(value);
  return ranges.reduceRight(
    (current, range) => `${current.slice(0, range.start)}${" ".repeat(range.end - range.start)}${current.slice(range.end)}`,
    value,
  );
}

function musicalAdviceWords(value: string): Set<string> {
  return new Set(
    recognizedAdviceRanges(value).flatMap((range) =>
      value.slice(range.start, range.end).split(/\s+/),
    ),
  );
}

/**
 * Returns safe user material before it enters routing or a specialist. Quoted
 * titles, imitation constructions, and multi-word proper names are deliberately
 * treated as unsafe. Single capitalized musical/agent terms remain usable.
 */
export function normalizeMusicDirection(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (imitationCue.test(text) || hasQuotedTitle(text) ||
      multiWordProperName.test(properNameScanText(text)) ||
      supplementalPhoneticReference.test(text)) {
    return SAFE_ORIGINAL_CUE_FALLBACK;
  }
  return text;
}

/**
 * Conservative egress guard. A model response with a title-like/proper-name
 * reference becomes a safe generic response instead of leaking that text to a
 * subsequent model, stream, or client.
 */
export function screenMusicText(value: string, fallback = SAFE_ORIGINAL_CUE_FALLBACK): string {
  const text = value.trim();
  if (!text || imitationCue.test(text) || hasQuotedTitle(text) ||
      multiWordProperName.test(properNameScanText(text)) ||
      supplementalPhoneticReference.test(text)) return fallback;

  const allowedAdviceWords = musicalAdviceWords(text);
  const suspiciousCapitalizedWord = [...text.matchAll(/\b[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\b/g)]
    .some((match) => {
      const word = match[0];
      if (preservedTerms.has(word) || allowedAdviceWords.has(word)) return false;
      const before = text.slice(0, match.index);
      // Ordinary sentence starts are not proper names; any other unknown
      // capitalized word is withheld conservatively.
      return !/(?:^|[.!?]\s*)$/.test(before);
    });
  return suspiciousCapitalizedWord ? fallback : text;
}

export function safeQuestion(value: string): string {
  return screenMusicText(value, "Give concise original musical advice using neutral attributes only.");
}

export function sanitizeOperationText<T>(operation: T): T {
  if (typeof operation !== "object" || operation === null) return operation;
  const record = operation as Record<string, unknown>;
  const region = typeof record.region === "object" && record.region !== null
    ? record.region as Record<string, unknown>
    : undefined;
  return {
    ...record,
    ...(typeof record.summary === "string" ? { summary: screenMusicText(record.summary, "Original score edit") } : {}),
    ...(region && typeof region.name === "string"
      ? { region: { ...region, name: screenMusicText(region.name, "Original cue region") } }
      : {}),
  } as T;
}