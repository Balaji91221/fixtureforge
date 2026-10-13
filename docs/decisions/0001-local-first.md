# Local first implementation

The initial FixtureForge implementation keeps its domain behavior in a typed library and composes CLI/adapters around it. Tests use controlled fixtures. A hosted UI and model-assisted features are deferred until the core contracts are demonstrated.

Implemented: deterministic ticket domain, role/ownership checks, idempotent create, optimistic versions, legal state transitions, isolated in-memory environments, event snapshots, SDK and localhost HTTP API. Verified with domain and real HTTP tests. Not yet implemented: SQLite persistence, scenario import/export, automatic task evaluator, MCP adapter, multi-environment HTTP hosting, or report UI. Decision: validate deterministic domain behavior before adding persistent storage; event shape and API keep that extension possible.
