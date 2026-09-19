import { screenMusicText } from "./ai-music-safety.ts";
import { playableInstrumentCatalogPrompt } from "./scoring-agents.ts";

export function styleSuggestionSystemPrompt(): string {
  return `You are the style specialist. Return JSON only: {"response":"...","styleSuggestions":[{"id":"...","name":"...","description":"...","agent":"..."}]}. Offer up to three distinct original musical directions relevant to the request, not differently described copies of the same option. Each must have a unique concise sentence-case name describing neutral musical attributes (for example Intimate piano or Rhythmic strings), a distinct description, and a unique id. Respect explicitly requested instrumentation and mood. Do not use title case, creator names, work titles, create tracks, or score operations. ${playableInstrumentCatalogPrompt()}`;
}

const musicalLabelWords = new Set(
  "original intimate reflective piano minimal minimalist ambient melancholy orchestral lyrical sparse warm rhythmic bright dark tense percussive sweeping brass woodwind delicate modern cinematic strings string electronic acoustic dramatic romantic classical jazz folk hybrid atmospheric sustained pulsing gentle energetic spacious chamber solo ensemble texture harmony rhythm melodic melody soft bold playful haunting tender lush restrained meditative wistful hopeful mysterious suspenseful driving evolving calm expressive waltz flowing quiet nocturnal tonal modal dissonant consonant counterpoint and with for".split(" "),
);
const STYLE_NAME_MAX_LENGTH = 600;

type StyleSuggestion = { id: string; name: string; description: string; agent: string };

/** Keep musical title case without exempting arbitrary proper names from screening. */
function safeLabel(value: string): string {
  const words = value.trim().toLowerCase().split(/[\s-]+/);
  const neutral = words.length > 0 && words.every((word) => musicalLabelWords.has(word));
  const sentenceCase = neutral
    ? value.trim().toLowerCase().replace(/^./, (letter) => letter.toUpperCase())
    : value;
  return screenMusicText(sentenceCase, "");
}

function boundedName(value: string): string {
  return value.length <= STYLE_NAME_MAX_LENGTH
    ? value
    : value.slice(0, STYLE_NAME_MAX_LENGTH).trimEnd();
}

export function normalizeStyleSuggestions(value: unknown): StyleSuggestion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) {
    throw new Error("Style selection returned malformed options; no score change was made.");
  }
  const names = new Set<string>();
  const descriptions = new Set<string>();
  const styles: StyleSuggestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Style selection returned a malformed option.");
    const style = item as Record<string, unknown>;
    if (typeof style.name !== "string" || !style.name.trim() ||
        typeof style.description !== "string" || !style.description.trim()) {
      throw new Error("Style selection returned a malformed option.");
    }
    const description = screenMusicText(style.description, "An original score direction.");
    const descriptionKey = description.normalize("NFKC").toLowerCase();
    // Identical screened options are not separate choices.
    if (descriptions.has(descriptionKey)) continue;
    descriptions.add(descriptionKey);
    const safeName = safeLabel(style.name);
    const descriptor = description.split(/[.!?;:]/)[0].split(/\s+/).slice(0, 9).join(" ");
    // Keep the response label within its generated contract. The complete
    // description remains the source of truth and is never shortened here.
    let name = safeName.length <= STYLE_NAME_MAX_LENGTH
      ? safeName
      : boundedName(descriptor) || "Original scoring direction";
    name = name || boundedName(descriptor) || "Original scoring direction";
    if (names.has(name.normalize("NFKC").toLowerCase())) {
      name = boundedName(`${name} — ${descriptor}`) || "Original scoring direction";
    }
    const baseName = name;
    let suffix = 2;
    while (names.has(name.normalize("NFKC").toLowerCase())) {
      const suffixText = ` (${suffix++})`;
      name = `${baseName.slice(0, STYLE_NAME_MAX_LENGTH - suffixText.length).trimEnd()}${suffixText}`;
    }
    names.add(name.normalize("NFKC").toLowerCase());
    styles.push({
      id: `style-${styles.length + 1}`,
      name,
      description,
      agent: screenMusicText(typeof style.agent === "string" ? style.agent : "", "Style specialist"),
    });
  }
  return styles;
}