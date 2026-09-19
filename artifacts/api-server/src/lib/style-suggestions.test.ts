import assert from "node:assert/strict";
import test from "node:test";
import { ComposeWithOrchestratorResponse } from "../../../../lib/api-zod/src/generated/api.ts";
import { normalizeStyleSuggestions, styleSuggestionSystemPrompt } from "./style-suggestions.ts";

test("style suggestions are grounded in the playable catalog and timbre mapping rule", () => {
  const prompt = styleSuggestionSystemPrompt();
  assert.match(prompt, /Upright Piano \(keyboards, program 0\)/);
  assert.match(prompt, /Violin \(strings, program 40\)/);
  assert.match(prompt, /explicitly map it to the closest supported catalog instrument/);
  assert.match(prompt, /achievable technique, articulation, register, dynamics, and texture/);
});

test("neutral musical title-case names remain distinct rather than sharing a safety fallback", () => {
  const styles = normalizeStyleSuggestions([
    { id: "same", name: "Intimate Piano", description: "Sparse piano with warm harmony." },
    { id: "same", name: "Rhythmic Strings", description: "Pulsing strings with gentle counterpoint." },
  ]);
  assert.deepEqual(styles.map((style) => style.name), ["Intimate piano", "Rhythmic strings"]);
  assert.equal(new Set(styles.map((style) => style.id)).size, 2);
});

test("duplicate labels retain distinct descriptions and unique selection names", () => {
  const styles = normalizeStyleSuggestions([
    { name: "Ambient", description: "Sparse piano with slow harmony." },
    { name: "Ambient", description: "Soft strings with evolving harmony." },
    { name: "Ambient", description: "Soft strings with evolving harmony." },
  ]);
  assert.equal(styles.length, 2);
  assert.notEqual(styles[0].name, styles[1].name);
  assert.match(styles[1].name, /Soft strings/);
});

test("proper-name labels remain screened and fall back to neutral descriptions", () => {
  const [style] = normalizeStyleSuggestions([
    { name: "Hans Zimmer", description: "Soft brass with restrained harmony." },
  ]);
  assert.equal(style.name, "Soft brass with restrained harmony");
  assert.throws(() => normalizeStyleSuggestions([]));
});

test("bounded labels still parse as a response without shortening the musical description", () => {
  const description = "Sparse single-line tune with occasional harmonic support, using gentle dynamics and a slow tempo to evoke calm introspection.";
  const [style] = normalizeStyleSuggestions([{
    name: "Minimal melody ".repeat(20),
    description,
    agent: "Style specialist",
  }]);
  const response = ComposeWithOrchestratorResponse.safeParse({
    response: "Choose a scoring style.",
    workflow: "style-intake",
    selectedStyle: `${style.name}: ${style.description}`,
    styleSuggestions: [style],
    trackProposals: [],
    consultations: [],
    usageGuard: "bounded",
    operations: [],
  });
  assert.equal(response.success, true);
  assert.ok(style.name.length <= 600);
  assert.equal(style.description, description);
});