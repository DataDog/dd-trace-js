'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  checkInstalledPackage,
  getInstalledPackageFailure,
} = require('../../../../ci/test-optimization-validation/package-check')

describe('test optimization validation installed package check', () => {
  let root

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-package-check-')))
    fs.mkdirSync(path.join(root, 'ci'))
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('loads the installed initialization entrypoint without initializing tracing', () => {
    fs.writeFileSync(path.join(root, 'ci', 'init.js'), 'module.exports = {}\n')

    const result = checkInstalledPackage({ packageRoot: root })

    assert.strictEqual(result.ok, true)
    assert.match(result.diagnosis, /loaded its Test Optimization initialization entrypoint/)
  })

  it('does not inherit an ambient NODE_OPTIONS preload', () => {
    const markerPath = path.join(root, 'ambient-preload-ran')
    const preloadPath = path.join(root, 'ambient-preload.js')
    const originalNodeOptions = process.env.NODE_OPTIONS
    fs.writeFileSync(path.join(root, 'ci', 'init.js'), 'module.exports = {}\n')
    fs.writeFileSync(preloadPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')\n`)
    process.env.NODE_OPTIONS = `--require=${preloadPath}`

    try {
      const result = checkInstalledPackage({ packageRoot: root })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(fs.existsSync(markerPath), false)
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }
  })

  it('classifies a missing runtime dependency as an installed-package blocker', () => {
    fs.writeFileSync(
      path.join(root, 'ci', 'init.js'),
      "require('dd-validation-intentionally-missing-dependency')\n"
    )

    const result = checkInstalledPackage({ packageRoot: root })
    const failure = getInstalledPackageFailure({ id: 'mocha:fixture' }, result)

    assert.strictEqual(result.ok, false)
    assert.match(result.diagnosis, /Cannot find module/)
    assert.strictEqual(failure.status, 'blocked')
    assert.strictEqual(failure.evidence.installedPackageIncomplete, true)
    assert.match(failure.diagnosis, /No project test was run/)
    assert.match(failure.evidence.recommendation, /normal dependency workflow/)
  })
})
