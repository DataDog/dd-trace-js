'use strict'

// `scripts/install_plugin_modules.js:301` is the install line under test (`exec('bun install --trust', ...)`).
// `--linker=isolated` lives in `versions/bunfig.toml` so the isolation contract is structural, not a flag.
// The constrained PATH below removes yarn from the spawned child's lookup; a regression that re-introduces
// a yarn invocation would fail to launch instead of silently succeeding via `$PATH` lookup.

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const repoRoot = path.resolve(__dirname, '..', '..')
const installScript = path.join(repoRoot, 'scripts', 'install_plugin_modules.js')
const versionsDir = path.join(repoRoot, 'versions')
const bunBinDir = path.join(os.homedir(), '.bun', 'bin')

describe('scripts/install_plugin_modules.js', function () {
  this.timeout(180_000)

  before(() => {
    if (!fs.existsSync(versionsDir)) return
    for (const entry of fs.readdirSync(versionsDir)) {
      if (entry === 'bunfig.toml') continue
      fs.rmSync(path.join(versionsDir, entry), { recursive: true, force: true })
    }
  })

  it('installs every pino sandbox to a version satisfying its declared range, using bun (not yarn)', () => {
    const result = spawnSync(process.execPath, [installScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLUGINS: 'pino',
        PATH: `${bunBinDir}:/usr/bin:/bin`,
      },
    })

    assert.strictEqual(
      result.status,
      0,
      `install_plugin_modules.js exited with status ${result.status} (signal ${result.signal}).\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    )

    const sandboxFolders = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('pino@'))
      .map(entry => entry.name)
      .sort()

    assert.ok(
      sandboxFolders.length >= 4,
      `expected at least four pino@<ver> sandboxes (two ranges × {coerced, raw}), got: ${sandboxFolders.join(', ')}`
    )

    const resolvedVersions = {}
    const expectedVersions = {}
    for (const folder of sandboxFolders) {
      const pkgPath = path.join(versionsDir, folder, 'node_modules', 'pino', 'package.json')
      const resolved = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
      const declaredRange = folder.slice('pino@'.length)
      resolvedVersions[folder] = resolved
      expectedVersions[folder] = semver.satisfies(resolved, declaredRange)
        ? resolved
        : `range '${declaredRange}' violated by '${resolved}'`
    }

    assert.deepStrictEqual(resolvedVersions, expectedVersions)
  })
})
