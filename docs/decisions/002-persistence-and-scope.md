# Decision 002: isolated SQLite snapshots and explicit actor capabilities

Accepted 2026-10-13. Supersedes the persistence/MCP deferrals in the initial slice.

The domain depends on a synchronous StateStore contract. MemoryStore and SQLiteStore
clone transactional state and reject failed mutations. SQLite writes use BEGIN
IMMEDIATE; validated state, events, idempotency and clock commit together. This
simple serialized snapshot representation favors small inspectable fixtures over
high-throughput relational query performance.

EnvironmentManager owns files, credentials, reset/restore and cleanup. ActorClient
binds credentials and actor identity; tools cannot supply arbitrary identities.
Random tokens remain outside deterministic snapshots, and only hashes persist.
Reset/restore invalidate old actor capabilities; destroy prevents further use.

Task predicates are deterministic and validated. Known solution traces must pass
before environment creation. Invalid actions cannot mutate state, and an agent's
final prose cannot override a failed predicate. Reports show state/event evidence.

MCP and HTTP delegate to the same dispatch/domain methods. Administrative owner
operations stay outside the agent tool surface. The legacy local demo header mode
is kept as explicitly insecure compatibility behavior, separate from persistent
credentialed mode. A React UI is optional later; escaped HTML and JSON supply the
planned local report workflow now. No model-generated rules execute at runtime.
