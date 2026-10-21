# Privacy Hardening Implementation Plan

**Goal:** Prevent diagnostics from copying credentials and make background network access opt-in without removing the status bar.

**Architecture:** Remove storage/URL dumps in both renderer implementations, and independently project persisted diagnostics onto a fixed schema in the main process. Keep manual update and remote query workflows; missing or invalid opt-in values never enable background activity. Database reads use URI read-only mode plus SQLite query-only enforcement and never fall back to a writable connection.

**Tech Stack:** Python standard library, native JavaScript, Electron, node:test and unittest.

## Design choices

- Remove diagnostic value collection rather than redact by secret-looking names: credentials can be stored under arbitrary keys. The main-process allowlist protects against legacy or modified renderer payloads as well.
- Keep minimal mount/version/error-presence diagnostics for installation confirmation. Persist by atomic replacement with owner-only POSIX permissions; never write an unvalidated raw payload on error.
- Preserve explicit user choices (`plugin_auto_update: true`, `remote.auto: true` or `remote.enabled: true`), manual actions, identity isolation and update integrity checks. Missing settings default off.
- Preserve client injection because the desktop status bar requires it. Do not install, restart, publish, read personal databases or change existing runtime configuration during this source repair.

## Tasks and validation

1. Add regressions for synthetic credential leakage, unsafe diagnostic fields, private atomic writes, disabled-by-default networking, and read-only database failure paths. Confirm the new tests fail against the original code.
2. Harden renderer collection and main-process persistence. Test both desktop and web collection, forged/legacy diagnostic input, and symlink replacement using temporary fixtures.
3. Require explicit booleans for updater and remote auto-discovery; synchronize query-pump decisions. Adjust existing automatic-workflow fixtures to opt in explicitly and retain manual-workflow coverage.
4. Enforce read-only/query-only SQLite handles with escaped file URIs. Test rejected INSERT/DDL after disabling query_only, missing files, injected URI characters and connection errors without writable fallback.
5. Update configuration, UI copy, security documentation and bilingual guides, then run `python3 sync_plugin.py` and `--check`.
6. Run the repository's Node and Python regression suites plus JavaScript syntax checks. Review the final diff, then copy only the verified changed files into the user's checkout with a clean-base check. Keep the user's Git history and installed client untouched.

## Security limitations

Source changes do not erase diagnostics written by older installed versions. Explicit opt-in to upstream automatic updates still trusts the upstream publisher; SHA256 is integrity checking, not an independent publisher signature. Client injection retains the host user's privileges. A status bar that correlates subagent tasks still reads selected local conversation records. Actual desktop and SSH behavior needs separate installed-client validation.

## Validation completed

- Node regression suite: 358 passed, zero failed or skipped.
- Python regression suite: 520 run, 519 passed and one Windows-only ctime regression skipped on macOS.
- The credential-leak regressions failed before the fix and passed after it. Fixtures cover legacy/forged diagnostic data, malformed JSON, owner-only permissions, symlink replacement, network opt-ins, escaped database filenames, blocked writes and connection-error handling.
- Shared plugin copies match their root sources; JavaScript syntax checks, Python 3.8 syntax parsing, JSON examples, bilingual README parity and `git diff --check` passed.
- Tests used temporary fixtures. No client installation, personal database query, SSH login, upstream publication or runtime configuration change was performed by this repair.
