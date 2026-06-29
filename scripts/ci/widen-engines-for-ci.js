#!/usr/bin/env node

'use strict'

// CI-only helper. The shipped package.json pins `engines.node` to the supported
// runtime range (`>=22`), but CI still runs the full suite on Node 18 and 20 to
// keep those jobs exercising real tests. The runtime guard
// (packages/dd-trace/src/guardrails/index.js) and the `withVersions` test helper
// both read `engines.node` and bail when the running major is below it, which would
// silently skip every suite on those majors. Widening the field to `>=18` for the
// CI checkout keeps those jobs honest without touching what we publish.
//
// The node/setup action gates this step so it only runs on the supported majors the
// `>=22` bump newly excludes (18 and 20); it is never invoked on the ancient runtimes
// the `integration-guardrails-unsupported` job installs, which must keep seeing the
// shipped `>=22` so the guard aborts.

const fs = require('node:fs')
const path = require('node:path')

const CI_MIN_NODE = '>=18'

const packageJsonPath = path.join(__dirname, '..', '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

const before = pkg.engines.node
pkg.engines.node = CI_MIN_NODE
const after = pkg.engines.node

fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n')

// eslint-disable-next-line no-console
console.log(`Widened engines.node for CI: ${before} -> ${after}`)
