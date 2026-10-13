# FixtureForge implementation status

Local development release **0.2.0**, 13 October 2026. First-release local scope is
implemented. No hosted deployment, independent pilot or production validation is
claimed. The public npm package identity is `fixtureforge@0.2.0`; release checks
validate the compiled tarball independently of the source checkout.

## Implemented

- Installable compiled TypeScript/ESM SDK and CLI with no runtime npm dependencies;
  built-in SQLite requires Node 22.18+.
- Ticket create/search/get/update/assignment/close with service-level role/owner/
  assignee checks, optimistic versions, legal transitions and idempotent retries.
- SQLite per namespace with atomic state/event/clock/idempotency transactions;
  state reload across independent handles, random scoped actor/owner capabilities,
  reset/restore revocation, explicit owner cleanup and transient SIGTERM cleanup.
- Versioned scenarios, deterministic seed/time, known solution replay, separate
  impossible/unverified labels, five deterministic task predicates and evidence.
- Schema 2 snapshots validated by event replay and canonical idempotency history;
  malformed/missing clock values and unsupported versions cannot be restored.
- Authenticated local HTTP and actor-bound stdio MCP adapters; credentials cannot
  override actor/run identity. MCP contains only six actor operations.
- JSON/escaped HTML reports with task results, state diffs and event timelines.
- MIT license, changelog, contribution/security guidance, CI build/test/pack/install
  workflow, release plan matrix and architecture decision records.

## Verification

On Node 26.5.0/macOS: `npm run typecheck`, `npm run build`, and `npm test` passed,
including **26 tests**. Run these commands after `npm ci` to reproduce the checks.
Tests include real HTTP listeners, real stdio MCP, persistent state, namespace
isolation, deterministic replay, invalid restores, rollback on serialization failure,
credential rotation, and actual CLI SIGTERM/persist cleanup. A clean consuming
project installs the packed 0.2.0 tarball and exercises SDK and CLI reference tasks.
The passing triage trace and intentionally impossible reopening trace are examples,
not a measurement of real-world agent performance.

CI is configured for Node 22.18 and 24; it has not yet been run on a hosted runner.
This release was reviewed locally for failure atomicity, restore correctness and
permission boundaries. No claim of exhaustive review is made.

## Boundaries and decisions

The state store serializes one validated snapshot per run, suitable for small test
fixtures. It is not a multi-tenant hosted ticket service or a distributed simulator.
The optional React inspector is deferred; the requested evidence/report workflow
works through local HTML/JSON. There is no LLM scenario generator or model-dependent
runtime behavior. Known-solution traces are validated; impossible labels are labels,
not proofs. Legacy `serve PORT` is explicitly insecure in-memory demo compatibility.

Snapshots exclude random credentials. Reset/restore rotate actor tokens and preserve
owner tokens. Shutdown cleanup requires graceful termination; SIGKILL/crashes can
leave files for explicit owner cleanup. Filesystem checks do not sandbox a hostile
process with the same OS account. Historical schema 1 demo snapshots are rejected
rather than guessed/migrated destructively. Close and copy databases before future
migration. Registry releases retain the security-reporting route and require explicit
maintainer publication after package checks.

## Public distribution

The compiled `fixtureforge@0.2.0` package is distributed as a [GitHub release tarball](https://github.com/Balaji91221/fixtureforge/releases/download/v0.2.0/fixtureforge-0.2.0.tgz). npm registry publication is pending. Installing the public tarball with npm provides the same SDK and CLI.
