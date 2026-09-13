import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

/**
 * These are database-backed regression tests. Keep them skippable for the
 * repository-wide unit-test command when a local PostgreSQL URL is not
 * provisioned; CI/development database runs exercise the real JSONB update.
 */
const isTsxRunner = process.execArgv.some((argument) => argument.includes("tsx/dist/"));
const isNativeStripTypesRunner = !isTsxRunner && process.features.typescript === "strip";

if (!process.env.DATABASE_URL || isNativeStripTypesRunner) {
  test("terminal audit database persistence", {
    skip: !process.env.DATABASE_URL
      ? "DATABASE_URL is not configured"
      : "Run with scripts/node_modules/.bin/tsx --test for database-backed tests",
  }, () => {});
} else {
  const { and, eq } = await import("drizzle-orm");
  const { db, pool, projectsTable } = await import("@workspace/db");
  const {
    MAX_TERMINAL_AUDITS,
    persistTerminalAudit,
    preserveLatestTerminalAudits,
    projectBelongsToOwner,
  } = await import("./terminal-audit.ts");

  const score = {
    tempo: 96,
    durationBeats: 16,
    tracks: [{
      id: "track-piano",
      name: "Piano",
      instrument: "Piano",
      role: "harmony",
      midiProgram: 0,
      regions: [{
        id: "region-original",
        name: "Original",
        startBeat: 0,
        durationBeats: 4,
        notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1 }],
      }],
    }],
  };

  function documentWith(audits: unknown[] = [], nextScore = score) {
    return {
      score: nextScore,
      scoreRevision: 3,
      messages: [],
      undoStack: [],
      terminalAudits: audits,
    };
  }

  function audit(index: number) {
    return {
      workflowId: `workflow-${index}`,
      requestId: `request-${index}`,
      reason: `The candidate did not satisfy the requested constraint (${index}).`,
      evidence: [`Measured safe evidence for candidate ${index}.`],
      evaluatorCategory: "musical-rejection" as const,
      affectedScope: [`track:track-piano`, `task:${index}`],
      expected: "A playable musical change in the requested scope.",
      observed: "The compared candidate did not satisfy the requested scope.",
      candidateRevision: `candidate-${index}`,
      correctionOutcome: "not-attempted",
      commitStatus: "not-committed" as const,
    };
  }

  async function createProject() {
    const id = randomUUID();
    const ownerId = `terminal-audit-owner-${randomUUID()}`;
    await db.insert(projectsTable).values({
      id,
      ownerId,
      name: "Terminal audit regression fixture",
      version: 7,
      document: documentWith(),
    });
    return { id, ownerId };
  }

  async function readProject(id: string, ownerId: string) {
    const [project] = await db.select().from(projectsTable).where(and(
      eq(projectsTable.id, id),
      eq(projectsTable.ownerId, ownerId),
    )).limit(1);
    assert.ok(project, "regression fixture should still exist");
    return project;
  }

  async function removeProject(id: string, ownerId: string) {
    await db.delete(projectsTable).where(and(
      eq(projectsTable.id, id),
      eq(projectsTable.ownerId, ownerId),
    ));
  }

  test("appends and reloads a terminal audit without changing score or project version", async () => {
    const fixture = await createProject();
    try {
      const before = await readProject(fixture.id, fixture.ownerId);
      const fullCause = audit(1);
      fullCause.reason = "r".repeat(2_000);
      fullCause.evidence = ["e".repeat(1_000)];
      fullCause.expected = "x".repeat(2_000);
      fullCause.observed = "o".repeat(2_000);
      const unsafeAudit = {
        ...fullCause,
        rawResponse: "provider response must never be persisted",
        prompt: "provider prompt must never be persisted",
        midi: [{ pitch: 60 }],
        credentials: "secret",
      };

      assert.equal(await projectBelongsToOwner(fixture.ownerId, fixture.id), true);
      assert.equal(await persistTerminalAudit(fixture.ownerId, fixture.id, unsafeAudit), true);

      // Read through a new SELECT, rather than relying on the UPDATE result,
      // to cover reload behavior from the persisted JSONB document.
      const after = await readProject(fixture.id, fixture.ownerId);
      const persisted = after.document as Record<string, unknown>;
      assert.deepEqual(persisted.score, before.document && (before.document as Record<string, unknown>).score);
      assert.equal(after.version, before.version);
      assert.deepEqual(persisted.terminalAudits, [fullCause]);
      assert.equal((persisted.terminalAudits as Array<Record<string, unknown>>)[0]?.reason.length, 2_000);
      assert.equal((persisted.terminalAudits as Array<Record<string, unknown>>)[0]?.evidence[0].length, 1_000);
      assert.equal((persisted.terminalAudits as Array<Record<string, unknown>>)[0]?.expected.length, 2_000);
      assert.equal((persisted.terminalAudits as Array<Record<string, unknown>>)[0]?.observed.length, 2_000);
    } finally {
      await removeProject(fixture.id, fixture.ownerId);
    }
  });

  test("bounds concurrent-safe append history and preserves it through a stale PATCH document", async () => {
    const fixture = await createProject();
    try {
      // Sequential appends make eviction order deterministic while each call
      // still exercises the single-statement, owner-scoped JSONB update.
      for (let index = 1; index <= MAX_TERMINAL_AUDITS + 1; index += 1) {
        assert.equal(await persistTerminalAudit(fixture.ownerId, fixture.id, audit(index)), true);
      }

      const afterAudits = await readProject(fixture.id, fixture.ownerId);
      const persistedAudits = (afterAudits.document as Record<string, unknown>).terminalAudits as Array<Record<string, unknown>>;
      assert.equal(persistedAudits.length, MAX_TERMINAL_AUDITS);
      assert.equal(persistedAudits[0]?.workflowId, "workflow-2");
      assert.equal(persistedAudits.at(-1)?.workflowId, `workflow-${MAX_TERMINAL_AUDITS + 1}`);
      assert.deepEqual(
        (afterAudits.document as Record<string, unknown>).score,
        score,
        "an audit append must not mutate score",
      );
      assert.equal(afterAudits.version, 7, "an audit append must not mutate project version");

      // Model the stale document body a client would send after it missed the
      // audit response. The server-side PATCH expression must take the latest
      // row audits, not this stale empty array.
      const staleScore = { ...score, tempo: 120 };
      const staleDocument = documentWith([], staleScore);
      const [patched] = await db.update(projectsTable).set({
        document: preserveLatestTerminalAudits(staleDocument),
        version: afterAudits.version + 1,
      }).where(and(
        eq(projectsTable.id, fixture.id),
        eq(projectsTable.ownerId, fixture.ownerId),
        eq(projectsTable.version, afterAudits.version),
      )).returning();
      assert.ok(patched);

      const reloaded = await readProject(fixture.id, fixture.ownerId);
      const reloadedDocument = reloaded.document as Record<string, unknown>;
      assert.deepEqual(reloadedDocument.score, staleScore, "the ordinary PATCH score remains writable");
      assert.deepEqual(reloadedDocument.terminalAudits, persistedAudits, "stale PATCH must preserve server audits");
      assert.equal(reloaded.version, afterAudits.version + 1);
    } finally {
      await removeProject(fixture.id, fixture.ownerId);
    }
  });

  // A node-postgres pool keeps idle handles alive after the tests finish.
  // Close it explicitly so the standalone tsx command exits cleanly.
  test.after(async () => {
    await pool.end();
  });
}