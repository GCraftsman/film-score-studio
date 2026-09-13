import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canReuseAudioId } from "./audio-ownership.ts";

describe("project audio ownership", () => {
  it("allows an id to be retried only for the same owner and project", () => {
    assert.equal(canReuseAudioId(undefined, "user_a", "project_a"), true);
    assert.equal(canReuseAudioId({ ownerId: "user_a", projectId: "project_a" }, "user_a", "project_a"), true);
  });

  it("rejects a cross-user or cross-project id collision", () => {
    assert.equal(canReuseAudioId({ ownerId: "user_a", projectId: "project_a" }, "user_b", "project_a"), false);
    assert.equal(canReuseAudioId({ ownerId: "user_a", projectId: "project_a" }, "user_a", "project_b"), false);
  });
});