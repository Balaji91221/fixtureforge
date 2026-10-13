# FixtureForge usage guide

[← Project overview](../README.md) · [Architecture](architecture.md)

Run commands from the repository root unless a section says to use a consuming project.

A deterministic, stateful ticket service for testing agents. Package
release **0.2.1**, packaged as `fixtureforge` for npm. Node.js 22.18+ supplies the built-in SQLite
API; no runtime npm dependencies or live customer accounts are required.


## Install the release package

```bash
npm install fixtureforge@0.2.1
npx fixtureforge demo
```

The package ships compiled ESM JavaScript and TypeScript declarations. The source-checkout recipes below assume you have cloned the repository; installed examples are also available under `node_modules/fixtureforge/examples/`.

## Install and run a reference task

```bash
git clone https://github.com/Balaji91221/fixtureforge.git
cd fixtureforge
npm ci
npm run typecheck
npm run build
npm test
node dist/cli.js run --scenario examples/scenarios/ticket-triage.json
node dist/cli.js run --scenario examples/scenarios/impossible.json
```

The reference triage trace passes (exit 0); the intentionally impossible reopening
task fails (exit 1). Invalid input or infrastructure failures exit 2. Agent prose
never changes the verdict: predicates inspect stored tickets/events.

For a consuming project, run `npm pack`, then install the generated local tarball:

```bash
npm install /absolute/path/fixtureforge-0.2.1.tgz
```

The package contains compiled ESM JavaScript, declarations, examples and docs. The CLI is available as `fixtureforge` after installation. Node SQLite can emit an experimental
warning on supported older Node releases; stdout protocol/report data stays clean.

## SDK: isolated persistent environments

```ts
import { EnvironmentManager } from 'fixtureforge';
import { readFileSync } from 'node:fs';

const manager = new EnvironmentManager('/tmp/my-fixture-runs');
const scenario = JSON.parse(readFileSync('ticket-triage.json', 'utf8'));
const run = manager.create(scenario, 'experiment-1');
const alice = manager.openActor(run.id, run.credentials.actorTokens.alice);
try {
  const found = alice.call('search', { query: 'Payment' });
  console.log(found);
  // Actor clients support create/search/get/update/transition/close.
  console.log(manager.evaluate(run.id, run.credentials.ownerToken));
} finally {
  alice.dispose();
  manager.destroy(run.id, run.credentials.ownerToken);
  manager.close();
}
```

`createEnvironment({scenario, directory, id?})` is an async convenience that returns
`{manager, id, credentials, snapshot}`. The caller owns that manager and must close
or destroy it. `TicketEnvironment` remains available for pure in-memory tests.

Each namespace owns one SQLite file. Writes use `BEGIN IMMEDIATE`; state, simulated
clock, idempotency records and event history commit or roll back together. Separate
handles reload current state before each operation, so stale expected versions fail.
The simple local store serializes a validated snapshot; it is designed for small
fixtures, not high-throughput production ticket hosting.

Actor tokens are random and scoped to one namespace/user. Only hashes are stored.
Owner tokens authorize snapshots, evaluation, reset, restore, clock control and
destruction. Tokens are intentionally nondeterministic and **excluded from canonical
snapshots**; fixed scenarios and action sequences yield equal snapshots.

## HTTP service

```bash
node dist/cli.js start --scenario examples/scenarios/ticket-triage.json --dir /tmp/fixture-runs --run trial --port 4317
```

This prints the run URL and **sensitive local credentials** once. Preserve them
privately; never commit output containing tokens. The service binds to 127.0.0.1.
Use `Authorization: Bearer <actor token>` against `/runs/trial/tickets` (or `/tickets`
for the default run). Namespace credentials cannot be reused on a different run.

| Method/path | Body or query | Behavior |
|---|---|---|
| GET `/tickets` | query, status, ownerId, assigneeId, limit | Search visible tickets |
| GET `/tickets/{id}` | none | Read a visible ticket |
| POST `/tickets` | title, optional operationKey | Create, with optional idempotency |
| PATCH `/tickets/{id}` | patch: {title?, assigneeId?}, expectedVersion | Edit content/assignment |
| PATCH `/tickets/{id}` | status, expectedVersion | Change lifecycle |
| POST `/tickets/{id}/close` | expectedVersion | Close explicitly |

An owner, assigned member, or admin can access a ticket. Ordinary members cannot
see unrelated tickets. Assignment deliberately grants the assignee access. Closed
tickets cannot be edited or reopened. Legal transitions: open→in_progress,
open→closed, in_progress→closed. Stale versions and conflicting idempotency reuse
return HTTP 409; authorization errors return 403.

`start` owns a transient environment and destroys it/revokes credentials on graceful
shutdown. Add `--persist` to retain state, or create separately and use:

```bash
node dist/cli.js create --scenario examples/scenarios/ticket-triage.json --dir /tmp/fixture-runs --run trial
node dist/cli.js serve --dir /tmp/fixture-runs --run trial --port 4317
```

SIGKILL or a machine crash cannot run cleanup: retained local SQLite files must be
removed using the owner-controlled destroy command after restart. Every service is
a local fixture; do not expose it as a production authentication service.

Backward-compatible `fixtureforge serve 4317` is a deliberately insecure in-memory
**demo mode** using `x-fixture-actor: alice|admin`; it has no persistent namespaces.
The new `start`/`serve --dir` modes always require scoped bearer credentials.

## Scenarios and deterministic evaluation

`examples/scenarios/ticket-triage.json` declares version 1, seed, users, seeded
tickets, task predicates, solvability label, and a known solution. The loader
validates references and runs any `known-solution` trace before creating storage;
a trace that cannot satisfy its predicates is rejected. `intentionally-impossible`
is a dataset label, not a mathematical proof of unsolvability. `unverified` permits
experimental tasks without claiming they can be solved.

Predicates: `ticket_count`, `ticket` field equality, `all_closed`, `event_count`,
`no_duplicate_titles`. `all_closed` requires a nonempty match unless `allowEmpty`
is explicitly true. `all_closed` filters cannot select a status, which would make
the check tautological or impossible; use identity/ownership/title filters instead.
Predicate filters cannot truncate results with `limit`.
Search defaults to all visible matches. Seeded creation/assignment/transition events
are included in the event log and therefore in event-count predicates.

Every mutation advances a deterministic clock by `tickMs` (default 1000) from
`epochMs` (default 2026-01-01 UTC). Owner-controlled advancement is also recorded.
IDs derive from seed + sequence; no ambient time/randomness enters ticket state.

## Snapshot, restore, reset and report

Set `FIXTUREFORGE_OWNER_TOKEN` through your shell's secret/environment mechanism:

```bash
node dist/cli.js snapshot --dir /tmp/fixture-runs --run trial > snapshot.json
node dist/cli.js evaluate --dir /tmp/fixture-runs --run trial
node dist/cli.js report --dir /tmp/fixture-runs --run trial --output report.html
node dist/cli.js restore --dir /tmp/fixture-runs --run trial --snapshot snapshot.json
node dist/cli.js reset --dir /tmp/fixture-runs --run trial
node dist/cli.js destroy --dir /tmp/fixture-runs --run trial
```

`--owner-env NAME` selects a different environment variable; tokens are not command
arguments. Reset returns to the scenario baseline. Reset and restore rotate actor
tokens, invalidating even already-open clients; retain the replacement credentials
returned by the command. Owner credentials remain valid until destruction.

Snapshot schema 2 includes users, clock, ticket sequence, events and idempotency
results. Restore validates event replay consistency, state, references and matching
scenario seed/users. Unknown schema versions are rejected without modifying the
original. To preserve an original database for a future migration, close handles
and copy it before opening the copy with migration tooling. No destructive in-place
migration is performed. Schema 1 of the earlier in-memory demo lacks enough state
for safe restoration and is explicitly rejected.

Reports contain per-predicate evidence, a state diff, and an event timeline with
changed fields. HTML is escaped and files are created exclusively to prevent
accidental overwrites. A full React inspector remains a future optional interface;
local HTML/JSON reports deliver the planned visibility workflow.

## MCP integration

Set `FIXTUREFORGE_ACTOR_TOKEN` to the chosen run's actor token and configure an MCP
client to launch:

```bash
npx --yes fixtureforge@0.2.1 mcp --dir /absolute/fixture-runs --run trial
```

`--actor-env NAME` selects a different credential variable. The server binds one run
and actor at startup. Tools: ticket_create, ticket_search, ticket_get, ticket_update,
ticket_transition, ticket_close. Arguments cannot switch user/run. Administrative
snapshot/reset/restore/destroy operations are not exposed to agents.

The stdio adapter implements MCP lifecycle and tool messages, supports protocol
versions 2024-11-05 through 2025-11-25, and returns domain errors as tool errors.
It has no HTTP MCP transport, task extension, or live model dependency. See
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Verification and limits

Tests cover deterministic snapshots, SQL rollback, independent handles, versions,
namespace/actor isolation, reset/revocation, validated restore, cleanup, success and
failure traces, diffs/reports, HTTP and actual stdio MCP subprocesses. There are no
model calls: agent task success on this simplified simulator is separate from
real-service competence. No independent pilot, hosted deployment, or production validation is claimed. See [implementation status](../IMPLEMENTATION_STATUS.md) for supported scope and verification details.
