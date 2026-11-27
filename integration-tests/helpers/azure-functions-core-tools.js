'use strict'

const { execFile } = require('node:child_process')
const { existsSync } = require('node:fs')
const { chmod, mkdir, mkdtemp, rename, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { promisify } = require('node:util')

const { dependencies } = require('../../packages/dd-trace/test/plugins/versions/package.json')

const exec = promisify(execFile)
const platform = { darwin: 'osx', win32: 'win' }[process.platform] ?? process.platform
const version = dependencies['azure-functions-core-tools']
const build = `${platform}-${process.arch}.${version}`
const cache = resolve(__dirname, '../../node_modules/.cache/azure-functions-core-tools')
const installDir = join(cache, build)
const executable = process.platform === 'win32' ? 'func.exe' : 'func'
const func = join(installDir, executable)

function useAzureFunctionsCoreTools () {
  before(async function () {
    this.timeout(300_000)
    if (existsSync(func)) {
      return
    }

    await mkdir(cache, { recursive: true })
    const stagingDir = await mkdtemp(join(cache, 'install-'))
    try {
      const archive = `Azure.Functions.Cli.${build}.zip`
      const url = `https://github.com/Azure/azure-functions-core-tools/releases/download/${version}/${archive}`
      const zip = join(stagingDir, archive)
      const extracted = join(stagingDir, 'bin')
      const options = { signal: AbortSignal.timeout(270_000) }

      await mkdir(extracted)
      await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--output', zip, url], options)
      if (process.platform === 'win32') {
        await exec('tar', ['-xf', zip, '-C', extracted], options)
      } else {
        await exec('unzip', ['-q', zip, '-d', extracted], options)
      }
      await chmod(join(extracted, executable), 0o755)

      // Publish the whole installation after extraction so parallel suites only see complete installs.
      try {
        await rename(extracted, installDir)
      } catch (error) {
        if (!existsSync(func)) {
          throw error
        }
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })

  return func
}

module.exports = { useAzureFunctionsCoreTools }
