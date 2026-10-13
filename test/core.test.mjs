import test from "node:test";
import assert from "node:assert/strict";
import { TicketEnvironment, runDemo } from "../src/index.ts";
test("seeded workflow is deterministic and records history", () => {
  assert.deepEqual(runDemo(), runDemo());
  assert.equal(runDemo().tickets[0].status, "closed");
});
test("idempotency deduplicates, but rejects changed payload", () => {
  const e = new TicketEnvironment();
  assert.deepEqual(e.create("alice", "x", "k"), e.create("alice", "x", "k"));
  assert.equal(e.snapshot().tickets.length, 1);
  assert.throws(() => e.create("alice", "y", "k"), /different input/);
});
test("actor isolation and unauthorized mutations", () => {
  const e = new TicketEnvironment({ alice: "member", bob: "member" });
  const t = e.create("alice", "private");
  assert.deepEqual(e.list("bob"), []);
  assert.throws(() => e.transition("bob", t.id, "closed", 1), /cannot access/);
});
test("concurrency and closed-state invariants", () => {
  const e = new TicketEnvironment();
  const t = e.create("alice", "x");
  e.transition("alice", t.id, "in_progress", 1);
  assert.throws(() => e.transition("alice", t.id, "closed", 1), /Stale/);
  e.transition("alice", t.id, "closed", 2);
  assert.throws(() => e.transition("alice", t.id, "open", 3), /Unsupported/);
});
test("snapshots and returns do not leak mutable state", () => {
  const e = new TicketEnvironment();
  const t = e.create("alice", "x");
  t.title = "bad";
  const s = e.snapshot();
  s.tickets[0].title = "bad";
  assert.equal(e.list("alice")[0].title, "x");
});
test("environments are isolated", () => {
  const a = new TicketEnvironment(),
    b = new TicketEnvironment();
  a.create("alice", "x");
  assert.equal(b.list("alice").length, 0);
});
