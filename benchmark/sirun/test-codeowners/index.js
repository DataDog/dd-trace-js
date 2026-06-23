'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const guard = require('../startup-guard')

const {
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
} = require('../../../packages/dd-trace/src/plugins/util/test')

const VARIANT = process.env.VARIANT || 'large'
const OPERATIONS = Number(process.env.OPERATIONS)

// Test optimization resolves the code owners of every test file it reports.
// getCodeOwnersForFilename walks the parsed CODEOWNERS entries (reversed, first
// match wins) testing each pattern's regex against the path. On a large suite
// this runs per test file. Entries come from the real parser reading a committed
// CODEOWNERS fixture under fixtures/<variant>/ (`large` is a snapshot of this
// repo's own .github/CODEOWNERS, `small` a typical small-library file), so the
// bench measures the anchored/extension/** pattern mix real repos carry rather
// than a synthesized one. The two sizes bracket the reversed-walk cost. Drive
// lookups over a corpus of paths shaped like that repo's files. The lookup
// memoizes per filename, so each measured pass gets a fresh cache view (a new
// array reference reusing the precompiled regex entries) to keep every lookup a
// real regex scan rather than a Map hit.

// Paths shaped like the files each fixture's repo reports: team-owned source and
// test files matched at varying depths, a few extension/** wildcard matches, and
// a couple of unowned shapes that fall through to a full-scan miss.
const SHAPES = {
  large: [
    'packages/dd-trace/test/llmobs/foo.spec.js',
    'packages/dd-trace/src/appsec/waf/index.js',
    'packages/datadog-plugin-jest/test/index.spec.js',
    'packages/datadog-plugin-redis/src/index.js',
    'packages/datadog-instrumentations/src/openai.js',
    'integration-tests/cypress/cypress.spec.js',
    'integration-tests/playwright/playwright.spec.js',
    'packages/dd-trace/test/plugins/util/test.spec.js',
    'packages/datadog-plugin-http/src/client.dsm.spec.js',
    'packages/datadog-plugin-ai/src/code_origin.js',
    'packages/dd-trace/src/config/index.js',
    'packages/dd-trace/test/telemetry/telemetry.spec.js',
    'benchmark/sirun/scope/index.js',
    'scripts/release/helpers/requirements.js',
    'README.md',
    'packages/dd-trace/src/some-unowned-area/deep/module.js',
  ],
  small: [
    'src/parser/tokenizer.js',
    'src/serializer/encode.js',
    'src/index.js',
    'lib/runtime.js',
    'types/index.d.ts',
    'test/parser.spec.js',
    'test/unit/serializer.test.js',
    'scripts/build.js',
    'docs/guide.md',
    'README.md',
    '.github/workflows/ci.yml',
    'examples/demo/app.js',
    'benchmarks/throughput.js',
    'config/settings.json',
  ],
}

function buildFilenames (variant) {
  const shapes = SHAPES[variant]
  const names = []
  for (let i = 0; i < 2048; i++) {
    const shape = shapes[i % shapes.length]
    // Make each name distinct (forcing a real scan rather than a memoized hit)
    // while keeping the matching rule intact: insert a unique directory segment
    // before the basename, or for a top-level file vary the basename itself.
    const slash = shape.lastIndexOf('/')
    if (slash === -1) {
      names.push(shape.replace(/(\.[^.]+)$/, `-${i}$1`))
    } else {
      names.push(`${shape.slice(0, slash)}/u${i}/${shape.slice(slash + 1)}`)
    }
  }
  return names
}

const baseEntries = getCodeOwnersFileEntries(path.join(__dirname, 'fixtures', VARIANT))
assert.ok(Array.isArray(baseEntries) && baseEntries.length > 0, 'failed to parse CODEOWNERS fixture')

const filenames = buildFilenames(VARIANT)

// Preflight: confirm the corpus exercises both branches — at least one path
// resolves to an owner and at least one falls through to null — so the bench is
// a real mix of matches and full-scan misses, not an all-hit or all-miss loop.
const probeEntries = baseEntries.slice()
let probeMatched = false
let probeMissed = false
for (const fn of filenames) {
  if (getCodeOwnersForFilename(fn, probeEntries) === null) probeMissed = true
  else probeMatched = true
}
assert.ok(probeMatched, 'no filename matched any CODEOWNERS entry')
assert.ok(probeMissed, 'every filename matched; corpus exercises no full-scan miss')

const passSize = filenames.length
const passes = Math.ceil(OPERATIONS / passSize)

guard.loopStart()
let sink = 0
for (let p = 0; p < passes; p++) {
  const view = baseEntries.slice()
  for (let f = 0; f < passSize; f++) {
    if (getCodeOwnersForFilename(filenames[f], view) !== null) sink++
  }
}
guard.done()

if (sink === 0) throw new Error('unreachable')
