# Tests

Plain Node, no framework. Each file writes a stubbed copy of the module under
test beside itself (`.*_testable.mjs`, gitignored) because the API modules
import `@vercel/kv`, which does not resolve outside Vercel.

Run one:

    node tests/biweekly.test.mjs

Run all:

    node tests/run-all.mjs

These encode the cadence documents in `X:\Amazon Ad Optimization`. A failure
means either the code drifted or the spec changed — decide which before
editing the assertion.
