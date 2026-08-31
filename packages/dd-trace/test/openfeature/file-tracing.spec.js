'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

const { NODE_MAJOR } = require('../../../../version')

const repoRoot = path.resolve(__dirname, '../../../..')
const expectedTracedFiles = [
  'vendor/dist/@datadog/openfeature-node-server/index.js',
]

if (NODE_MAJOR < 20) {
  describe.skip('OpenFeature file tracing (requires @vercel/nft, which needs Node.js >= 20)')
  return
}

// eslint-disable-next-line import/order
const { nodeFileTrace } = require('@vercel/nft')

describe('OpenFeature file tracing', () => {
  it('traces the provider dependency tree through tracer.openfeature', async function () {
    this.timeout(30000)
    const entrypoint = path.join(repoRoot, 'packages/dd-trace/src/proxy.js')
    const { fileList } = await nodeFileTrace([entrypoint], { base: repoRoot })

    for (const expectedTracedFile of expectedTracedFiles) {
      assert.ok(fileList.has(expectedTracedFile), `Expected trace to include ${expectedTracedFile}`)
    }
  })

  it('loads the provider through tracer.openfeature', () => {
    const tracerPath = JSON.stringify(path.join(repoRoot, 'packages/dd-trace'))
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `const tracer = require(${tracerPath}); tracer.init({ plugins: false }); ` +
        "require('@openfeature/server-sdk'); if (!tracer.openfeature) throw new Error('no provider')",
      ],
      { encoding: 'utf8' }
    )

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('does not throw when accessed and registered before `@openfeature/server-sdk` is loaded', () => {
    const tracerPath = JSON.stringify(path.join(repoRoot, 'packages/dd-trace'))
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `const tracer = require(${tracerPath}); tracer.init({ plugins: false }); ` +
        'const provider = tracer.openfeature; ' +
        "const { OpenFeature } = require('@openfeature/server-sdk'); " +
        'OpenFeature.setProvider(provider)',
      ],
      { encoding: 'utf8' }
    )

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('does not load active OpenFeature modules before application access', () => {
    const packagePath = path.join(repoRoot, 'packages/dd-trace')
    const script = `
      const tracer = require(${JSON.stringify(packagePath)})
      tracer.init()
      const modules = [
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/exporters/common/client-library-headers'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/index'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/writers/exposures'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/flagging_provider'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/configuration_source'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/agentless_configuration_source'))}),
        require.resolve(${JSON.stringify(path.join(repoRoot, 'vendor/dist/@datadog/openfeature-node-server'))}),
        require.resolve('@openfeature/server-sdk'),
        require.resolve('@openfeature/core')
      ]
      process.stdout.write(JSON.stringify(modules.map(module => require.cache[module] !== undefined)))
    `
    for (const featureFlagsEnabled of ['false', 'true']) {
      for (const remoteConfigurationEnabled of ['false', 'true']) {
        for (const tracingEnabled of ['false', 'true']) {
          const result = spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8',
            env: {
              ...process.env,
              DD_FEATURE_FLAGS_ENABLED: featureFlagsEnabled,
              DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
              DD_REMOTE_CONFIGURATION_ENABLED: remoteConfigurationEnabled,
              DD_TRACE_ENABLED: tracingEnabled,
              DD_TRACE_STARTUP_LOGS: 'false',
            },
          })

          assert.strictEqual(result.status, 0, result.stderr)
          assert.deepStrictEqual(JSON.parse(result.stdout), Array(9).fill(false))
        }
      }
    }
  })
})
