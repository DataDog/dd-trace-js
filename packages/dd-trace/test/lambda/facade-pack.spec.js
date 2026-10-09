'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { after, before, describe, it } = require('mocha')

const repoRoot = path.resolve(__dirname, '../../../..')

describe('packed Lambda facade', () => {
  let temporaryDirectory
  let surface

  before(() => {
    temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-lambda-facade-'))
    const tarball = execFileSync('npm', [
      'pack',
      '--ignore-scripts',
      '--pack-destination',
      temporaryDirectory,
      '--silent',
    ], { cwd: repoRoot, encoding: 'utf8' }).trim()
    execFileSync('tar', ['-xzf', path.join(temporaryDirectory, tarball), '-C', temporaryDirectory])

    const packedFacade = path.join(temporaryDirectory, 'package', 'lambda.js')
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

  it('ships the stable facade from the npm artifact', () => {
    assert.deepStrictEqual(surface, [
      'getTraceHeaders',
      'reportInitFailure',
      'sendDistributionMetric',
      'sendDistributionMetricWithDate',
      'wrap',
    ])
  })
})
