'use strict'

// Walks tracked files and fails if `yarn` appears outside the allowlist. The allowlist pins
// product-code yarn-as-user-PM detection, user-PM test fixtures, and user-facing docs; every
// other yarn reference was dev tooling that has since moved to bun and npm.

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const yaml = require('yaml')

const { getBunBinary } = require('../bun')

const repoRoot = path.resolve(__dirname, '..', '..')
const guardFile = 'scripts/test/no-yarn-dev-references.spec.js'
const allowedLinePatterns = new Map([
  ['ci/init.js', /PACKAGE_MANAGERS = \['npm', 'yarn', 'pnpm'\]/],
  ['packages/dd-trace/src/plugins/util/test.js', /npm-8\.15\.0 or yarn-1\.22\.19|'\.yarn'/],
  ['packages/dd-trace/src/ci-visibility/dynamic-instrumentation/index.js', /issues with yarn/],
  ['packages/dd-trace/src/appsec/recommended.json', /"(?:\/yarn\.lock|bin\/yarn)",/],
  ['requirements.json', /"yarn"|"Ignore the yarn CLI(?: \(symlink\))?"|"\*\/yarn(?:\.js)?"/],
  ['.gitlab/requirements_block.json', /"name": "yarn(?:-symlink)?".*"\/pathto\/yarn(?:\.js)?"/],
  [
    'integration-tests/esbuild/openfeature.spec.js',
    /npm install -g yarn|installing with yarn|install with yarn|yarn would error|yarn --ignore-engines/,
  ],
  ['integration-tests/ci-visibility/test-optimization-startup.spec.js', /packageManagers = \['yarn', 'npm', 'pnpm'\]/],
  ['integration-tests/helpers/index.js', /yarn-linked|yarn link(?: dd-trace)?/],
  ['packages/dd-trace/test/plugins/versions/package.json', /"yarn": "1\.22\.22"/],
  ['.github/workflows/platform.yml', /name: yarn(?:-berry)?$|install: yarn add$|&& yarn (?:set|config|add)/],
  ['benchmark/sirun/runall.sh', /\$HOME\/\.yarn|dependencies\.yarn|yarn install --ignore-engines|yarn services/],
  ['README.md', /^\$ yarn add dd-trace(?:@\d+)?(?: # .*)?$/],
  ['MIGRATING.md', /NODE_OPTIONS='-r dd-trace\/ci\/init' yarn test/],
  ['scripts/test/install-plugin-modules.spec.js', /removes yarn|bun \(not yarn\)/],
])
const allowedPathPatterns = [
  [
    /^ci\/(?:diagnose\.js|runbook\.md|test-optimization-validation-manifest\.schema\.json|test-optimization-validation\/)/,
    /yarn/i,
  ],
  [
    /^packages\/dd-trace\/test\/ci-visibility\/(?:ci-wiring|manifest-scaffold|validation-execution-phases)\.spec\.js$/,
    /yarn/i,
  ],
]

/**
 * @param {string} file
 * @param {string} line
 */
function isAllowedLine (file, line) {
  if (file === guardFile) return true

  const pattern = allowedLinePatterns.get(file)
  if (pattern?.test(line.trim())) return true
  for (const [pathPattern, linePattern] of allowedPathPatterns) {
    if (pathPattern.test(file) && linePattern.test(line.trim())) return true
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

  it('packs a complete artifact from a clean checkout', () => {
    const archiveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-pack-'))
    const indexTypesPath = path.join(repoRoot, 'index.d.ts')
    const originalIndexTypes = fs.readFileSync(indexTypesPath)
    const vendorDistPath = path.join(repoRoot, 'vendor', 'dist')
    const vendorDistBackupPath = path.join(repoRoot, 'vendor', `.dist-backup-${process.pid}`)
    const { name, version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

    try {
      if (fs.existsSync(vendorDistPath)) {
        fs.renameSync(vendorDistPath, vendorDistBackupPath)
      }

      const filename = execFileSync(
        npm,
        ['pack', '--silent', '--pack-destination', archiveDirectory],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, npm_config_loglevel: 'silent' },
        }
      ).trim()

      assert.strictEqual(filename, `${name}-${version}.tgz`)
      const archivePath = path.join(archiveDirectory, filename)
      assert.ok(fs.statSync(archivePath).size > 0)
      const archiveFiles = new Set(
        execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }).split('\n')
      )
      assert.ok(archiveFiles.has('package/vendor/dist/limiter/index.js'))
      assert.ok(archiveFiles.has('package/vendor/dist/istanbul-lib-coverage/index.js'))
    } finally {
      fs.writeFileSync(indexTypesPath, originalIndexTypes)
      fs.rmSync(archiveDirectory, { recursive: true, force: true })
      fs.rmSync(vendorDistPath, { recursive: true, force: true })
      if (fs.existsSync(vendorDistBackupPath)) {
        fs.renameSync(vendorDistBackupPath, vendorDistPath)
      }
    }
  })

  it('prepares the frozen vendor tree outside npm pack', () => {
    execFileSync(process.execPath, ['scripts/prepare.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        npm_command: 'install',
        PATH: [path.join(repoRoot, 'node_modules', '.bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    })
  })

  it('bootstraps pinned Bun when PATH does not contain the pinned version', async () => {
    const { bun: bunVersion } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      .devDependencies
    const bootstrapDirectory = path.join(repoRoot, 'node_modules', '.cache', `bun-${bunVersion}`)
    const backupDirectory = `${bootstrapDirectory}.backup-${process.pid}`
    const commandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fake-bun-'))
    const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun'
    const originalNpmExecPath = process.env.npm_execpath
    const originalPath = process.env.PATH
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

    try {
      if (fs.existsSync(bootstrapDirectory)) {
        fs.renameSync(bootstrapDirectory, backupDirectory)
      }
      const globalNpmRoot = execFileSync(npm, ['root', '--global'], { encoding: 'utf8' }).trim()
      process.env.npm_execpath = path.join(globalNpmRoot, 'npm', 'bin', 'npm-cli.js')
      fs.linkSync(process.execPath, path.join(commandDirectory, bunCommand))
      process.env.PATH = [commandDirectory, originalPath].filter(Boolean).join(path.delimiter)
      const bunBinary = getBunBinary()

      assert.strictEqual(await Promise.resolve(bunBinary), path.join(
        bootstrapDirectory,
        'node_modules',
        'bun',
        'bin',
        'bun.exe'
      ))
      assert.strictEqual(execFileSync(bunBinary, ['--version'], { encoding: 'utf8' }).trim(), bunVersion)
      assert.strictEqual(getBunBinary(), bunBinary)
      const bootstrapPackage = JSON.parse(
        fs.readFileSync(path.join(bootstrapDirectory, 'package.json'), 'utf8')
      )
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
      if (fs.existsSync(backupDirectory)) {
        fs.renameSync(backupDirectory, bootstrapDirectory)
      }
    }
  })

  it('fails when the pinned Bun bootstrap does not produce a runnable binary', () => {
    const { bun: bunVersion } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      .devDependencies
    const bootstrapDirectory = path.join(repoRoot, 'node_modules', '.cache', `bun-${bunVersion}`)
    const backupDirectory = `${bootstrapDirectory}.backup-${process.pid}`
    const commandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fake-bun-'))
    const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun'
    const fakeNpm = path.join(os.tmpdir(), `dd-fake-npm-${process.pid}.js`)
    const originalNpmExecPath = process.env.npm_execpath
    const originalPath = process.env.PATH

    try {
      if (fs.existsSync(bootstrapDirectory)) {
        fs.renameSync(bootstrapDirectory, backupDirectory)
      }
      fs.writeFileSync(fakeNpm, '')
      fs.linkSync(process.execPath, path.join(commandDirectory, bunCommand))
      process.env.npm_execpath = fakeNpm
      process.env.PATH = [commandDirectory, originalPath].filter(Boolean).join(path.delimiter)

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
      if (fs.existsSync(backupDirectory)) {
        fs.renameSync(backupDirectory, bootstrapDirectory)
      }
    }
  })

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
    const versionsBunConfig = fs.readFileSync(path.join(repoRoot, 'versions/bunfig.toml'), 'utf8')
    assert.match(versionsBunConfig, /^minimumReleaseAge = 259200$/m)
    const internalPackages = [
      '@datadog/datadog-ci',
      '@datadog/flagging-core',
      '@datadog/libdatadog',
      '@datadog/native-appsec',
      '@datadog/native-iast-taint-tracking',
      '@datadog/native-metrics',
      '@datadog/openfeature-node-server',
      '@datadog/pprof',
      '@datadog/sketches-js',
      '@datadog/wasm-js-rewriter',
    ]
    for (const packageName of internalPackages) {
      for (const bunConfig of [rootBunConfig, versionsBunConfig]) {
        assert.ok(bunConfig.includes(`"${packageName}"`), `${packageName} must bypass the release-age gate`)
      }
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    assert.strictEqual(packageJson.devDependencies.bun, '1.3.14')
    const nodeSetupAction = fs.readFileSync(path.join(repoRoot, '.github/actions/node/setup/action.yml'), 'utf8')
    const setupBunVersion = /npm install -g bun@(\d+\.\d+\.\d+)/.exec(nodeSetupAction)
    assert.ok(setupBunVersion)
    assert.strictEqual(setupBunVersion[1], packageJson.devDependencies.bun)
    const playwrightDockerfile = fs.readFileSync(path.join(repoRoot, '.github/playwright/Dockerfile'), 'utf8')
    const dockerBunVersion = /^FROM oven\/bun:(\d+\.\d+\.\d+)@/m.exec(playwrightDockerfile)
    assert.ok(dockerBunVersion)
    assert.strictEqual(dockerBunVersion[1], packageJson.devDependencies.bun)
    assert.strictEqual(packageJson.scripts.prepare, 'node scripts/prepare.js')
    const prepareScript = fs.readFileSync(path.join(repoRoot, 'scripts/prepare.js'), 'utf8')
    assert.doesNotMatch(prepareScript, /npm_command/)
    assert.match(prepareScript, /getBunBinary\(\)/)
    const bunHelper = fs.readFileSync(path.join(repoRoot, 'scripts/bun.js'), 'utf8')
    assert.match(bunHelper, /devDependencies\.bun/)
    assert.match(bunHelper, /--package-lock=false/)
    assert.match(bunHelper, /--include=optional/)
    assert.match(bunHelper, /--ignore-scripts=false/)
    assert.match(bunHelper, /allowScripts/)
    assert.match(bunHelper, /node_modules.*\.cache/)

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
    const systemTestsWorkflow = yaml.parse(fs.readFileSync(
      path.join(repoRoot, '.github/workflows/system-tests.yml'),
      'utf8'
    ))
    const buildArtifactSteps = systemTestsWorkflow.jobs['build-artifacts'].steps
    const packStep = buildArtifactSteps.find(step => step.name === 'Pack dd-trace-js')
    assert.ok(packStep)
    assert.match(packStep.run, /filename=\$\(npm pack --silent --pack-destination binaries\)/)
    assert.match(packStep.run, /test -f "binaries\/\$filename"/)
    const ociPackScript = fs.readFileSync(path.join(repoRoot, '.gitlab/prepare-oci-package.sh'), 'utf8')
    assert.match(ociPackScript, /^archive=\$\(npm pack --silent\)$/m)
    assert.match(ociPackScript, /^bun=\$\(node -e .*getBunBinary/m)
    assert.match(ociPackScript, /^tar -xOf "\$archive" package\/package\.json > packaging\/sources\/package\.json$/m)
    assert.match(ociPackScript, /^cp bun\.lock packaging\/sources\/bun\.lock$/m)
    assert.match(
      ociPackScript,
      /^"\$bun" --config="\$PWD\/bunfig\.toml" install --production --frozen-lockfile --ignore-scripts /m
    )
    assert.match(ociPackScript, /-C packaging\/sources\/node_modules\/dd-trace$/m)
    assert.doesNotMatch(ociPackScript, /^npm pack$/m)
    assert.doesNotMatch(ociPackScript, /^npm install --global/m)
    assert.doesNotMatch(ociPackScript, /^npm install --prefix/m)

    const internalLockDirectories = [
      '.github/actions/datadog-ci',
      '.github/all-green',
      'docs',
      'vendor',
    ]
    for (const directory of internalLockDirectories) {
      assert.strictEqual(fs.existsSync(path.join(repoRoot, directory, 'bun.lock')), true)
      assert.strictEqual(fs.existsSync(path.join(repoRoot, directory, 'package-lock.json')), false)
      assert.strictEqual(fs.existsSync(path.join(repoRoot, directory, 'yarn.lock')), false)
    }

    const datadogCiAction = fs.readFileSync(
      path.join(repoRoot, '.github/actions/datadog-ci/action.yml'),
      'utf8'
    )
    assert.match(
      datadogCiAction,
      /bun --config="\$\{\{ github\.workspace \}\}\/bunfig\.toml" install --frozen-lockfile --ignore-scripts/
    )

    const dependabot = yaml.parse(fs.readFileSync(path.join(repoRoot, '.github/dependabot.yml'), 'utf8'))
    const bunDirectories = new Set()
    for (const update of dependabot.updates) {
      if (update['package-ecosystem'] === 'bun') {
        for (const directory of update.directories ?? [update.directory]) {
          bunDirectories.add(directory)
        }
      }
    }
    assert.deepStrictEqual(
      [...bunDirectories].filter(directory => internalLockDirectories.some(
        internalDirectory => directory === `/${internalDirectory}`
      )).sort(),
      internalLockDirectories.map(directory => `/${directory}`).sort()
    )
    assert.ok(bunDirectories.has('/'))
  })

  it('audits every committed Bun dependency tree', () => {
    const auditWorkflow = yaml.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/audit.yml'), 'utf8'))
    const lockPaths = [
      '.github/actions/datadog-ci/bun.lock',
      '.github/all-green/bun.lock',
      'bun.lock',
      'docs/bun.lock',
      'vendor/bun.lock',
    ]
    assert.deepStrictEqual(auditWorkflow.on.pull_request.paths.sort(), lockPaths)
    assert.deepStrictEqual(
      auditWorkflow.jobs.dependencies.strategy.matrix.directory.sort(),
      ['.', '.github/actions/datadog-ci', '.github/all-green', 'docs', 'vendor']
    )
    const auditCommand = auditWorkflow.jobs.dependencies.steps.at(-1).run
    assert.match(auditCommand, /^bun audit --audit-level=high/m)
    assert.deepStrictEqual(
      [...auditCommand.matchAll(/--ignore (GHSA-[\w-]+)/g)].map(match => match[1]),
      [
        'GHSA-vxpw-j846-p89q',
        'GHSA-hmw2-7cc7-3qxx',
        'GHSA-5c6j-r48x-rmvq',
        'GHSA-j3q9-mxjg-w52f',
      ]
    )
  })
})
