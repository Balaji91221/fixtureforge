# Security

FixtureForge is a local test service, not a production ticket backend. The HTTP
server binds to localhost. Persistent mode requires random, namespace-bound actor
credentials; only hashes are stored. Owner operations are separate and unavailable
through MCP. Protect owner tokens and stdout from create/start/reset/restore.

Reset/restore revoke actor credentials; destroy revokes credentials and closes
tracked database handles before removing the namespace. Graceful transient start
cleanup is tested. SIGKILL, crashes, or hardware failure can leave local files;
use owner-controlled cleanup after restart. Do not use the insecure legacy demo
identity header mode for untrusted agents.

Scenarios and reports are data, never code. HTML output is escaped. Namespace IDs
cannot contain path separators or traversal. SQLite files cannot be symlinks.
These checks do not sandbox hostile concurrent filesystem mutation or protect
against another local process with access to the same OS account/database files.
Use isolated directories/users/containers for untrusted consumers.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Balaji91221/fixtureforge/security/advisories/new) to contact the maintainers. Include the affected version, a sanitized
reproduction, and the expected and observed behavior. Do not post secrets,
credentials, or sensitive exploit details in public issues.

Security fixes target the latest package release (currently 0.2.1).
Older releases have no maintenance guarantee. No independent security
audit or response-time guarantee is claimed.
