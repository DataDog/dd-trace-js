'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { inspect } = require('node:util')

const libCoverage = require('istanbul-lib-coverage')

const { installPatch } = require('./coverage/patch-child-process')
const {
  DISABLE_ENV,
  ROOT_ENV,
  V8_COVERAGE_ENV,
  canonicalizePath,
  getCollectorRoot,
  getMergedReportDir,
  getV8CoverageDir,
  isCoverageActive,
  resolveCoverageRoot,
} = require('./coverage/runtime')

describe('integration coverage child process hook', () => {
  let appRoot
  let coverageRoot
  let prevRoot
  let prevV8

  before(async () => {
    appRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-trace-coverage-'))
    coverageRoot = path.join(appRoot, 'node_modules', 'dd-trace')
    await fsp.mkdir(path.join(coverageRoot, 'packages', 'dd-trace', 'src'), { recursive: true })
    await fsp.mkdir(path.join(coverageRoot, 'integration-tests', 'coverage'), { recursive: true })
    await fsp.mkdir(path.join(appRoot, 'coverage-fixtures'), { recursive: true })

    await fsp.copyFile(
      path.join(process.cwd(), 'package.json'),
      path.join(coverageRoot, 'package.json')
    )
    await fsp.writeFile(path.join(coverageRoot, 'packages', 'dd-trace', 'src', 'id.js'), `
'use strict'

let next = 1

module.exports = function id () {
  return next++
}
`)
    await fsp.writeFile(path.join(appRoot, 'coverage-fixtures', 'parent.js'), `
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')

const id = require('../node_modules/dd-trace/packages/dd-trace/src/id')

id()
fs.writeFileSync(path.join(__dirname, 'parent-debug.json'), JSON.stringify({
  v8Dir: process.env.${V8_COVERAGE_ENV} || '',
  nodeOptions: process.env.NODE_OPTIONS || '',
}))

const child = fork(path.join(__dirname, 'worker.js'), { stdio: 'pipe' })

child.on('exit', code => {
  process.exit(code)
})
`)
    await fsp.writeFile(path.join(appRoot, 'coverage-fixtures', 'worker.js'), `
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const id = require('../node_modules/dd-trace/packages/dd-trace/src/id')

id()
fs.writeFileSync(path.join(__dirname, 'worker-debug.json'), JSON.stringify({
  v8Dir: process.env.${V8_COVERAGE_ENV} || '',
  nodeOptions: process.env.NODE_OPTIONS || '',
}))
`)

    prevRoot = process.env[ROOT_ENV]
    prevV8 = process.env[V8_COVERAGE_ENV]
    process.env[ROOT_ENV] = coverageRoot
    // Point this process' coverage var at the collector, mirroring what run-suite.js does, so the
    // child-process patch has a directory to propagate.
    process.env[V8_COVERAGE_ENV] = getV8CoverageDir()
    installPatch()
  })

  after(async () => {
    if (prevRoot === undefined) delete process.env[ROOT_ENV]
    else process.env[ROOT_ENV] = prevRoot
    if (prevV8 === undefined) delete process.env[V8_COVERAGE_ENV]
    else process.env[V8_COVERAGE_ENV] = prevV8

    await fsp.rm(appRoot, { force: true, recursive: true })
  })

  it('propagates the V8 coverage directory and bootstrap through fork to a grandchild', async () => {
    childProcess.execFileSync(process.execPath, [path.join(appRoot, 'coverage-fixtures', 'parent.js')], {
      cwd: appRoot,
      env: process.env,
      stdio: 'pipe',
    })

    const fixturesDir = path.join(appRoot, 'coverage-fixtures')
    const parentDebug = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'parent-debug.json'), 'utf8'))
    const workerDebug = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'worker-debug.json'), 'utf8'))

    // Both processes must see NODE_V8_COVERAGE so V8 records them, and both must carry the
    // bootstrap require so the patch keeps flowing into any deeper custom-env spawn.
    assert.equal(parentDebug.v8Dir, getV8CoverageDir())
    assert.equal(workerDebug.v8Dir, getV8CoverageDir())
    assert.ok(parentDebug.nodeOptions.includes('child-bootstrap.js'), `Got: ${inspect(parentDebug.nodeOptions)}`)
    assert.ok(workerDebug.nodeOptions.includes('child-bootstrap.js'), `Got: ${inspect(workerDebug.nodeOptions)}`)
  })

  it('converts raw V8 profiles in a directory into a merged lcov report', async () => {
    // Generate a real V8 profile, then exercise the shared converter directly against the directory
    // that actually received it. When this spec runs inside the integration coverage harness the
    // patched child_process rewrites NODE_V8_COVERAGE to the ambient collector; otherwise our
    // explicit dir is used. Either way we convert from the directory that has the profile.
    const explicitDir = path.join(appRoot, 'v8-profiles')
    await fsp.mkdir(explicitDir, { recursive: true })
    childProcess.execFileSync(process.execPath, [path.join(appRoot, 'coverage-fixtures', 'parent.js')], {
      cwd: appRoot,
      env: { ...process.env, [V8_COVERAGE_ENV]: explicitDir },
      stdio: 'pipe',
    })

    const v8Dir = isCoverageActive() ? getV8CoverageDir() : explicitDir
    const profiles = fs.existsSync(v8Dir) ? fs.readdirSync(v8Dir).filter(n => n.endsWith('.json')) : []
    assert.ok(profiles.length > 0, `expected raw V8 coverage profiles in ${v8Dir}`)

    // The converter reads every profile in the directory and reports how many it processed. We
    // assert on that count rather than on a specific source file: the fake sandbox's dd-trace sits
    // outside REPO_ROOT (so it's correctly excluded), and the set of in-scope files depends on
    // whether the ambient harness mixed real repo profiles in.
    const outputDir = path.join(appRoot, 'merged-report')
    const { convertV8DirToReport } = require('./coverage/merge-lcov')
    const result = await convertV8DirToReport(v8Dir, outputDir)
    assert.ok(result.profiles > 0, 'converter should read the raw profiles')
    // A non-empty report is written iff at least one in-scope file was covered; an all-excluded run
    // drops a `.skipped` sentinel instead. Exactly one of the two must exist.
    const wroteLcov = fs.existsSync(path.join(outputDir, 'lcov.info'))
    const wroteSkipped = fs.existsSync(path.join(outputDir, '.skipped'))
    assert.ok(wroteLcov || wroteSkipped, `converter wrote neither lcov.info nor .skipped under ${outputDir}`)
    assert.equal(wroteLcov, result.files > 0, 'lcov.info presence must match the in-scope file count')

    assert.ok(getCollectorRoot().includes(path.join('.nyc_output', 'integration-tests-collector')),
      'collector scratch should live under .nyc_output/ so it does not collide with final reports in coverage/')
  })

  it('preserves options.env across both fork overloads', async () => {
    const fixtureDir = path.join(appRoot, 'fork-overload-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const outputPath = path.join(fixtureDir, 'child-env.json')
    const fixturePath = path.join(fixtureDir, 'print-env.js')
    await fsp.writeFile(fixturePath, `
'use strict'
require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
  marker: process.env.FORK_MARKER || null,
  v8Dir: process.env.${V8_COVERAGE_ENV} || '',
  bootstrap: (process.env.NODE_OPTIONS || '').includes('child-bootstrap.js'),
}))
process.disconnect()
`)

    const runFork = (args) => new Promise((resolve, reject) => {
      const child = childProcess.fork(...args)
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)))
      child.on('error', reject)
    })

    await runFork([fixturePath, undefined, { env: { ...process.env, FORK_MARKER: 'three-arg' } }])
    let childEnv = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(childEnv.marker, 'three-arg')
    assert.equal(childEnv.v8Dir, getV8CoverageDir())
    assert.ok(childEnv.bootstrap)

    await runFork([fixturePath, { env: { ...process.env, FORK_MARKER: 'two-arg' } }])
    childEnv = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(childEnv.marker, 'two-arg')
    assert.equal(childEnv.v8Dir, getV8CoverageDir())
    assert.ok(childEnv.bootstrap)
  })

  it('propagates coverage through exec/execSync shell commands', async () => {
    const fixtureDir = path.join(appRoot, 'exec-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const asyncOut = path.join(fixtureDir, 'async.json')
    const syncOut = path.join(fixtureDir, 'sync.json')
    const fixturePath = path.join(fixtureDir, 'print-env.js')
    await fsp.writeFile(fixturePath, `
'use strict'
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({
  bootstrap: (process.env.NODE_OPTIONS || '').includes('child-bootstrap.js'),
  v8Dir: process.env.${V8_COVERAGE_ENV} || '',
}))
`)

    await new Promise(/** @type {(resolve: (value?: void) => void, reject: (reason?: Error) => void) => void} */
      (resolve, reject) => {
        childProcess.exec(
          `node ${JSON.stringify(fixturePath)} ${JSON.stringify(asyncOut)}`,
          { cwd: appRoot },
          err => err ? reject(err) : resolve()
        )
      })
    childProcess.execSync(
      `node ${JSON.stringify(fixturePath)} ${JSON.stringify(syncOut)}`,
      { cwd: appRoot, stdio: 'pipe' }
    )

    const expected = { bootstrap: true, v8Dir: getV8CoverageDir() }
    assert.deepEqual(JSON.parse(fs.readFileSync(asyncOut, 'utf8')), expected)
    assert.deepEqual(JSON.parse(fs.readFileSync(syncOut, 'utf8')), expected)
  })

  it('probes fresh when a sandbox path has no dd-trace yet', async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-trace-late-install-'))
    try {
      assert.equal(
        resolveCoverageRoot({ cwd: sandbox }),
        canonicalizePath(coverageRoot),
        'empty sandbox should fall back to the seeded ROOT_ENV, not cache the miss'
      )

      const installedRoot = path.join(sandbox, 'node_modules', 'dd-trace')
      await fsp.mkdir(installedRoot, { recursive: true })
      await fsp.copyFile(
        path.join(coverageRoot, 'package.json'),
        path.join(installedRoot, 'package.json')
      )

      assert.equal(resolveCoverageRoot({ cwd: sandbox }), canonicalizePath(installedRoot))
    } finally {
      await fsp.rm(sandbox, { force: true, recursive: true })
    }
  })

  it('keeps fork children alive while the parent holds the IPC channel', async () => {
    const fixtureDir = path.join(appRoot, 'idle-fork-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const fixturePath = path.join(fixtureDir, 'idle-worker.js')
    await fsp.writeFile(fixturePath,
      "'use strict'\nprocess.on('message', msg => process.send({ echo: msg }))\n")

    const child = childProcess.fork(fixturePath)
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(child.exitCode, null,
        'child must not exit while parent still holds the channel')

      const reply = await new Promise(resolve => {
        child.once('message', resolve)
        child.send('ping')
      })
      assert.deepEqual(reply, { echo: 'ping' })
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })

  it('flushes V8 coverage when a long-running child is stopped with SIGTERM', async () => {
    const fixtureDir = path.join(appRoot, 'flush-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    // A server-style child that loads an instrumentable file then idles until SIGTERM. Without the
    // bootstrap's takeCoverage() flush, V8 would write nothing for a process killed by a signal.
    const fixturePath = path.join(fixtureDir, 'server.js')
    await fsp.writeFile(fixturePath, `
'use strict'
require('../node_modules/dd-trace/packages/dd-trace/src/id')()
process.send && process.send('ready')
setInterval(() => {}, 1000)
`)

    const v8Dir = getV8CoverageDir()
    const before = fs.existsSync(v8Dir) ? fs.readdirSync(v8Dir).length : 0
    const child = childProcess.fork(fixturePath, { cwd: appRoot })
    try {
      await new Promise((resolve, reject) => {
        child.once('message', m => m === 'ready' && resolve())
        child.once('error', reject)
        setTimeout(() => reject(new Error('child never signalled ready')), 5000)
      })
      const exitCode = await new Promise(resolve => {
        child.once('exit', (code, signal) => resolve(code ?? signal))
        child.kill('SIGTERM')
      })
      // The bootstrap intercepts SIGTERM, flushes, and exits 0 rather than dying on the signal.
      assert.equal(exitCode, 0, 'SIGTERM should trigger a clean coverage-flushing exit')
      const after = fs.readdirSync(v8Dir).length
      assert.ok(after > before, `expected a new V8 profile after SIGTERM (before=${before}, after=${after})`)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })

  it('injects only the coverage directory into Worker env, not customer `-r`', async () => {
    const fixtureDir = path.join(appRoot, 'worker-env-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const outPath = path.join(fixtureDir, 'worker-env.json')
    const customerHookPath = path.join(fixtureDir, 'customer-hook.js')
    const workerPath = path.join(fixtureDir, 'worker.js')
    const parentPath = path.join(fixtureDir, 'parent.js')

    await fsp.writeFile(customerHookPath, "'use strict'\n")
    await fsp.writeFile(workerPath, `
'use strict'
require('node:fs').writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({
  v8Dir: process.env.${V8_COVERAGE_ENV} || '',
  stripped: process.env.STRIPPED_MARKER || '',
}))
`)
    await fsp.writeFile(parentPath, `
'use strict'
const { Worker } = require('node:worker_threads')
const w = new Worker(${JSON.stringify(workerPath)}, {
  execArgv: [],
  env: { STRIPPED_MARKER: 'yes' },
})
w.once('exit', code => process.exit(code))
`)
    const bootstrapPath = path.join(process.cwd(), 'integration-tests', 'coverage', 'child-bootstrap.js')
    childProcess.execFileSync(process.execPath, [parentPath], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${bootstrapPath} --require=${customerHookPath}`,
      },
      stdio: 'pipe',
    })

    const workerEnv = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    assert.equal(workerEnv.stripped, 'yes', 'caller-provided env entries must be preserved')
    assert.equal(workerEnv.v8Dir, getV8CoverageDir(), 'Worker with a custom env should get the coverage dir')
  })

  it('leaves Worker env untouched when the caller did not set options.env', async () => {
    const fixtureDir = path.join(appRoot, 'worker-inherit-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const outPath = path.join(fixtureDir, 'worker-env.json')
    const workerPath = path.join(fixtureDir, 'worker.js')
    const parentPath = path.join(fixtureDir, 'parent.js')

    await fsp.writeFile(workerPath, `
'use strict'
require('node:fs').writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({
  v8Dir: process.env.${V8_COVERAGE_ENV} || '',
  parentMarker: process.env.PARENT_MARKER || '',
}))
`)
    await fsp.writeFile(parentPath, `
'use strict'
const { Worker } = require('node:worker_threads')
const w = new Worker(${JSON.stringify(workerPath)})
w.once('exit', code => process.exit(code))
`)
    childProcess.execFileSync(process.execPath, [parentPath], {
      cwd: appRoot,
      env: {
        ...process.env,
        PARENT_MARKER: 'inherited',
      },
      stdio: 'pipe',
    })

    const workerEnv = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    assert.equal(workerEnv.parentMarker, 'inherited',
      'worker must inherit the parent env when options.env is undefined')
    assert.equal(workerEnv.v8Dir, getV8CoverageDir(),
      'worker must inherit the parent coverage dir when options.env is undefined')
  })

  it('honors the per-spawn opt-out env var', async () => {
    const fixtureDir = path.join(appRoot, 'disable-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const outputPath = path.join(fixtureDir, 'env.json')
    const fixturePath = path.join(fixtureDir, 'dump-env.js')
    await fsp.writeFile(fixturePath, "'use strict'\n" +
      "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({\n" +
      '  hasRoot: Boolean(process.env._DD_TRACE_INTEGRATION_COVERAGE_ROOT),\n' +
      `  v8Dir: process.env.${V8_COVERAGE_ENV} || '',\n` +
      '}))\n')

    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, [DISABLE_ENV]: '1' }

    await new Promise(/** @type {(resolve: (value?: void) => void, reject: (reason?: Error) => void) => void} */
      (resolve, reject) => {
        childProcess.execFile(process.execPath, [fixturePath, outputPath], { cwd: appRoot, env },
          err => err ? reject(err) : resolve())
      })

    // The opt-out strips both the coverage root and the V8 directory so the subtree runs clean.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(outputPath, 'utf8')),
      { hasRoot: false, v8Dir: '' }
    )
  })

  it('treats a .skipped sentinel as a no-op coverage report', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-trace-skip-'))
    try {
      const reportDir = path.join(root, 'coverage', 'node-v18.0.0-test-example')
      await fsp.mkdir(reportDir, { recursive: true })
      await fsp.writeFile(path.join(reportDir, '.skipped'), '')

      const verifyScript = path.join(process.cwd(), 'scripts', 'verify-coverage.js')
      const { status } = childProcess.spawnSync(process.execPath, [verifyScript, '--flags', 'test'], {
        cwd: root,
        stdio: 'pipe',
      })

      assert.equal(status, 0)
      assert.equal(fs.existsSync(reportDir), false, 'skipped report dir should be cleaned up')
    } finally {
      await fsp.rm(root, { force: true, recursive: true })
    }
  })

  it('isolates collector and report paths per npm_lifecycle_event', () => {
    const originalEvent = process.env.npm_lifecycle_event
    const originalCollector = process.env._DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR
    delete process.env._DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR
    try {
      process.env.npm_lifecycle_event = 'test:integration:foo:coverage'
      const foo = { collector: getCollectorRoot(), merged: getMergedReportDir() }

      process.env.npm_lifecycle_event = 'test:integration:bar:coverage'
      const bar = { collector: getCollectorRoot(), merged: getMergedReportDir() }

      assert.notEqual(foo.collector, bar.collector)
      assert.notEqual(foo.merged, bar.merged)
      assert.match(foo.collector, /integration-tests-collector-test-integration-foo-coverage$/)
      assert.match(bar.collector, /integration-tests-collector-test-integration-bar-coverage$/)

      delete process.env.npm_lifecycle_event
      assert.match(getCollectorRoot(), /integration-tests-collector$/)
    } finally {
      if (originalEvent === undefined) delete process.env.npm_lifecycle_event
      else process.env.npm_lifecycle_event = originalEvent
      if (originalCollector === undefined) delete process.env._DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR
      else process.env._DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR = originalCollector
    }
  })
})

describe('istanbul-lib-coverage getLineCoverage patch', () => {
  it('does not emit a line for an implicit else with no source location', () => {
    // An `if` without an `else` still gets a branch location for the implicit
    // else, and istanbul's `cloneLocation(undefined)` leaves its `start.line`
    // undefined. The patch must skip it instead of recording a phantom line.
    const fileCoverage = libCoverage.createFileCoverage({
      path: '/fixture.js',
      statementMap: {
        0: { start: { line: 10, column: 0 }, end: { line: 12, column: 1 } },
      },
      s: { 0: 1 },
      fnMap: {},
      f: {},
      branchMap: {
        0: {
          loc: { start: { line: 10, column: 0 }, end: { line: 12, column: 1 } },
          type: 'if',
          locations: [
            { start: { line: 10, column: 0 }, end: { line: 12, column: 1 } },
            { start: { line: undefined, column: undefined }, end: { line: undefined, column: undefined } },
          ],
          line: 10,
        },
      },
      b: { 0: [1, 0] },
    })

    const lineCoverage = fileCoverage.getLineCoverage()

    // The implicit-else location is skipped (its undefined line would surface as
    // a NaN line); the consequent on line 10 is still recorded.
    assert.deepEqual(Object.keys(lineCoverage), ['10'],
      `unexpected line keys in ${inspect(lineCoverage)}`)
    assert.equal(lineCoverage[10], 1)
  })
})

describe('v8-to-istanbul line-coverage over-report patch', () => {
  it('zeroes an indented, un-taken ternary arm that V8 would leave covered', async () => {
    const v8toIstanbul = require('v8-to-istanbul')
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-trace-v8patch-'))
    try {
      // The alternate arm sits on its own indented line; called only with the truthy branch, V8's
      // count:0 range for the alternate does not span the indentation, so the unpatched converter
      // would leave the line at its default-covered count. The patch zeroes it.
      const file = path.join(dir, 'ternary.js')
      await fsp.writeFile(file, [
        "'use strict'",
        'module.exports = function pick (flag) {',
        '  return flag',
        "    ? 'yes'",
        "    : 'no'",
        '}',
        '',
      ].join('\n'))

      const covDir = path.join(dir, 'cov')
      await fsp.mkdir(covDir, { recursive: true })
      const driver = path.join(dir, 'driver.js')
      await fsp.writeFile(driver, `require(${JSON.stringify(file)})(true)\n`)
      // When this spec runs inside the integration coverage harness, the patched child_process
      // rewrites NODE_V8_COVERAGE to the ambient collector; otherwise our explicit covDir is used.
      // Read from whichever directory actually received the profile.
      childProcess.execFileSync(process.execPath, [driver], {
        env: { ...process.env, [V8_COVERAGE_ENV]: covDir },
        stdio: 'pipe',
      })

      let block
      const searchDirs = [covDir, isCoverageActive() ? getV8CoverageDir() : undefined].filter(Boolean)
      for (const searchDir of searchDirs) {
        for (const name of fs.existsSync(searchDir) ? fs.readdirSync(searchDir) : []) {
          if (!name.endsWith('.json')) continue
          const data = JSON.parse(fs.readFileSync(path.join(searchDir, name), 'utf8'))
          for (const entry of data.result) {
            if (entry.url.endsWith('ternary.js')) block = entry
          }
        }
      }
      assert.ok(block, 'expected a V8 coverage entry for the fixture')

      const converter = v8toIstanbul(file, 0)
      await converter.load()
      converter.applyCoverage(block.functions)
      const istanbul = converter.toIstanbul()[file]

      const lineOf = line => {
        for (const [id, loc] of Object.entries(istanbul.statementMap)) {
          if (loc.start.line === line) return istanbul.s[id]
        }
      }
      assert.equal(lineOf(4), 1, "taken arm `? 'yes'` should be covered")
      assert.equal(lineOf(5), 0, "un-taken arm `: 'no'` must be zeroed by the patch")
    } finally {
      await fsp.rm(dir, { force: true, recursive: true })
    }
  })
})
