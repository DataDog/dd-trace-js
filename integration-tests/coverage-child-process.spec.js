'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { installPatch } = require('./coverage/patch-child-process')
const { installLastExitHandler } = require('./coverage/pre-instrumented-writer')
const finalizeSandboxCoverage = require('./coverage/finalize-sandbox')
const {
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  ROOT_ENV,
  canonicalizePath,
  getCollectorRoot,
  getMergedReportDir,
  getSandboxCollectorDir,
  resolveCoverageRoot,
} = require('./coverage/runtime')

describe('integration coverage child process hook', () => {
  let appRoot
  let coverageRoot
  let prevRoot

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
    await fsp.copyFile(
      path.join(process.cwd(), 'integration-tests', 'coverage', 'nyc.sandbox.config.js'),
      path.join(coverageRoot, 'integration-tests', 'coverage', 'nyc.sandbox.config.js')
    )
    await fsp.writeFile(path.join(appRoot, 'coverage-fixtures', 'parent.js'), `
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')

const id = require('../node_modules/dd-trace/packages/dd-trace/src/id')

id()
fs.writeFileSync(path.join(__dirname, 'parent-debug.json'), JSON.stringify({
  coverageKeys: Object.keys(global.__coverage__ || {}),
  hasNycConfig: Boolean(process.env.NYC_CONFIG),
  nodeOptions: process.env.NODE_OPTIONS || '',
}))

const child = fork(path.join(__dirname, 'worker.js'), { stdio: 'pipe' })

child.on('message', message => {
  if (message === 'ready') {
    process.exitCode = 0
    child.send({ ${JSON.stringify(FLUSH_SIGNAL_KEY)}: true })
  }
})

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
  coverageKeys: Object.keys(global.__coverage__ || {}),
  hasNycConfig: Boolean(process.env.NYC_CONFIG),
  nodeOptions: process.env.NODE_OPTIONS || '',
}))
process.send('ready')
`)

    prevRoot = process.env[ROOT_ENV]
    process.env[ROOT_ENV] = coverageRoot
    installPatch()
  })

  after(async () => {
    if (prevRoot === undefined) {
      delete process.env[ROOT_ENV]
    } else {
      process.env[ROOT_ENV] = prevRoot
    }

    await fsp.rm(appRoot, { force: true, recursive: true })
  })

  it('preserves fork IPC and finalizes sandbox coverage artifacts', async () => {
    childProcess.execFileSync(process.execPath, [path.join(appRoot, 'coverage-fixtures', 'parent.js')], {
      cwd: appRoot,
      env: process.env,
      stdio: 'pipe',
    })

    const fixturesDir = path.join(appRoot, 'coverage-fixtures')
    const parentDebug = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'parent-debug.json'), 'utf8'))
    const workerDebug = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'worker-debug.json'), 'utf8'))
    assert.strictEqual(parentDebug.hasNycConfig, true)
    assert.strictEqual(workerDebug.hasNycConfig, true)
    assert.ok(parentDebug.nodeOptions.includes('child-bootstrap.js'))
    assert.ok(workerDebug.nodeOptions.includes('child-bootstrap.js'))
    assert.ok(parentDebug.coverageKeys.length > 0, 'expected parent process coverage to be populated')
    assert.ok(workerDebug.coverageKeys.length > 0, 'expected worker process coverage to be populated')

    const tempDir = path.join(coverageRoot, '.nyc_output', 'integration-tests')
    const tempEntries = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : []
    assert.ok(tempEntries.length > 0, `expected raw coverage files in ${tempDir}`)
    const coverageEntries = tempEntries.filter(name => name.endsWith('.json') && !name.includes('processinfo'))
    assert.ok(coverageEntries.length > 0, `expected coverage json files in ${tempDir}`)
    const rawCoverage = JSON.parse(fs.readFileSync(path.join(tempDir, coverageEntries[0]), 'utf8'))
    assert.ok(Object.keys(rawCoverage).length > 0, 'expected raw coverage payload to contain files')

    await finalizeSandboxCoverage(appRoot, coverageRoot)

    const mergeScript = path.join(process.cwd(), 'integration-tests', 'coverage', 'merge-lcov.js')
    childProcess.execFileSync(process.execPath, [mergeScript], { stdio: 'pipe' })

    const lcovPath = path.join(getSandboxCollectorDir(appRoot), 'lcov.info')
    const mergedLcovPath = path.join(getMergedReportDir(), 'lcov.info')

    assert.ok(fs.existsSync(lcovPath), `expected coverage report at ${lcovPath}`)
    assert.ok(fs.existsSync(mergedLcovPath), `expected merged coverage report at ${mergedLcovPath}`)
    assert.ok(getCollectorRoot().includes(path.join('.nyc_output', 'integration-tests-collector')),
      'collector scratch should live under .nyc_output/ so it does not collide with final reports in coverage/')

    const lcov = fs.readFileSync(lcovPath, 'utf8')
    assert.match(lcov, /SF:packages\/dd-trace\/src\/id\.js/)
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
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(outputPath, 'utf8')),
      { marker: 'three-arg', bootstrap: true }
    )

    await runFork([fixturePath, { env: { ...process.env, FORK_MARKER: 'two-arg' } }])
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(outputPath, 'utf8')),
      { marker: 'two-arg', bootstrap: true }
    )
  })

  it('propagates the bootstrap through exec/execSync shell commands', async () => {
    const fixtureDir = path.join(appRoot, 'exec-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const asyncOut = path.join(fixtureDir, 'async.json')
    const syncOut = path.join(fixtureDir, 'sync.json')
    const fixturePath = path.join(fixtureDir, 'print-env.js')
    await fsp.writeFile(fixturePath, `
'use strict'
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({
  bootstrap: (process.env.NODE_OPTIONS || '').includes('child-bootstrap.js'),
  hasNycConfig: Boolean(process.env.NYC_CONFIG),
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

    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(asyncOut, 'utf8')),
      { bootstrap: true, hasNycConfig: true }
    )
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(syncOut, 'utf8')),
      { bootstrap: true, hasNycConfig: true }
    )
  })

  it('probes fresh when a sandbox path has no dd-trace yet', async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-trace-late-install-'))
    try {
      assert.strictEqual(
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

      assert.strictEqual(resolveCoverageRoot({ cwd: sandbox }), canonicalizePath(installedRoot))
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
      assert.strictEqual(child.exitCode, null,
        'child must not exit while parent still holds the channel')

      const reply = await new Promise(resolve => {
        child.once('message', resolve)
        child.send('ping')
      })
      assert.deepStrictEqual(reply, { echo: 'ping' })
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })

  const ifWin32 = process.platform === 'win32' ? it : it.skip
  ifWin32('flushes coverage when the parent sends FLUSH_SIGNAL_KEY (Windows only)', async () => {
    const fixtureDir = path.join(appRoot, 'flush-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const fixturePath = path.join(fixtureDir, 'idle.js')
    await fsp.writeFile(fixturePath, "'use strict'\nsetInterval(() => {}, 1000)\n")

    const child = childProcess.fork(fixturePath)
    try {
      const exitCode = await new Promise(resolve => {
        child.once('exit', resolve)
        setTimeout(() => child.send({ [FLUSH_SIGNAL_KEY]: true }), 50)
      })
      assert.strictEqual(exitCode, 0, 'flush sentinel must trigger a clean exit')
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })

  ifWin32('does not keep listener-free fork children alive (Windows only)', async () => {
    const fixtureDir = path.join(appRoot, 'short-lived-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const fixturePath = path.join(fixtureDir, 'short-lived.js')
    await fsp.writeFile(fixturePath, "'use strict'\nsetTimeout(() => {}, 100)\n")

    const child = childProcess.fork(fixturePath)
    const start = Date.now()
    try {
      const exitCode = await new Promise(resolve => {
        child.once('exit', resolve)
        setTimeout(() => resolve('timeout'), 5000)
      })
      assert.strictEqual(exitCode, 0, `child must exit naturally (${Date.now() - start}ms)`)
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })

  it('injects only the coverage bootstrap into Worker NODE_OPTIONS, not customer `-r`', async () => {
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
  nodeOptions: process.env.NODE_OPTIONS || '',
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
    assert.strictEqual(workerEnv.stripped, 'yes', 'caller-provided env entries must be preserved')
    assert.ok(
      workerEnv.nodeOptions.includes('child-bootstrap.js'),
      `Worker should get the coverage bootstrap (got: ${workerEnv.nodeOptions})`
    )
    assert.ok(
      !workerEnv.nodeOptions.includes('customer-hook.js'),
      `Worker must not inherit customer \`-r\` hooks from the parent (got: ${workerEnv.nodeOptions})`
    )
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
  nodeOptions: process.env.NODE_OPTIONS || '',
  parentMarker: process.env.PARENT_MARKER || '',
}))
`)
    await fsp.writeFile(parentPath, `
'use strict'
const { Worker } = require('node:worker_threads')
const w = new Worker(${JSON.stringify(workerPath)})
w.once('exit', code => process.exit(code))
`)
    const bootstrapPath = path.join(process.cwd(), 'integration-tests', 'coverage', 'child-bootstrap.js')
    childProcess.execFileSync(process.execPath, [parentPath], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${bootstrapPath}`,
        PARENT_MARKER: 'inherited',
      },
      stdio: 'pipe',
    })

    const workerEnv = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    assert.strictEqual(workerEnv.parentMarker, 'inherited',
      'worker must inherit the parent env when options.env is undefined')
    assert.ok(workerEnv.nodeOptions.includes('child-bootstrap.js'),
      `worker must inherit full parent NODE_OPTIONS (got: ${workerEnv.nodeOptions})`)
  })

  it('does not inject NYC_CWD — nested nyc CLIs would misuse it', async () => {
    const fixtureDir = path.join(appRoot, 'nyc-cwd-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const outputPath = path.join(fixtureDir, 'env.json')
    const fixturePath = path.join(fixtureDir, 'dump-env.js')
    await fsp.writeFile(fixturePath, "'use strict'\n" +
      "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({\n" +
      '  nycCwd: process.env.NYC_CWD ?? null,\n' +
      '  hasNycConfig: Boolean(process.env.NYC_CONFIG),\n' +
      "  bootstrap: (process.env.NODE_OPTIONS || '').includes('child-bootstrap.js'),\n" +
      '}))\n')

    const env = { ...process.env }
    delete env.NYC_CWD
    delete env.NYC_CONFIG

    await new Promise(/** @type {(resolve: (value?: void) => void, reject: (reason?: Error) => void) => void} */
      (resolve, reject) => {
        childProcess.execFile(process.execPath, [fixturePath, outputPath], { cwd: appRoot, env },
          err => err ? reject(err) : resolve())
      })

    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(outputPath, 'utf8')),
      { nycCwd: null, hasNycConfig: true, bootstrap: true }
    )
  })

  it('honors the per-spawn opt-out env var', async () => {
    const fixtureDir = path.join(appRoot, 'disable-fixtures')
    await fsp.mkdir(fixtureDir, { recursive: true })
    const outputPath = path.join(fixtureDir, 'env.json')
    const fixturePath = path.join(fixtureDir, 'dump-env.js')
    await fsp.writeFile(fixturePath, "'use strict'\n" +
      "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({\n" +
      '  hasRoot: Boolean(process.env._DD_TRACE_INTEGRATION_COVERAGE_ROOT),\n' +
      '  hasNycConfig: Boolean(process.env.NYC_CONFIG),\n' +
      "  bootstrap: (process.env.NODE_OPTIONS || '').includes('child-bootstrap.js'),\n" +
      '}))\n')

    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, [DISABLE_ENV]: '1' }
    delete env.NYC_CONFIG

    await new Promise(/** @type {(resolve: (value?: void) => void, reject: (reason?: Error) => void) => void} */
      (resolve, reject) => {
        childProcess.execFile(process.execPath, [fixturePath, outputPath], { cwd: appRoot, env },
          err => err ? reject(err) : resolve())
      })

    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(outputPath, 'utf8')),
      { hasRoot: false, hasNycConfig: false, bootstrap: false }
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

      assert.strictEqual(status, 0)
      assert.strictEqual(fs.existsSync(reportDir), false, 'skipped report dir should be cleaned up')
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

      assert.notStrictEqual(foo.collector, bar.collector)
      assert.notStrictEqual(foo.merged, bar.merged)
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

describe('integration coverage last-exit handler', () => {
  let originals

  beforeEach(() => {
    originals = {
      on: process.on,
      addListener: process.addListener,
      prependListener: process.prependListener,
    }
  })

  afterEach(() => {
    process.on = originals.on
    process.addListener = originals.addListener
    process.prependListener = originals.prependListener
    process.removeAllListeners('exit')
  })

  it('runs the registered handler last regardless of when other exit listeners arrive', () => {
    const fired = []
    const flush = () => fired.push('flush')

    installLastExitHandler(flush)

    process.on('exit', () => fired.push('on'))
    process.addListener('exit', () => fired.push('addListener'))
    process.prependListener('exit', () => fired.push('prependListener'))
    process.once('exit', () => fired.push('once'))

    process.emit('exit', 0)

    assert.deepStrictEqual(fired, ['prependListener', 'on', 'addListener', 'once', 'flush'])
  })

  it('leaves non-exit listeners untouched', () => {
    const fired = []
    installLastExitHandler(() => fired.push('flush'))

    process.on('beforeExit', () => fired.push('beforeExit'))
    process.emit('beforeExit', 0)
    process.removeAllListeners('beforeExit')

    assert.deepStrictEqual(fired, ['beforeExit'])
  })
})
