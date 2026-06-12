'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const guard = require('../startup-guard')

const {
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
} = require('../../../packages/dd-trace/src/plugins/util/test')

const { VARIANT } = process.env
const COUNT = Number(process.env.COUNT) || 2_000_000

// Test optimization resolves the code owners of every test file it reports.
// getCodeOwnersForFilename walks the parsed CODEOWNERS entries (reversed, first
// match wins) testing each pattern's regex against the path. On a large suite
// this runs per test file. Build the entries through the real parser from a
// generated CODEOWNERS fixture, then drive lookups over a corpus of realistic
// paths. The lookup memoizes per filename, so each measured pass gets a fresh
// cache view (a new array reference reusing the precompiled regex entries) to
// keep every lookup a real regex scan rather than a Map hit.
function buildCodeowners (variant) {
  const lines = []
  if (variant === 'small') {
    lines.push(
      '/src/ @team-core',
      '/packages/ @team-pkg',
      '*.md @team-docs',
      '/docs/ @team-docs',
      '/test/ @team-qa',
      '*.spec.js @team-qa',
      '/packages/api/ @team-api',
      '/packages/api/auth/ @team-auth',
      '/packages/web/ @team-web',
      '/scripts/ @team-build',
      '/.github/ @team-ci',
      '*.json @team-core',
      '/packages/db/ @team-data',
      '/integration-tests/ @team-qa',
      '/benchmark/ @team-perf',
    )
  } else if (variant === 'large') {
    for (let i = 0; i < 200; i++) {
      lines.push(`/packages/module-${i}/ @team-${i % 12}`)
    }
    lines.push('*.spec.js @team-qa', '*.md @team-docs', '/integration-tests/ @team-qa')
  } else { // wildcard
    for (let i = 0; i < 50; i++) {
      lines.push(`packages/**/module-${i}/**/*.js @team-${i % 8}`)
    }
    lines.push(
      '**/*.spec.js @team-qa',
      '**/fixtures/** @team-fixtures',
      '**/test/**/*.js @team-qa',
      '*.config.* @team-build',
      'packages/**/*.ts @team-types',
    )
  }
  return lines.join('\n') + '\n'
}

function buildFilenames () {
  const names = []
  for (let i = 0; i < 256; i++) {
    const m = i % 200
    const kind = i % 4
    if (kind === 0) names.push(`packages/module-${m}/src/index.js`)
    else if (kind === 1) names.push(`packages/module-${m}/test/feature-${i}.spec.js`)
    else if (kind === 2) names.push(`packages/web/components/widget-${i}/render.js`)
    else names.push(`integration-tests/scenarios/case-${i}/fixtures/data-${i}.json`)
  }
  return names
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeowners-bench-'))
fs.writeFileSync(path.join(tmpDir, 'CODEOWNERS'), buildCodeowners(VARIANT))

const baseEntries = getCodeOwnersFileEntries(tmpDir)
assert.ok(Array.isArray(baseEntries) && baseEntries.length > 0, 'failed to parse CODEOWNERS fixture')

const filenames = buildFilenames()

// Preflight: confirm at least one path resolves to an owner (a *.spec.js path
// matches in every fixture), so the bench is exercising a real match, not an
// all-miss scan that returns null without testing the owners path.
const probeEntries = baseEntries.slice()
const matched = filenames.some((fn) => getCodeOwnersForFilename(fn, probeEntries) !== null)
assert.ok(matched, 'no filename matched any CODEOWNERS entry')

const passSize = filenames.length
const passes = Math.ceil(COUNT / passSize)

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

fs.rmSync(tmpDir, { recursive: true, force: true })
