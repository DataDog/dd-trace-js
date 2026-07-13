'use strict'

// Walks tracked files and fails if `yarn` appears outside the allowlist. The allowlist pins
// product-code yarn-as-user-PM detection, user-PM test fixtures, and user-facing docs; every
// other yarn reference was dev tooling that has since moved to bun and npm.

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const yaml = require('yaml')

const repoRoot = path.resolve(__dirname, '..', '..')

const ALLOWLIST_EXACT = new Set([
  // Product code: dd-trace detects yarn at runtime as a user package manager.
  'ci/init.js',
  'packages/dd-trace/src/plugins/util/test.js',
  'packages/dd-trace/src/ci-visibility/dynamic-instrumentation/index.js',
  'packages/dd-trace/src/appsec/recommended.json',
  'requirements.json',
  '.gitlab/requirements_block.json',

  // User-PM test fixtures: yarn runs as the user's package manager inside the sandbox under test.
  'packages/dd-trace/test/appsec/next.utils.js',
  'integration-tests/esbuild/openfeature.spec.js',
  'integration-tests/ci-visibility/test-optimization-startup.spec.js',
  'integration-tests/helpers/index.js',
  'packages/dd-trace/test/plugins/versions/package.json',
  '.github/workflows/platform.yml',

  // Benchmark comparisons execute the baseline's pre-migration installer against the baseline source.
  'benchmark/sirun/runall.sh',

  // .gitignore tracks the per-fixture yarn.lock paths so they don't accidentally land in git.
  '.gitignore',

  // User-facing docs: yarn is still a popular user package manager and appears beside npm/pnpm.
  'README.md',
  'MIGRATING.md',

  // Regression tests that pin the dev-tooling migration.
  'scripts/test/install-plugin-modules.spec.js',
  'scripts/test/no-yarn-dev-references.spec.js',
])

const ALLOWLIST_PREFIXES = [
  // The next plugin tests spawn yarn-as-user-PM for the build step.
  'packages/datadog-plugin-next/test/',
]

/**
 * @param {string} file
 */
function isAllowed (file) {
  if (ALLOWLIST_EXACT.has(file)) return true
  for (const prefix of ALLOWLIST_PREFIXES) {
    if (file.startsWith(prefix)) return true
  }
  return false
}

function listTrackedFiles () {
  const stdout = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
  return stdout.toString('utf8').split('\0').filter(Boolean)
}

/**
 * Same NUL-byte-in-first-8-KiB heuristic git uses for its `core.binary` decision; covers images,
 * native libraries, and other tracked binaries without parsing every encoding.
 *
 * @param {Buffer} buf
 */
function isBinary (buf) {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

const yarnPattern = /\byarn\b/

describe('no yarn dev references', function () {
  this.timeout(60_000)

  it('contains no yarn dev-tooling references outside the allowlist', () => {
    const files = listTrackedFiles()

    /** @type {string[]} */
    const offendingMatches = []

    for (const file of files) {
      if (isAllowed(file)) continue

      const full = path.join(repoRoot, file)

      let stat
      try {
        stat = fs.lstatSync(full)
      } catch {
        // Tracked but missing on disk (broken symlink, sparse checkout). Nothing to scan.
        continue
      }
      // Skip symlinks (the symlink target is tracked separately and walked on its own) and
      // anything that isn't a plain file (gitlinks, sockets).
      if (!stat.isFile()) continue

      let buf
      try {
        buf = fs.readFileSync(full)
      } catch {
        continue
      }
      if (isBinary(buf)) continue

      const text = buf.toString('utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (yarnPattern.test(lines[i])) {
          offendingMatches.push(`${file}:${i + 1}: ${lines[i].trim()}`)
        }
      }
    }

    assert.deepStrictEqual(offendingMatches, [])
  })

  it('enforces frozen installs and release-age cooldowns', () => {
    const installAction = fs.readFileSync(path.join(repoRoot, '.github/actions/install/action.yml'), 'utf8')
    assert.match(installAction, /command: bun install --frozen-lockfile --linker=hoisted/)
    assert.doesNotMatch(installAction, /command: bun install [^\n]*--trust/)

    const rootBunConfig = fs.readFileSync(path.join(repoRoot, 'bunfig.toml'), 'utf8')
    assert.match(rootBunConfig, /^minimumReleaseAge = 259200$/m)
    assert.doesNotMatch(rootBunConfig, /@datadog\/\*/)
    for (const packageName of [
      '@datadog/flagging-core',
      '@datadog/libdatadog',
      '@datadog/native-appsec',
      '@datadog/native-iast-taint-tracking',
      '@datadog/native-metrics',
      '@datadog/openfeature-node-server',
      '@datadog/pprof',
      '@datadog/wasm-js-rewriter',
    ]) {
      assert.ok(rootBunConfig.includes(`"${packageName}"`), `${packageName} must bypass the release-age gate`)
    }

    const versionsBunConfig = fs.readFileSync(path.join(repoRoot, 'versions/bunfig.toml'), 'utf8')
    assert.match(versionsBunConfig, /^minimumReleaseAge = 259200$/m)

    const dependabot = yaml.parse(fs.readFileSync(path.join(repoRoot, '.github/dependabot.yml'), 'utf8'))
    let bunUpdate
    let actionUsesNpm = false
    for (const update of dependabot.updates) {
      if (update['package-ecosystem'] === 'bun') {
        bunUpdate = update
      } else if (update['package-ecosystem'] === 'npm' &&
        update.directory === '/.github/actions/datadog-ci') {
        actionUsesNpm = true
      }
    }
    assert.ok(bunUpdate)
    assert.deepStrictEqual(bunUpdate.directories, ['/', '/docs'])
    assert.strictEqual(actionUsesNpm, true)
  })
})
