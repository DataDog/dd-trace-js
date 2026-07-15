'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const verifier = path.join(__dirname, 'verify-exercised-tests.js')
let fixtureIndex = 0

/**
 * @param {string} name
 * @param {() => void} callback
 * @returns {void}
 */
function test (name, callback) {
  callback()
  process.stdout.write(`ok - ${name}\n`)
}

/**
 * @param {string} file
 * @param {string} contents
 * @returns {void}
 */
function writeFile (file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

/**
 * @param {string} workflow
 * @param {Record<string, string>} [actions]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runVerifier (workflow, actions = {}) {
  const fixtureName = `verify-exercised-tests-${process.pid}-${fixtureIndex++}`
  const workflowFile = path.join(repoRoot, '.github', 'workflows', `${fixtureName}.yml`)
  const actionRoot = path.join(repoRoot, '.github', 'actions', fixtureName)

  try {
    writeFile(workflowFile, workflow.replaceAll('__FIXTURE_ACTION__', `./.github/actions/${fixtureName}`))
    for (const [action, contents] of Object.entries(actions)) {
      writeFile(path.join(actionRoot, action, 'action.yml'), contents)
    }

    return spawnSync(process.execPath, [verifier], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
  } finally {
    fs.rmSync(workflowFile, { force: true })
    fs.rmSync(actionRoot, { force: true, recursive: true })
  }
}

test('accepts a coverage producer followed by an uploader', () => {
  const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`)

  assert.strictEqual(result.status, 0, result.stderr)
})

test('rejects a coverage producer after the last uploader', () => {
  const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/coverage
      - run: node scripts/c8-ci.js
`)

  assert.strictEqual(result.status, 1)
  assert.match(result.stderr, /verify-exercised-tests-\d+-\d+\.yml#coverage: generates coverage but does not upload it/)
})

test('preserves coverage order through nested composite actions', () => {
  const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: __FIXTURE_ACTION__/test
`, {
    test: `
name: test
runs:
  using: composite
  steps:
    - run: node scripts/c8-ci.js
      shell: bash
    - uses: ./.github/actions/coverage
`,
  })

  assert.strictEqual(result.status, 0, result.stderr)
})

test('ignores non-composite local actions', () => {
  const result = runVerifier(`
name: test
on: push
jobs:
  javascript:
    runs-on: ubuntu-latest
    steps:
      - uses: __FIXTURE_ACTION__/javascript
`, {
    javascript: `
name: javascript
runs:
  using: node20
  main: index.js
`,
  })

  assert.strictEqual(result.status, 0, result.stderr)
})
