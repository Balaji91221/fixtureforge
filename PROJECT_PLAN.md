# FixtureForge project plan

Stateful simulated services for agent testing.

**Status:** Local 0.2.0 implementation complete for the first-release scope. See [current implementation status](IMPLEMENTATION_STATUS.md) and [usage instructions](README.md). Npm registry publication, external pilots and production validation remain open. **Planning date:** 13 October 2026. Package naming still requires public registry review before publication.

## Goal and target users

Agent developers and evaluation teams who need repeatable service environments without live customer accounts.

Static mock responses cannot prove whether an agent completed a multi-step workflow. FixtureForge models service state so a created ticket is searchable, editable, and closable, and final state can be checked.

## Product hypothesis and validation

Small, realistic environments with explicit state transitions, deterministic seeds, and ground-truth success predicates. Focus on one coherent service rather than a large catalog of shallow mocks.

Before expanding the implementation, interview three to five target developers. Ask for a recent concrete failure, current workaround, and a repository or sanitized fixture they can share. A successful pilot means someone other than the author can install the tool, reproduce a useful finding, and explain why it belongs in their workflow. These are validation goals, not established demand.

## First release scope

A ticket-service simulator with users, authorization, create/search/update/close tools, scenario seeding, run isolation, state snapshots, and deterministic task assertions. Expose HTTP and choose one MCP adapter only after the domain API works.

**Out of scope:** No real customer integrations, model-generated business rules at runtime, complete SaaS emulation, billing, or a distributed simulation platform.

## Representative workflow

Runner creates scenario namespace → loads seeded users and tickets → agent receives scoped credentials → actions mutate isolated state → runner evaluates final state → exports report and destroys the namespace.

## High level design

```text
Scenario loader -> Isolated state store
Agent -> HTTP/MCP adapter -> Ticket service -> State store
Clock + Seeded IDs -> Ticket service
State snapshot + Event log -> Task evaluator
```

**Implementation stack:** TypeScript, Node.js, SQLite per run, HTTP server, optional MCP adapter, JSON scenarios; local React state inspector later.

**Architecture choice:** Static response fixtures are cheaper but cannot test stateful completion. An in-memory domain simulator is ideal for early tests; SQLite is selected for inspectable snapshots. Containers per external SaaS clone are too expensive for the first service.

Keep the core as a local library with thin interface adapters. Process boundaries shown above are deliberate; do not split every module into a deployed service. A dashboard is a consumer of the core results, not the owner of domain rules.

## Low level design

| Component | Contract | Responsibility and state |
|---|---|---|
| `ScenarioLoader` | `load(spec) -> InitialState` | Validates scenario identities and references. |
| `EnvironmentManager` | `create(spec) -> EnvironmentHandle` | Owns namespace, credentials, and cleanup. |
| `TicketService` | `create/update/close(actor, input) -> Ticket` | Owns permissions and state transitions. |
| `TicketRepository` | `save(ticket, expectedVersion) -> Ticket` | Owns atomic persistence and concurrency. |
| `SimulationClock` | `now/advance -> Instant` | Owns deterministic time. |
| `TaskEvaluator` | `evaluate(snapshot, taskSpec) -> Result` | Owns success predicates, independent of agent claims. |

### Data and state ownership

Environment(id, seed, clock, status); User(id, role); Ticket(id, ownerId, assigneeId, status, version); Event(sequence, actor, action, before, after); TaskSpec(expectedPredicates). Ticket lifecycle: open → in_progress → closed; reopening must be an explicitly supported transition.

### Invariants

Environment state cannot cross namespaces. Permission checks occur in the service, not only adapters. Writes are atomic and reject stale expectedVersion values. Same seed and action sequence produce the same state. Agent final prose cannot override failed state assertions.

### Failure and concurrency behavior

Reset only an owned environment. Ensure run cancellation deletes transient credentials and closes database handles. Model retries may be deduplicated via operation keys if the fixture contract supports them. Invalid actions return realistic typed errors without silently adjusting inputs.

## SOLID decisions

- **Single responsibility:** ScenarioLoader owns input interpretation; TaskEvaluator owns its separate output or integration concern. Domain evaluation does not move into CLI handlers.
- **Open closed:** introduce a new supported adapter behind an existing contract; add new domain behavior explicitly rather than adding hidden project-name switches.
- **Liskov substitution:** adapters must preserve documented result, error, cancellation, and completeness semantics. Run the same contract fixtures against every implementation; unsupported behavior must be explicit.
- **Interface segregation:** separate inspection from mutation and execution from reporting. Consumers receive only the operations they use.
- **Dependency inversion:** domain logic consumes typed contracts; the CLI or composition root wires concrete filesystem, transport, and provider implementations. Pure transformations stay functions instead of gaining unnecessary interfaces.

## LLM system design

Agents consume the simulator; the simulation core requires no model. A later scenario generator may draft fixtures, which must pass schema and solvability validation. Maintain known solution traces and intentionally impossible tasks separately.

When optional model calls are introduced, version prompts and output schemas, validate every response, bound tokens/time/cost, and store source references. Treat retrieved files and tool output as data. Keep model output out of authorization and deterministic pass/fail decisions. Document which content leaves the machine.

## Installation and integration design

The local MIT-licensed package supplies these commands after installation from its tarball. No registry package is published. Owner operations read FIXTUREFORGE_OWNER_TOKEN; MCP reads FIXTUREFORGE_ACTOR_TOKEN.

```text
fixtureforge start --scenario examples/scenarios/ticket-triage.json --dir /tmp/fixtures --run run-123
fixtureforge evaluate --dir /tmp/fixtures --run run-123
fixtureforge snapshot --dir /tmp/fixtures --run run-123
```

**Public SDK contract:**

```text
createEnvironment({ scenario, directory, id? }): Promise<{ manager, id, credentials, snapshot }>
```

Provide one end-to-end example with pinned supported dependencies. Keep the CLI a wrapper over the public SDK. Document configuration discovery, schema version, error categories, supported platforms, and exit codes. For check-oriented commands, distinguish success, failed checks, and incomplete/infrastructure failure. MCP integrations should expose narrow tools and validate configured roots; a plugin packages instructions and connection configuration rather than duplicating the engine.

## Repository structure

```text
src/
  core/             # Domain types, state, and evaluation
  adapters/         # External protocols, analyzers, runners, or storage
  cli/              # User commands and composition
tests/
  unit/
  integration/
  fixtures/
examples/
docs/
  decisions/
  api/
```

Add a report UI or server directory only when that milestone begins. Keep runtime artifacts and any credential files out of version control. Do not create a shared framework spanning these seven independent projects.

## Implementation roadmap

| Phase | Working deliverable | Verification gate |
|---|---|---|
| 1. Model ticket domain | Implement transitions and permission rules. | Unit tests cover every legal and illegal transition. |
| 2. Add deterministic storage | Inject clock/ID source and persist events. | Identical seeds and actions produce equal snapshots. |
| 3. Expose the service | Implement HTTP interface and one optional MCP adapter. | Adapter contract tests agree with domain behavior. |
| 4. Build scenario runner | Create/reset namespaces and evaluate final state. | Known solutions pass and incomplete tasks fail. |
| 5. Add developer visibility | Export event timeline and state diffs. | A failed task can be explained from stored evidence. |
| 6. Package and pilot | Publish library, server command, and sample tasks. | An external agent can complete a fixture without live accounts. |

Proceed in order. Each phase should finish with a runnable example and its verification evidence. Size the next phase after measuring the current one; no fixed delivery date is assumed.

## Testing and evaluation

Check permissions, invalid transitions, optimistic concurrency, namespace isolation, seeded reproducibility, snapshot restore, resource cleanup, and known successful/failed action sequences.

Release gate: repeated seeded action sequences yield identical canonical snapshots; no cross-environment access; all reference solution traces satisfy their predicates. Measure agent task success separately from simulator correctness.

Use unit tests for pure rules and integration tests at external boundaries. Maintain a held-out set for model-dependent behavior. Record run counts, versions, and incomplete cases. Do not call a system production-ready based only on seeded fixtures.

## Operations and release

- Start local-first. Log structured event IDs, durations, completeness, and errors without secrets; make detailed source capture explicit.
- Version configuration and stored artifact schemas. Validate compatibility before loading older artifacts; migrate a copy and retain the original.
- Pin supported integration versions in examples and test the documented minimum/current range before releases.
- Build distributable artifacts in CI and test installation in a clean environment. Publish release notes, a changelog, contribution instructions, and a security-reporting route.
- Roll back by pinning the previous package version. Keep baseline artifacts readable; do not overwrite them during a failed upgrade.
- A future hosted dashboard requires authentication, tenant isolation, retention/deletion controls, job quotas, and tested backups. Those are a separate release, not implicit MVP features.

## Learning outcomes

Build the deterministic core to practice data modeling and LLD. Trace the process and storage boundaries to practice HLD. Package the CLI/SDK to learn API stability and developer experience. Add model evaluation only where the product needs it. Use the optional report UI to learn full-stack integration around meaningful domain results.

## Open decisions and risks

Unrealistic simulations reward strategies that fail in real services. Document intentionally simplified behavior and validate it with integration developers. Do not market fixture performance as real-world success.

Node 22.18+ with built-in SQLite is the supported runtime; development dependencies are pinned and code is MIT licensed. CI targets Node 22.18 and 24. Local verification ran Node 26.5.0 on macOS; hosted CI and external pilot results are not yet available. Registry naming and pilot recruitment remain release work.

## Delivery checklist

- [ ] Product hypothesis tested with target developers
- [x] First vertical slice implemented
- [x] Domain and integration verification gates passed
- [x] Model-dependent behavior evaluated, if present — not applicable: no model dependency
- [x] Clean-install example verified
- [x] Documentation and package artifacts reviewed
- [ ] Release published
- [ ] Independent pilot completed

## Implemented feature matrix (0.2.0)

| Planned capability | Implemented entry point | Verification/status |
|---|---|---|
| Ticket domain, roles, transitions, versions | `TicketEnvironment`, `domain.ts` | Create/search/get/update/assignment/close; illegal and stale writes fail |
| Deterministic clock and IDs | Snapshot clock/tick/seed; owner advance | Repeated traces yield equal snapshots; credentials excluded |
| Persistent atomic state | `SQLiteStore`, schema 1 | Restart/independent handles, rollback including uncloneable results |
| Namespace lifecycle and scoped credentials | `EnvironmentManager` | Create/reset/destroy; reset/restore revoke existing actor handles |
| Cancellation cleanup | CLI transient `start` | SIGTERM test removes namespace; `--persist` retains it |
| Scenario seeding and known solutions | `loadScenario`, scenario schema 1 | Known solution replay required; impossible/unverified labels separate |
| Snapshot export/restore | `snapshot`/`restore`, snapshot schema 2 | Validated event replay, clock fields, ID sequence, canonical retry keys |
| Deterministic task predicates | `evaluate`, five predicate kinds | Incomplete/vacuous tasks fail; all_closed cannot filter status |
| HTTP and MCP integrations | `http.ts`, `mcp.ts` | Real HTTP and stdio process tests; agent cannot select another actor |
| State diff and event timeline | `report`, `stateDiff`, `eventTimeline` | Escaped exclusive HTML/JSON outputs with predicate evidence |
| Installable SDK/CLI and release files | npm tarball, CI, security/contribution/license docs | Clean consuming-project SDK/CLI smoke checked locally |
| React inspector | Optional later interface | Current visibility workflow uses HTML/JSON; decision 002 |
| LLM scenario generation | Later optional feature | No runtime model business rules or model dependency |
| Public registry release and independent pilot | External work | Not done; no claim of production or real-service competence |

The storage implementation uses an explicit StateStore interface with a serialized,
validated snapshot in SQLite rather than separate relational ticket/event tables.
This keeps small fixtures atomic and inspectable. Domain, transport, scenario and
storage modules are flat files until their size warrants subdirectories. These
implementation choices are recorded in decision 002 and do not change scope.

## Reference projects

These references are starting points for implementation-time review, not proof that the proposed differentiator is novel.

- [Browser Use example of an agent consumer](https://github.com/browser-use/browser-use)
