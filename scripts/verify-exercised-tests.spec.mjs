import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dirname, '..')
const verifier = path.join(dirname, 'verify-exercised-tests.js')
const coverageAction = path.join(repoRoot, '.github/actions/coverage/action.yml')
const uploadAction = path.join(repoRoot, '.github/actions/upload-coverage-artifact/action.yml')

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
 * @param {string} steps
 * @returns {string}
 */
function createWorkflow (steps) {
  return `
name: test
on: push
env:
  WORKFLOW_ENV: workflow
  WORKFLOW_NUMBER: 1
jobs:
  coverage:
    runs-on: ubuntu-latest
    env:
      JOB_ENV: 1
      JOB_LABEL: job
    steps:
${steps}
`
}

/**
 * @param {string} workflow
 * @param {Record<string, string>} [files]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runVerifier (workflow, files = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-exercised-tests-'))

  try {
    writeFile(path.join(fixtureRoot, 'package.json'), '{"scripts":{}}\n')
    writeFile(path.join(fixtureRoot, '.github/workflows/test.yml'), workflow)
    writeFile(
      path.join(fixtureRoot, '.github/actions/coverage/action.yml'),
      fs.readFileSync(coverageAction, 'utf8')
    )
    writeFile(
      path.join(fixtureRoot, '.github/actions/upload-coverage-artifact/action.yml'),
      fs.readFileSync(uploadAction, 'utf8')
    )
    for (const [file, contents] of Object.entries(files)) {
      writeFile(path.join(fixtureRoot, file), contents)
    }

    return spawnSync(process.execPath, [verifier, fixtureRoot], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })
  } finally {
    fs.rmSync(fixtureRoot, { force: true, recursive: true })
  }
}

describe('verify-exercised-tests coverage uploads', () => {
  it('accepts a coverage producer followed by an uploader', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects a coverage producer after the last uploader', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/coverage
      - run: node scripts/c8-ci.js
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('preserves producer-before-uploader order through nested composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - if: github.ref == 'refs/heads/test'
        uses: ./.github/actions/test
`), {
      '.github/actions/test/action.yml': `
name: test
runs:
  using: composite
  steps:
    - if: false
      run: node scripts/c8-ci.js
      shell: bash
    - if: github.ref == 'refs/heads/test'
      run: node scripts/c8-ci.js
      shell: bash
    - uses: ./.github/actions/coverage
`,
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('preserves uploader-before-producer order through nested composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/test
`), {
      '.github/actions/test/action.yml': `
name: test
runs:
  using: composite
  steps:
    - uses: ./.github/actions/coverage
    - run: node scripts/c8-ci.js
      shell: bash
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('ignores valid non-composite local actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/javascript
      - uses: nick-fields/retry@v4
`), {
      '.github/actions/javascript/action.yml': `
name: javascript
runs:
  using: node20
  main: index.js
`,
      '.github/actions/javascript/index.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('stops expanding recursive composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/recursive
`), {
      '.github/actions/recursive/action.yml': `
name: recursive
runs:
  using: composite
  steps:
    - invalid
    - uses: ./.github/actions/recursive
`,
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects a coverage action that no longer reaches the uploader', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/coverage/action.yml': `
name: coverage
runs:
  using: composite
  steps:
    - run: echo no upload
      shell: bash
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('detects retry-wrapped coverage producers inside composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/test
`), {
      '.github/actions/test/action.yml': `
name: test
runs:
  using: composite
  steps:
    - uses: ./.github/actions/coverage
    - uses: nick-fields/retry@v4
    - uses: nick-fields/retry@v4
      env:
        RETRY_COUNT: 1
        RETRY_LABEL: retry
      with:
        command: |
          export COVERAGE_MODE=enabled
          PLUGINS=http yarn test && npm run test && node scripts/c8-ci.js
    - uses: nick-fields/retry@v4
      with:
        command: yarn test && node scripts/c8-ci.js
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects an uploader with an additional condition', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - if: false
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('ignores coverage producers with statically false conditions', () => {
    const result = runVerifier(createWorkflow(`
      - if: false
        run: node scripts/c8-ci.js
      - if: null
        run: node scripts/c8-ci.js
      - if: 0
        run: node scripts/c8-ci.js
      - if: "-0"
        run: node scripts/c8-ci.js
      - if: ''
        run: node scripts/c8-ci.js
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts coverage producers with statically true conditions', () => {
    const result = runVerifier(createWorkflow(`
      - if: true
        run: node scripts/c8-ci.js
      - if: \${{ true }}
        run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('ignores a coverage producer in a job that cannot run', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/c8-ci.js
`)

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts an uploader guarded by the producer condition', () => {
    const result = runVerifier(createWorkflow(`
      - if: \${{ github.ref == 'refs/heads/test' }}
        run: node scripts/c8-ci.js
      - if: \${{ github.ref == 'refs/heads/test' }}
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('matches separate uploaders to each conditional producer', () => {
    const result = runVerifier(createWorkflow(`
      - if: github.ref == 'refs/heads/first'
        run: node scripts/c8-ci.js
      - if: github.ref == 'refs/heads/second'
        run: node scripts/c8-ci.js
      - if: github.ref == 'refs/heads/first'
        uses: ./.github/actions/coverage
      - if: github.ref == 'refs/heads/second'
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts an unconditional uploader after a conditional producer', () => {
    const result = runVerifier(createWorkflow(`
      - if: github.ref == 'refs/heads/test'
        run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('recognizes a normalized uploader action path', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/upload-coverage-artifact/
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })
}).timeout(0)
