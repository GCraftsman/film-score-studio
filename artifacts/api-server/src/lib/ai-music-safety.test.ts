import assert from "node:assert/strict";
import test from "node:test";
import {
  SAFE_ORIGINAL_CUE_FALLBACK,
  normalizeMusicDirection,
  screenMusicText,
} from "./ai-music-safety.ts";

test("normalizes named-reference imitation directions without repeating the reference", () => {
  const result = normalizeMusicDirection("Make it sound like a famous composer");
  assert.equal(result, SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(result.includes("famous"), false);
});

test("normalizes quoted titles and multi-word proper names", () => {
  assert.equal(normalizeMusicDirection('Use "a famous song"'), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(normalizeMusicDirection("Use Famous Person's theme"), SAFE_ORIGINAL_CUE_FALLBACK);
});

test("accepts the captured review without treating possessives as quotation boundaries", () => {
  const review = "The candidate's rising chromatic drive style at 97 BPM with violin/cello motif, low percussion, layered flute/brass, increasing syncopation, chromatic movement, ascending scales, and dynamic growth to fortissimo aligns closely with the requested original chase cue. It effectively serves the 64-bar build by starting sparse and staccato in mid-register, adding rhythmic density, harmonic tension, percussive textures, and orchestration every 8-16 bars with rising register, faster subdivisions, brass/synth stabs, and escalating drums for continuous suspense and momentum without early resolution. The provided score uses only permitted broad attributes (instrumentation, tempo, harmony, register, texture, dynamics, technique, mood). Minor refinement opportunity: ensure the final bars introduce a clear unresolved tension peak rather than any implied cadence to fully match 'without resolving until the final bars.'";
  assert.equal(review.length, 917);
  assert.equal(screenMusicText(review, ""), review);
  assert.equal(screenMusicText(review.replaceAll("'", "’").replace("’without", "‘without"), ""), review.replaceAll("'", "’").replace("’without", "‘without"));
  const possessives = "The candidate's rhythm supports the melody's rising register.";
  assert.equal(screenMusicText(possessives, ""), possessives);
});

test("quote boundary repair retains title and named-reference protections", () => {
  for (const value of [
    "Use 'a famous song'", "Use ‘a famous song’", 'Use “a famous song”',
    "The candidate's rhythm recalls 'a famous song'.",
    "Use 'a composer's song'.",
    "Use 'without resolving until the final bars of Inception'.",
  ]) {
    assert.equal(screenMusicText(value), SAFE_ORIGINAL_CUE_FALLBACK);
    assert.equal(normalizeMusicDirection(value), SAFE_ORIGINAL_CUE_FALLBACK);
  }
});

test("blocks the observed phonetic name typo at input and egress, including sentence start", () => {
  assert.equal(normalizeMusicDirection("please write hans simmer material"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("Hans simmer is the target"), SAFE_ORIGINAL_CUE_FALLBACK);
});

test("blocks lowercase misspellings and invented named references in imitation framing", () => {
  const cases = [
    "make it sound like beethovn's moonlite sonata",
    "write this in the style of zorbyn kalex",
    "copy the theme from night engines by mira vell",
  ];

  for (const input of cases) {
    const normalized = normalizeMusicDirection(input).toLowerCase();
    assert.equal(normalized, SAFE_ORIGINAL_CUE_FALLBACK.toLowerCase());
    assert.doesNotMatch(normalized, /beethovn|moonlite|zorbyn|kalex|night engines|mira vell/);
  }
});

test("keeps ordinary broad musical directions and roster terms", () => {
  assert.equal(normalizeMusicDirection("Add low Strings at 92 BPM with a minor ostinato"), "Add low Strings at 92 BPM with a minor ostinato");
});

test("screens unsafe model egress with a generic fallback", () => {
  assert.equal(screenMusicText("This resembles Famous Composer"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("Use quiet strings and low brass"), "Use quiet strings and low brass");
});

test("keeps Voice Leading in focused musical advice without weakening name checks", () => {
  for (const advice of [
    "Use Voice Leading to keep the inner parts smooth and the cadence restrained.",
    "Voice Leading should favor contrary motion between the upper voices.",
  ]) {
    assert.equal(screenMusicText(advice), advice);
    assert.equal(normalizeMusicDirection(advice), advice);
  }
  assert.equal(screenMusicText("This resembles Famous Composer"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("Voice Leading in Madonna influence"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("The Voice Leading reference"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(normalizeMusicDirection("The Voice Leading reference"), SAFE_ORIGINAL_CUE_FALLBACK);
});

test("keeps the live 505-character orchestral adviser insight after egress screening", () => {
  const insight = "Heroic orchestral build at 80 BPM: Start sparse with high-register violin and flute carrying the melody over alternating major/minor triads on upright piano and cello. Gradually layer in French horn and trombone for richer mid-register harmonies, add string ensemble for sustained texture, then introduce timpani and modern drum kit for rhythmic drive. Build rising register, denser voicings, and dynamics from piano to fortissimo across 64 bars, culminating in full ensemble grandeur and victorious mood.";
  assert.equal(insight.length, 505);
  assert.equal(screenMusicText(insight, ""), insight);
});

test("keeps the captured 721-character adviser insight after egress screening", () => {
  const insight = "Heroic orchestral build at 80 BPM: Start sparse with high-register violin and flute carrying the melody over alternating major/minor triads on upright piano and cello. Gradually layer in French horn and trombone for richer mid-register harmonies, add string ensemble for sustained texture, then introduce timpani and modern drum kit for rhythmic drive. Build rising register, denser voicings, and dynamics from piano to fortissimo across 64 bars, culminating in full ensemble grandeur and victorious mood. Voice Leading remains clear through each transition: keep soprano motion stepwise, let inner voices move by small intervals, reserve wider leaps for phrase boundaries, and shape each cadence with controlled release.";
  assert.equal(insight.length, 721);
  assert.equal(screenMusicText(insight, ""), insight);
});

test("does not treat a colon as a blanket sentence-start exemption", () => {
  assert.equal(screenMusicText("Use quiet strings: Inception mood"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("Direction: Madonna influence"), SAFE_ORIGINAL_CUE_FALLBACK);
});

test("keeps exact catalog and bounded creative timbres in natural musical prose", () => {
  for (const advice of [
    "Gradually layer in French horn and trombone for richer mid-register harmonies.",
    "Use upright piano, glass marimba, and modern drum kit for a spacious texture.",
    "The line should begin with bass clarinet color and resolve through cello.",
  ]) {
    assert.equal(screenMusicText(advice), advice);
  }
});

test("keeps catalog timbre references when they are explicitly mapped", () => {
  const advice = "Use Bass Clarinet mapped to Cello with low register, restrained dynamics, and a breathy texture.";
  assert.equal(screenMusicText(advice), advice);
  assert.equal(normalizeMusicDirection(advice), advice);
});

test("keeps connector-list and descriptive mapped instrument advice", () => {
  for (const connectorAdvice of [
    "Use Cello with Violin and Trombone in a high register.",
    "Use Cello, Violin, and Trombone in a high register.",
  ]) {
    assert.equal(screenMusicText(connectorAdvice), connectorAdvice);
    assert.equal(normalizeMusicDirection(connectorAdvice), connectorAdvice);
  }

  const descriptiveAdvice = "Use Bass Clarinet as a creative timbre mapped to Cello with low register and restrained dynamics.";
  assert.equal(screenMusicText(descriptiveAdvice), descriptiveAdvice);
  assert.equal(normalizeMusicDirection(descriptiveAdvice), descriptiveAdvice);
});

test("screens article-title-like catalog phrases rather than bypassing proper-name detection", () => {
  assert.equal(screenMusicText("The Piano reference"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(normalizeMusicDirection("The Piano reference"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("Use Cello with Piano Red score"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(normalizeMusicDirection("Use Cello with Piano Red score"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(screenMusicText("Grand Piano score"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(normalizeMusicDirection("Grand Piano: use suspense"), SAFE_ORIGINAL_CUE_FALLBACK);
  assert.equal(
    screenMusicText("Use Cello mapped to Violin; Grand Piano score"),
    SAFE_ORIGINAL_CUE_FALLBACK,
  );
  assert.equal(
    screenMusicText("Use Cello mapped to Violin. Piano Red score"),
    SAFE_ORIGINAL_CUE_FALLBACK,
  );
});