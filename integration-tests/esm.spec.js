'use strict'

const { createSandbox, spawnProc } = require('./helpers')
const path = require('path')
const { assert } = require('chai')

describe('Test ESM modules are instrumented as expected', () => {
  let sandbox, cwd, proc
  const execArgv = ['--import', 'dd-trace/initialize.mjs']

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
  })

  after(async () => {
    await sandbox.remove()
  })

  afterEach(() => {
    proc?.kill()
  })

  it('should instrument importing whole module', async () => {
    let logs = ''
    await spawnProc(path.join(cwd, 'esm/import-module.mjs'), {
      cwd,
      execArgv
    }, (output) => {
      logs += output.toString()
    })

    assert.include(logs, 'METHOD_INSTRUMENTED')
  })

  it('should instrument importing a method', async () => {
    let logs = ''
    await spawnProc(path.join(cwd, 'esm/import-method.mjs'), {
      cwd,
      execArgv
    }, (output) => {
      logs += output.toString()
    })

    assert.include(logs, 'METHOD_INSTRUMENTED')
  })
})
