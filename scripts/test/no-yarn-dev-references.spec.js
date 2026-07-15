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
const guardFile = 'scripts/test/no-yarn-dev-references.spec.js'
const allowedLinePatterns = new Map([
  ['ci/init.js', /PACKAGE_MANAGERS = \['npm', 'yarn', 'pnpm'\]/],
  ['packages/dd-trace/src/plugins/util/test.js', /npm-8\.15\.0 or yarn-1\.22\.19|'\.yarn'/],
  ['packages/dd-trace/src/ci-visibility/dynamic-instrumentation/index.js', /issues with yarn/],
  ['packages/dd-trace/src/appsec/recommended.json', /"(?:\/yarn\.lock|bin\/yarn)",/],
  ['requirements.json', /"yarn"|"Ignore the yarn CLI(?: \(symlink\))?"|"\*\/yarn(?:\.js)?"/],
  ['.gitlab/requirements_block.json', /"name": "yarn(?:-symlink)?".*"\/pathto\/yarn(?:\.js)?"/],
  ['packages/dd-trace/test/appsec/next.utils.js', /yarn install|yarn exec next build|'yarn\.lock'/],
  [
    'integration-tests/esbuild/openfeature.spec.js',
    /npm install -g yarn|installing with yarn|install with yarn|yarn would error|yarn --ignore-engines/,
  ],
  ['integration-tests/ci-visibility/test-optimization-startup.spec.js', /packageManagers = \['yarn', 'npm', 'pnpm'\]/],
  ['integration-tests/helpers/index.js', /yarn-linked|yarn link(?: dd-trace)?/],
  ['packages/dd-trace/test/plugins/versions/package.json', /"yarn": "1\.22\.22"/],
  ['.github/workflows/platform.yml', /name: yarn(?:-berry)?$|install: yarn add$|&& yarn (?:set|config|add)/],
  ['benchmark/sirun/runall.sh', /\$HOME\/\.yarn|dependencies\.yarn|yarn install --ignore-engines|yarn services/],
  ['.gitignore', /yarn\.lock$/],
  ['README.md', /^\$ yarn add dd-trace(?:@\d+)?(?: # .*)?$/],
  ['MIGRATING.md', /NODE_OPTIONS='-r dd-trace\/ci\/init' yarn test/],
  ['scripts/test/install-plugin-modules.spec.js', /removes yarn|bun \(not yarn\)/],
])
const allowedPrefixLinePatterns = new Map([
  ['packages/datadog-plugin-next/test/', /yarn install|yarn exec next build|'yarn\.lock'/],
])

/**
 * @param {string} file
 * @param {string} line
 */
function isAllowedLine (file, line) {
  if (file === guardFile) return true

  const pattern = allowedLinePatterns.get(file)
  if (pattern?.test(line.trim())) return true
  for (const [prefix, prefixPattern] of allowedPrefixLinePatterns) {
    if (file.startsWith(prefix) && prefixPattern.test(line.trim())) return true
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
        if (yarnPattern.test(lines[i]) && !isAllowedLine(file, lines[i])) {
          offendingMatches.push(`${file}:${i + 1}: ${lines[i].trim()}`)
        }
      }
    }

    assert.deepStrictEqual(offendingMatches, [])
    assert.strictEqual(isAllowedLine('.github/workflows/platform.yml', '- run: yarn install'), false)
  })

  it('enforces frozen installs, release-age cooldowns, and aligned dependency locks', () => {
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

    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    assert.strictEqual(packageJson.devDependencies.bun, '1.3.1')
    const nodeSetupAction = fs.readFileSync(path.join(repoRoot, '.github/actions/node/setup/action.yml'), 'utf8')
    const setupBunVersion = /npm install -g bun@(\d+\.\d+\.\d+)/.exec(nodeSetupAction)
    assert.ok(setupBunVersion)
    assert.strictEqual(setupBunVersion[1], packageJson.devDependencies.bun)

    const allGreenWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/all-green.yml'), 'utf8')
    const allGreenInstall = 'bun install --frozen-lockfile --ignore-scripts'
    assert.ok(allGreenWorkflow.includes(allGreenInstall))
    assert.match(allGreenWorkflow, /working-directory: \.github\/all-green/)
    assert.match(allGreenWorkflow, /ln -s \.\.\/\.github\/all-green\/node_modules scripts\/node_modules/)
    assert.ok(
      allGreenWorkflow.indexOf(allGreenInstall) <
        allGreenWorkflow.indexOf('uses: DataDog/dd-octo-sts-action@'),
      'all-green dependencies must be installed before minting the STS token'
    )
    const allGreenPackage = JSON.parse(fs.readFileSync(
      path.join(repoRoot, '.github/all-green/package.json'),
      'utf8'
    ))
    assert.deepStrictEqual(Object.keys(allGreenPackage.dependencies).sort(), [
      '@actions/core',
      '@actions/github',
      'octokit',
    ])
    assert.strictEqual(fs.existsSync(path.join(repoRoot, '.github/all-green/bun.lock')), true)

    const integrationHelpers = fs.readFileSync(path.join(repoRoot, 'integration-tests/helpers/index.js'), 'utf8')
    assert.match(integrationHelpers, /const \{ BUN, BUN_CONFIG, withBun \} = require\('\.\/bun'\)/)
    assert.match(integrationHelpers, /`--config=\$\{JSON\.stringify\(BUN_CONFIG\)\}`/)
    const platformWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/platform.yml'), 'utf8')
    assert.match(platformWorkflow, /bun --config="\$GITHUB_WORKSPACE\/bunfig\.toml" add --linker=hoisted/)
    const projectWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/project.yml'), 'utf8')
    assert.match(projectWorkflow, /bun --config=\/tmp\/dd-trace-bunfig\.toml install/)

    const actionPackage = JSON.parse(fs.readFileSync(
      path.join(repoRoot, '.github/actions/datadog-ci/package.json'),
      'utf8'
    ))
    const actionLock = JSON.parse(fs.readFileSync(
      path.join(repoRoot, '.github/actions/datadog-ci/package-lock.json'),
      'utf8'
    ))
    assert.strictEqual(
      actionLock.packages[''].dependencies['@datadog/datadog-ci'],
      actionPackage.dependencies['@datadog/datadog-ci']
    )

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
    assert.deepStrictEqual(bunUpdate.directories, ['/', '/docs', '/.github/all-green'])
    assert.strictEqual(actionUsesNpm, true)
  })
})
