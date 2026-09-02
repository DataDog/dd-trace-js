'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { getBunBinary } = require('../bun')

const repoRoot = path.resolve(__dirname, '..', '..')
const bunScript = path.join(repoRoot, 'scripts', 'bun.js')
const bunVersion = require('../../package.json').devDependencies.bun
const bootstrapDirectory = path.join(repoRoot, 'node_modules', '.cache', `bun-${bunVersion}`)

/**
 * @param {string} directory
 * @param {string} command
 */
function createWrongBunCommand (directory, command) {
  const commandPath = path.join(directory, command)
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, commandPath)
  } else {
    fs.symlinkSync(process.execPath, commandPath)
  }
}

describe('scripts/bun.js', function () {
  this.timeout(120_000)

  it('prints a runnable binary at the pinned version', () => {
    const binaryDirectory = path.join(repoRoot, 'node_modules', '.bin')
    const env = { ...process.env, PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH}` }
    const result = spawnSync(process.execPath, [bunScript], { encoding: 'utf8', env })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(
      execFileSync(result.stdout, ['--version'], { encoding: 'utf8', env }).trim(),
      bunVersion
    )
  })

  it('bootstraps pinned Bun when PATH does not contain it', () => {
    const backupDirectory = `${bootstrapDirectory}.backup-${process.pid}`
    const commandDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-fake-bun-'))
    const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun'
    const originalNpmExecPath = process.env.npm_execpath
    const originalPath = process.env.PATH
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

    try {
      if (fs.existsSync(bootstrapDirectory)) fs.renameSync(bootstrapDirectory, backupDirectory)
      const globalNpmRoot = execFileSync(npm, ['root', '--global'], { encoding: 'utf8' }).trim()
      process.env.npm_execpath = path.join(globalNpmRoot, 'npm', 'bin', 'npm-cli.js')
      createWrongBunCommand(commandDirectory, bunCommand)
      process.env.PATH = `${commandDirectory}${path.delimiter}${originalPath}`

      const bunBinary = getBunBinary()

      assert.strictEqual(bunBinary, path.join(bootstrapDirectory, 'node_modules', 'bun', 'bin', 'bun.exe'))
      assert.strictEqual(execFileSync(bunBinary, ['--version'], { encoding: 'utf8' }).trim(), bunVersion)
      assert.strictEqual(getBunBinary(), bunBinary)
      const bootstrapPackage = JSON.parse(fs.readFileSync(path.join(bootstrapDirectory, 'package.json'), 'utf8'))
      assert.strictEqual(bootstrapPackage.allowScripts[`bun@${bunVersion}`], true)
      assert.strictEqual(fs.existsSync(path.join(bootstrapDirectory, 'package-lock.json')), false)
    } finally {
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath
      } else {
        process.env.npm_execpath = originalNpmExecPath
      }
      process.env.PATH = originalPath
      fs.rmSync(commandDirectory, { recursive: true, force: true })
      fs.rmSync(bootstrapDirectory, { recursive: true, force: true })
      if (fs.existsSync(backupDirectory)) fs.renameSync(backupDirectory, bootstrapDirectory)
    }
  })

  it('fails when bootstrapping does not produce a runnable binary', () => {
    const backupDirectory = `${bootstrapDirectory}.backup-${process.pid}`
    const commandDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-fake-bun-'))
    const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun'
    const fakeNpm = path.join(tmpdir(), `dd-fake-npm-${process.pid}.js`)
    const originalNpmExecPath = process.env.npm_execpath
    const originalPath = process.env.PATH

    try {
      if (fs.existsSync(bootstrapDirectory)) fs.renameSync(bootstrapDirectory, backupDirectory)
      fs.writeFileSync(fakeNpm, '')
      createWrongBunCommand(commandDirectory, bunCommand)
      process.env.npm_execpath = fakeNpm
      process.env.PATH = `${commandDirectory}${path.delimiter}${originalPath}`

      assert.throws(() => getBunBinary(), /Could not install Bun/)
    } finally {
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath
      } else {
        process.env.npm_execpath = originalNpmExecPath
      }
      process.env.PATH = originalPath
      fs.rmSync(fakeNpm, { force: true })
      fs.rmSync(commandDirectory, { recursive: true, force: true })
      fs.rmSync(bootstrapDirectory, { recursive: true, force: true })
      if (fs.existsSync(backupDirectory)) fs.renameSync(backupDirectory, bootstrapDirectory)
    }
  })
})
