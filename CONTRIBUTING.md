# Contributing

Use Node.js 22.18+ and run `npm ci`, `npm run typecheck`, `npm run build`, and
`npm test`. HTTP tests require permission to bind an ephemeral localhost port.
Add a failing regression for changes to roles, transitions, snapshots, reset,
idempotency, SQLite transactions, predicates, or adapter contracts. Verify a
packed tarball in a fresh consuming project before release.

Keep scenario data separate from business rules. Do not let an LLM modify runtime
permissions or task predicates. A known-solution scenario must replay successfully;
impossible/unverified cases must be labelled separately. New adapters must preserve
domain errors and credential scope. Never commit real tickets or credentials.

Schema changes require versioning and non-destructive migration tests. Use the
repository's Issues and Pull requests for contributions. Code is MIT licensed.
Public GitHub source distribution is separate from npm registry publication;
`private: true` prevents accidental npm publication, and no registry release is
claimed.
