'use strict'

const assert = require('node:assert/strict')
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
  it('traces the provider dependency tree through the runtime wrapper', async () => {
    await assertTracesProvider(path.join(repoRoot, 'packages/dd-trace/src/openfeature/flagging_provider.js'))
  })

  it('traces the provider dependency tree through the explicit entrypoint', async () => {
    await assertTracesProvider(path.join(repoRoot, 'openfeature.js'))
  })

  it('loads the provider through the explicit entrypoint', () => {
    require(path.join(repoRoot, 'openfeature.js'))
  })
})
