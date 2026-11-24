'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { after, before, describe, it } = require('mocha')

const { BUN } = require('../../../../integration-tests/helpers/bun')

const repoRoot = path.resolve(__dirname, '../../../..')

describe('packed Lambda facade', () => {
  let temporaryDirectory
  let surface
  let packedRoot

  before(() => {
    temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-lambda-facade-'))
    const tarball = path.join(temporaryDirectory, 'dd-trace.tgz')
    // npm 10 runs prepare even with --ignore-scripts, rebuilding vendor dependencies in this
    // unit hook. Use the same lifecycle-free package builder as the integration sandboxes.
    execFileSync(BUN, [
      'pm',
      'pack',
      '--ignore-scripts',
      '--quiet',
      '--gzip-level',
      '0',
      '--filename',
      tarball,
    ], { cwd: repoRoot })
    execFileSync('tar', ['-xzf', tarball, '-C', temporaryDirectory])

    packedRoot = path.join(temporaryDirectory, 'package')
    const packedFacade = path.join(packedRoot, 'packages/dd-trace/src/lambda/facade.js')
    const script = `console.log(JSON.stringify(Object.keys(require(${JSON.stringify(packedFacade)})).sort()))`
    surface = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: path.join(repoRoot, 'node_modules'),
      },
    }))
  })

  after(() => {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  })

  it('does not publish a root Lambda entry point or declarations', () => {
    assert.strictEqual(existsSync(path.join(packedRoot, 'lambda.js')), false)
    assert.strictEqual(existsSync(path.join(packedRoot, 'lambda.d.ts')), false)
  })

  it('ships the internal shim bridge in the npm artifact', () => {
    assert.deepStrictEqual(surface, [
      'getTraceHeaders',
      'reportInitFailure',
      'sendDistributionMetric',
      'sendDistributionMetricWithDate',
      'wrap',
    ])
  })
})
