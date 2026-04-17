'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { installPatch } = require('./coverage/patch-child-process')
const finalizeSandboxCoverage = require('./coverage/finalize-sandbox')
const {
  ROOT_ENV,
  getCollectorRoot,
  getMergedReportDir,
  getSandboxCollectorDir,
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
    child.disconnect()
    child.kill()
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

  // Regression: `fork(modulePath, undefined, options)` and `fork(modulePath, options)` must
  // both preserve the caller's `options.env`. An earlier normalization bug silently dropped
  // the options when the 2nd positional was nullish, stripping `env` (and everything else)
  // so callers using that overload shape saw an empty environment in the child.
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
})
