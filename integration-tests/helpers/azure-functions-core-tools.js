'use strict'

const { execFile } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { getCappedRange } = require('../../packages/dd-trace/test/plugins/versions')
const { BUN, BUN_CONFIG, withBun } = require('./bun')

const exec = promisify(execFile)
const name = 'azure-functions-core-tools'
const executable = process.platform === 'win32' ? 'func.exe' : 'func'

function useAzureFunctionsCoreTools () {
  let folder

  before(async function () {
    this.timeout(300_000)
    folder = await mkdtemp(join(tmpdir(), 'dd-trace-azure-functions-core-tools-'))

    const { NODE_OPTIONS, ...env } = withBun()
    const range = getCappedRange(name, '4')
    const args = ['add', `${name}@${range}`, `--config=${BUN_CONFIG}`, '--trust', '--no-progress']
    await exec(BUN, args, { cwd: folder, env, timeout: 270_000 })
  })

  after(async function () {
    this.timeout(30_000)
    if (folder) {
      await rm(folder, { recursive: true, force: true })
    }
  })

  return () => join(folder, 'node_modules', name, 'bin', executable)
}

module.exports = { useAzureFunctionsCoreTools }
