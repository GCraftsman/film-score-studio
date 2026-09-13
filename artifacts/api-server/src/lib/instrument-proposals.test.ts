import assert from "node:assert/strict";
import { test } from "node:test";
import { reuseExistingInstruments } from "./instrument-proposals.ts";

test("saved legacy Piano is reused for a canonical piano proposal", () => {
  assert.deepEqual(reuseExistingInstruments([{ id: "saved", instrument: "Piano" }], [
    { id: "proposal", action: "add", instrument: "Upright Piano" },
  ]), []);
});

test("new instruments remain pending and repeated additions are deduplicated", () => {
  const proposal = { id: "one", action: "add", instrument: "Upright Piano" };
  assert.deepEqual(reuseExistingInstruments([], [proposal, { ...proposal, id: "two" }]), [proposal]);
});

test("ambiguous proposal IDs and deletion targets fail closed", () => {
  const proposal = { id: "one", action: "delete", trackId: "saved", instrument: "Piano" };
  assert.throws(() => reuseExistingInstruments([], [proposal, proposal]), /duplicate proposal/);
  assert.throws(() => reuseExistingInstruments([], [proposal, { ...proposal, id: "two" }]), /delete targets/);
});