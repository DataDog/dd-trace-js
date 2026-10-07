'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

const { withVersions } = require('../../dd-trace/test/setup/mocha')

const repoRoot = path.join(__dirname, '../../..')
const fixture = path.join(__dirname, 'fixtures', 'entrypoint.js')
const entrypoints = [
  ['dd-trace', path.join(repoRoot, 'index.js')],
  ['dd-trace-electron', path.join(repoRoot, 'index.electron.js')],
]

describe('dd-trace-api entrypoints', () => {
  withVersions('dd-trace-api', 'dd-trace-api', version => {
    const apiPath = path.join(repoRoot, 'versions', `dd-trace-api@${version}`)

    for (const [name, entrypoint] of entrypoints) {
      it(`should bridge through ${name}`, () => {
        const result = spawnSync(process.execPath, [fixture], {
          encoding: 'utf8',
          env: {
            ...process.env,
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
            DD_REMOTE_CONFIGURATION_ENABLED: 'false',
            DD_TRACE_STARTUP_LOGS: 'false',
            DD_TRACE_TEST_API_PATH: apiPath,
            DD_TRACE_TEST_ENTRYPOINT: entrypoint,
          },
          timeout: 5_000,
        })

        assert.strictEqual(result.status, 0, result.stderr || result.error?.message)
      })
    }
  })
})
