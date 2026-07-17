import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, it } from 'mocha'

const pluginsVariable = '$' + '{PLUGINS}'
const verifierPath = fileURLToPath(new URL('verify-exercised-tests.js', import.meta.url))

let repoRoot

/**
 * @param {string} relativePath
 * @param {string} contents
 */
function writeFixtureFile (relativePath, contents) {
  const filePath = path.join(repoRoot, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-exercised-tests-'))

  writeFixtureFile('package.json', JSON.stringify({
    scripts: {
      'test:plugins:ci': `mocha "packages/datadog-plugin-${pluginsVariable}/test/**/*.spec.js"`,
      'test:llmobs:plugins:ci': `mocha "packages/dd-trace/test/llmobs/plugins/${pluginsVariable}/*.spec.js"`,
    },
  }))
  writeFixtureFile('packages/datadog-plugin-foo/test/index.spec.js', '')
  writeFixtureFile('packages/dd-trace/test/llmobs/plugins/foo/index.spec.js', '')
  writeFixtureFile('.github/actions/plugins/test/action.yml', `
inputs:
  suite:
    default: plugins
runs:
  using: composite
  steps:
    - uses: ./.github/actions/plugins/run-suite
      with:
        suite: \${{ inputs.suite }}
`)
  writeFixtureFile('.github/actions/plugins/run-suite/action.yml', `
inputs:
  suite:
    required: true
runs:
  using: composite
  steps:
    - if: \${{ inputs.suite == 'plugins' }}
      run: yarn test:plugins:ci
      shell: bash
    - if: \${{ inputs.suite == 'llmobs' }}
      run: yarn test:llmobs:plugins:ci
      shell: bash
`)
})

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true })
})

describe('verify-exercised-tests', () => {
  it('does not count a disabled composite action step as invoked', () => {
    writeFixtureFile('.github/workflows/test.yml', `
jobs:
  plugins:
    env:
      PLUGINS: foo
    steps:
      - uses: ./.github/actions/plugins/test
`)

    const result = spawnSync(process.execPath, [verifierPath, repoRoot], { encoding: 'utf8' })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:llmobs:plugins:ci" is not invoked/)
  })

  it('propagates inputs through nested composite actions', () => {
    writeFixtureFile('.github/workflows/test.yml', `
jobs:
  plugins:
    env:
      PLUGINS: foo
    steps:
      - uses: ./.github/actions/plugins/test
  llmobs:
    env:
      PLUGINS: foo
    steps:
      - uses: ./.github/actions/plugins/test
        with:
          suite: llmobs
`)

    const result = spawnSync(process.execPath, [verifierPath, repoRoot], { encoding: 'utf8' })

    assert.strictEqual(result.status, 0, result.stderr)
  })
})
