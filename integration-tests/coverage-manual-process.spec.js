'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { buildManualCoverageEnv } = require('./coverage/manual-process')
const { ROOT_ENV } = require('./coverage/runtime')

describe('integration coverage manual process helper', () => {
  let appRoot
  let coverageRoot
  let prevRoot

  before(async () => {
    appRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-trace-manual-env-'))
    coverageRoot = path.join(appRoot, 'node_modules', 'dd-trace')
    await fsp.mkdir(path.join(coverageRoot, 'packages', 'dd-trace', 'src'), { recursive: true })
    await fsp.writeFile(path.join(coverageRoot, 'package.json'), JSON.stringify({ name: 'dd-trace' }))

    prevRoot = process.env[ROOT_ENV]
    process.env[ROOT_ENV] = coverageRoot
  })

  after(async () => {
    if (prevRoot === undefined) {
      delete process.env[ROOT_ENV]
    } else {
      process.env[ROOT_ENV] = prevRoot
    }

    await fsp.rm(appRoot, { force: true, recursive: true })
  })

  it('adds coverage bootstrap env for manual spawn wrappers', () => {
    const env = buildManualCoverageEnv({
      cwd: appRoot,
      env: {
        NODE_OPTIONS: '--loader=dd-trace/loader-hook.mjs',
        PATH: process.env.PATH,
      },
      scriptPath: path.join(coverageRoot, 'loader-hook.mjs'),
    })

    assert.strictEqual(env.DD_TRACE_INTEGRATION_COVERAGE_ROOT, fs.realpathSync(coverageRoot))
    assert.ok(env.NODE_OPTIONS.includes('--loader=dd-trace/loader-hook.mjs'))
    assert.ok(env.NODE_OPTIONS.includes('child-bootstrap.js'))
  })
})
