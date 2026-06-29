#!/usr/bin/env node

'use strict'

// CI-only helper. The shipped package.json pins `engines.node` to the supported
// runtime range (`>=22`), but CI still runs the full suite on Node 18/20 to keep
// those jobs exercising real tests. The runtime guard
// (packages/dd-trace/src/guardrails/index.js) and the `withVersions` test helper
// both read `engines.node` and bail when the running major is below it, which would
// silently skip every suite on the older majors. Widening the field to `>=18` for
// the CI checkout keeps those jobs honest without touching what we publish.

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
