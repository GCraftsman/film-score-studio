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