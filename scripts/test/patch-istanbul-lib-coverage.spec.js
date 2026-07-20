'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')
const relativeTarget = path.join('lib', 'file-coverage.js')
const rootPatchScript = path.join(repoRoot, 'scripts', 'patch-istanbul-lib-coverage.js')
const rootInstalledTarget = path.join(repoRoot, 'node_modules', 'istanbul-lib-coverage', relativeTarget)

/**
 * @param {string} fixtureRoot
 */
function createSourceFixture (fixtureRoot) {
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'packages', 'datadog-instrumentations'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'integration-tests', 'coverage'), { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, 'eslint.config.mjs'), '')
  fs.writeFileSync(path.join(fixtureRoot, 'integration-tests', 'coverage', 'merge-lcov.js'), '')
  fs.copyFileSync(
    rootPatchScript,
    path.join(fixtureRoot, 'scripts', 'patch-istanbul-lib-coverage.js')
  )
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'replace-file.js'),
    path.join(fixtureRoot, 'scripts', 'replace-file.js')
  )
}

describe('patch-istanbul-lib-coverage', function () {
  this.timeout(60_000)

  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-istanbul-patch-'))
    createSourceFixture(fixtureDirectory)
    fs.writeFileSync(path.join(fixtureDirectory, 'package.json'), JSON.stringify({
      dependencies: {
        'istanbul-lib-coverage': '3.2.2',
      },
    }))
  })

  afterEach(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('does not mutate Bun hardlink cache entries', async () => {
    const cachedTarget = path.join(fixtureDirectory, 'istanbul-lib-coverage-cache.js')
    const backupTarget = `${rootInstalledTarget}.backup-${process.pid}`
    fs.mkdirSync(path.dirname(cachedTarget), { recursive: true })
    const sourceTarget = path.join(
      repoRoot, 'vendor', 'node_modules', 'istanbul-lib-coverage', relativeTarget
    )
    fs.copyFileSync(sourceTarget, cachedTarget)
    fs.renameSync(rootInstalledTarget, backupTarget)
    fs.linkSync(cachedTarget, rootInstalledTarget)
    const originalCacheSource = fs.readFileSync(cachedTarget, 'utf8')

    try {
      delete require.cache[rootPatchScript]
      require(rootPatchScript)

      assert.match(fs.readFileSync(rootInstalledTarget, 'utf8'), /dd-trace-js patch v2/)
      assert.strictEqual(await Promise.resolve(fs.readFileSync(cachedTarget, 'utf8')), originalCacheSource)
    } finally {
      fs.rmSync(rootInstalledTarget, { force: true })
      fs.renameSync(backupTarget, rootInstalledTarget)
      delete require.cache[rootPatchScript]
    }
  })

  it('skips when the package is not installed locally', () => {
    const backupTarget = `${rootInstalledTarget}.backup-${process.pid}`
    fs.renameSync(rootInstalledTarget, backupTarget)

    try {
      delete require.cache[rootPatchScript]
      require(rootPatchScript)
      assert.strictEqual(fs.existsSync(rootInstalledTarget), false)
    } finally {
      fs.renameSync(backupTarget, rootInstalledTarget)
      delete require.cache[rootPatchScript]
    }
  })

  it('does not patch dependencies from the parent application', async () => {
    const packageRoot = path.join(fixtureDirectory, 'node_modules', 'dd-trace')
    createSourceFixture(packageRoot)

    const parentTarget = path.join(fixtureDirectory, 'node_modules', 'istanbul-lib-coverage', relativeTarget)
    fs.mkdirSync(path.dirname(parentTarget), { recursive: true })
    const sourceTarget = path.join(
      repoRoot, 'vendor', 'node_modules', 'istanbul-lib-coverage', relativeTarget
    )
    fs.copyFileSync(sourceTarget, parentTarget)
    const originalParentSource = fs.readFileSync(parentTarget, 'utf8')

    execFileSync(process.execPath, ['scripts/patch-istanbul-lib-coverage.js'], {
      cwd: packageRoot,
    })

    assert.strictEqual(
      await Promise.resolve(fs.readFileSync(parentTarget, 'utf8')),
      originalParentSource
    )
  })
})
