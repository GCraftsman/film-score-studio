import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectDraftDisposition,
  shouldApplyRemoteWorkspaceSnapshot,
  workspaceStorageKeys,
} from "./project-manager.ts";

describe("project workspace persistence", () => {
  it("does not remount D1 when a D0 save response updates the query cache", () => {
    assert.equal(shouldApplyRemoteWorkspaceSnapshot({
      currentLoadKey: "project-1:1",
      nextLoadKey: "project-1:2",
      localFingerprint: "D1",
      baselineFingerprint: "D0",
      saveInFlight: true,
    }), false);
  });

  it("accepts a newer remote snapshot only after local edits are settled", () => {
    assert.equal(shouldApplyRemoteWorkspaceSnapshot({
      currentLoadKey: "project-1:1",
      nextLoadKey: "project-1:2",
      localFingerprint: "D0",
      baselineFingerprint: "D0",
      saveInFlight: false,
    }), true);
  });

  it("partitions authenticated project and recovery keys by Clerk user", () => {
    const alice = workspaceStorageKeys("user_alice");
    const bob = workspaceStorageKeys("user_bob");
    assert.notEqual(alice.document, bob.document);
    assert.notEqual(alice.extras, bob.extras);
    assert.notEqual(alice.recovery, bob.recovery);
    assert.equal(alice.authenticated, true);
    assert.equal(workspaceStorageKeys().authenticated, false);
  });

  it("restores only a draft for the reopened project and matching server revision", () => {
    const draft = {
      projectId: "project-a",
      baseVersion: 3,
      updatedAt: new Date(0).toISOString(),
      document: {
        score: {},
        scoreRevision: 1,
        messages: [],
        undoStack: [],
        onboarding: {},
        pendingProposals: [],
      },
    };
    assert.equal(projectDraftDisposition(draft, "project-a", 3), "restore");
    assert.equal(projectDraftDisposition(draft, "project-b", 3), "none");
    assert.equal(projectDraftDisposition(draft, "project-a", 4), "offer");
  });
});