'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, symlinkSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { nodeFileTrace } = require('@vercel/nft')
const { describe, it } = require('mocha')

const repoRoot = path.resolve(__dirname, '../../../..')
const expectedPackageFiles = [
  'node_modules/@datadog/openfeature-node-server/package.json',
  'node_modules/@datadog/flagging-core/package.json',
  'node_modules/spark-md5/package.json',
]

/**
 * @param {string} entrypoint
 */
async function assertTracesProvider (entrypoint) {
  const { fileList } = await nodeFileTrace([entrypoint], { base: repoRoot })

  for (const expectedPackageFile of expectedPackageFiles) {
    assert.ok(fileList.has(expectedPackageFile), `Expected trace to include ${expectedPackageFile}`)
  }
}

describe('OpenFeature file tracing', () => {
  it('traces the provider dependency tree through the default entrypoint', async () => {
    await assertTracesProvider(path.join(repoRoot, 'index.js'))
  })

  it('traces the provider dependency tree through the runtime wrapper', async () => {
    await assertTracesProvider(path.join(repoRoot, 'packages/dd-trace/src/openfeature/flagging_provider.js'))
  })

  it('traces the provider dependency tree through the explicit entrypoint', async () => {
    await assertTracesProvider(path.join(repoRoot, 'openfeature.js'))
  })

  it('loads the provider through the explicit entrypoint', () => {
    require(path.join(repoRoot, 'openfeature.js'))
  })

  it('loads the explicit entrypoint as an ESM package subpath', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'dd-trace-openfeature-'))
    const nodeModulesPath = path.join(fixtureRoot, 'node_modules')

    try {
      mkdirSync(nodeModulesPath)
      symlinkSync(repoRoot, path.join(nodeModulesPath, 'dd-trace'), 'junction')
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', "import 'dd-trace/openfeature.js'"],
        { cwd: fixtureRoot, encoding: 'utf8' }
      )

      assert.strictEqual(result.status, 0, result.stderr)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
