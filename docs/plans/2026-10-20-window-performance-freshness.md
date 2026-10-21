# Window Trust, Refresh Cost and Data Freshness Implementation Plan

**Goal:** Apply the user's three selected optimizations while preserving the existing privacy repairs and per-pane source isolation.

**Architecture:** Use one trusted-local-window predicate for all injection, reads and pushes, with main-frame verification for incoming IPC and checks after asynchronous work. Reuse subscription-delivered snapshots, lower health-check and DOM-scan frequencies, and skip visual work while hidden. Add fixed-schema query-health metadata and per-pane last-success caches so failures retain correctly scoped readings with an explicit stale/unavailable label.

**Tech Stack:** Native JavaScript, Electron CommonJS, Python standard library, node:test and unittest.

## Implementation and tests

1. Add regressions for external/outside-resource pages, subframe IPC, initial about:blank windows, navigation races and destruction cleanup. Apply the same checks to activity/workspace/task IPC, queries, diagnostics, overlay injection, updater state and delayed responses.
2. Pass the already-read snapshot to subscription callbacks. The renderer uses that cached snapshot for visual refresh and diagnostics, checks bridge health at most once per second, refreshes live text at 250ms, scans messages at 1s, and coordinates panes at 1.2s. Hidden documents skip visual polling/scans and resume on visibility changes; dispose removes new listeners. Verify read counts, subscription updates, hidden/resume behavior, navigation/reinjection cleanup and existing historical-line retry behavior.
3. Publish query health on success/failure and retry failed local reads without depending on a new database write. Show a per-pane stale/unavailable badge and last-success time, retain only the same SID/workspace's successful data, and clear the badge after recovery. Local database errors must not invalidate healthy remote panes. Test initial failure, cached failure, recovery, source switches and malformed/error responses.
4. Update focused documentation and synchronize root runtime assets into the plugin package. Run all Node and Python regressions, syntax checks, packaging parity and diff checks.
5. Copy only changed files back into the requested checkout after checking hashes against a snapshot of the current working tree. No installation, restart, publication, Git reset or overwrite of concurrent edits.

## Scope and limitations

The desktop's asar injection remains required. Performance regressions measure simulated snapshot reads and scan schedules, not real-client CPU or memory savings. Actual multi-window desktop/SSH acceptance remains a separate check. Do not claim official Releases contain these local changes.

## Validation completed

- Node: 377 tests passed, 0 failed. Includes external/subframe rejection, loading windows, old/new Electron navigation event forms, same-URL reload races, destruction cleanup, hidden/resume/dispose, bounded historical-text retries, snapshot-read counts and source-isolated stale data.
- Python: 520 tests run, 519 passed and 1 platform-specific test skipped; 0 failures. The actual-loader integration fixture now supplies its trusted local URL.
- Root and packaged desktop JavaScript passed syntax checks; `sync_plugin.py --check` and `git diff --check` passed.
- Last-success caches update only on incoming successful data, never on geometry/timer rerenders. First-time failures show unavailable, remote successes survive local database errors, malformed snapshots fail closed, and failed local reads retry without a database write.
- Only source, tests and documentation are copied into the requested checkout, using before/after SHA256 checks against the user's existing working tree. The previously applied privacy repairs remain intact. No installed client, personal runtime/configuration or live SSH target was modified or used for acceptance.
