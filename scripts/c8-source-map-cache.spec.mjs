import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, it } from 'mocha'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodePreloadFile = require.resolve('node-preload')
const preloadFile = path.join(repoRoot, 'scripts', 'c8-source-map-cache.js')
const { markCoverageDirectory } = require('./c8-source-map-cache')

/**
 * @param {string | undefined} coverageDir
 * @param {string} fixtureDir
 * @param {object} [options]
 * @param {string} [options.childCoverageDir]
 * @param {boolean} [options.failLookup]
 * @param {boolean} [options.loadAtExit]
 * @param {number} [options.moduleCount]
 */
async function runFixture (coverageDir, fixtureDir, options = {}) {
  const childCoverageDir = options.childCoverageDir ?? coverageDir
  const moduleCount = options.moduleCount ?? 0
  const childCoverageLog = path.join(fixtureDir, 'child-coverage-dir.txt')
  const lookupLog = path.join(fixtureDir, 'source-map-lookups.txt')
  const modulesDir = path.join(fixtureDir, 'modules')
  const lateFile = path.join(fixtureDir, 'late.js')
  const observerFile = path.join(fixtureDir, 'observe-source-map-lookups.js')
  const parentFile = path.join(fixtureDir, 'parent.js')
  const targetFile = path.join(fixtureDir, 'target.mjs')

  await mkdir(modulesDir)
  const moduleFiles = new Array(moduleCount)
  const importLines = new Array(moduleCount)
  for (let i = 0; i < moduleCount; i++) {
    const moduleFile = path.join(modulesDir, `${i}.mjs`)
    moduleFiles[i] = writeFile(moduleFile, `export default ${i}\n//# sourceMappingURL=${i}.mjs.map\n`)
    importLines[i] = `import ${JSON.stringify(pathToFileURL(moduleFile).href)}`
  }
  await Promise.all(moduleFiles)

  await writeFile(observerFile, String.raw`
    'use strict'
    const fs = require('node:fs')
    const inspector = require('node:inspector')
    const Module = require('node:module')
    const originalDisconnect = inspector.Session.prototype.disconnect
    const originalFindSourceMap = Module.findSourceMap
    inspector.Session.prototype.disconnect = function () {
      originalDisconnect.call(this)
      fs.appendFileSync(${JSON.stringify(lookupLog)}, 'disconnect\n')
    }
    Module.findSourceMap = function (url) {
      fs.appendFileSync(${JSON.stringify(lookupLog)}, url + '\n')
      ${options.failLookup
        ? `const error = new Error('source map lookup failed')
      if (url.endsWith('/target.mjs')) error.stack = undefined
      throw error`
        : ''}
      return originalFindSourceMap(url)
    }
  `)
  await writeFile(lateFile, 'module.exports = true\n//# sourceMappingURL=late.js.map\n')
  await writeFile(parentFile, `
    'use strict'
    const { spawnSync } = require('node:child_process')
    const preloadList = require(${JSON.stringify(nodePreloadFile)})
    preloadList.unshift(${JSON.stringify(observerFile)})
    require(${JSON.stringify(preloadFile)})
    const childEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      npm_lifecycle_event: 'nested-script',
    }
    ${childCoverageDir === undefined
      ? "childEnv.NODE_V8_COVERAGE = ''"
      : `childEnv.NODE_V8_COVERAGE = ${JSON.stringify(childCoverageDir)}`}
    const result = spawnSync(process.execPath, [${JSON.stringify(targetFile)}], {
      env: childEnv,
      stdio: 'inherit',
    })
    process.exitCode = result.status ?? 1
  `)
  await writeFile(targetFile, `
    import { writeFileSync } from 'node:fs'
    import { createRequire } from 'node:module'
    ${importLines.join('\n')}
    const require = createRequire(import.meta.url)
    writeFileSync(
      ${JSON.stringify(childCoverageLog)},
      process.env.NODE_V8_COVERAGE ?? ''
    )
    function coveredAtBeforeExit () {
      globalThis.coverageTail = true
    }
    process.once('beforeExit', coveredAtBeforeExit)
    ${options.loadAtExit
      ? `process.prependOnceListener('exit', function loadLateSourceMap () {
      require(${JSON.stringify(lateFile)})
    })`
      : ''}
  `)

  const env = {
    ...process.env,
    NODE_V8_COVERAGE: coverageDir === undefined ? '' : coverageDir,
  }
  await execFileAsync(process.execPath, [parentFile], { cwd: repoRoot, env })

  return {
    childCoverageLog,
    lateFile: await realpath(lateFile),
    lookupLog,
    targetFile: await realpath(targetFile),
  }
}

/**
 * @param {string} coverageDir
 * @param {string} targetFile
 */
async function assertTailCovered (coverageDir, targetFile) {
  const targetUrl = pathToFileURL(targetFile).href
  const profileFiles = []
  for (const filename of await readdir(coverageDir)) {
    if (filename.endsWith('.json')) profileFiles.push(readFile(path.join(coverageDir, filename), 'utf8'))
  }

  let targetCoverage
  for (const profileFile of await Promise.all(profileFiles)) {
    const profile = JSON.parse(profileFile)
    for (const entry of profile.result) {
      if (entry.url === targetUrl) {
        targetCoverage = entry
        break
      }
    }
    if (targetCoverage) break
  }

  assert.ok(targetCoverage, `No coverage found for ${targetUrl}`)
  let functionCoverage
  for (const entry of targetCoverage.functions) {
    if (entry.functionName === 'coveredAtBeforeExit') {
      functionCoverage = entry
      break
    }
  }
  assert.ok(functionCoverage, 'No coverage found for coveredAtBeforeExit')
  assert.strictEqual(functionCoverage.ranges[0].count, 1)
}

describe('c8 source map cache', () => {
  let fixtureDir

  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'dd-c8-source-map-cache-'))
  })

  afterEach(async () => {
    await rm(fixtureDir, { force: true, recursive: true })
  })

  it('warms source maps for c8-owned coverage through custom child environments', async () => {
    const ownCoverageDir = path.join(fixtureDir, 'own-coverage')
    markCoverageDirectory(ownCoverageDir)
    const { childCoverageLog, lookupLog, targetFile } =
      await runFixture(ownCoverageDir, fixtureDir, { moduleCount: 200 })

    assert.strictEqual(await readFile(childCoverageLog, 'utf8'), ownCoverageDir)
    const lookups = await readFile(lookupLog, 'utf8')
    assert.ok(lookups.includes(pathToFileURL(targetFile).href), `No source map lookup found for ${targetFile}`)
    let moduleLookups = 0
    for (const lookup of lookups.split('\n')) {
      if (lookup.includes('/modules/')) moduleLookups++
    }
    assert.strictEqual(moduleLookups, 200)
    await assertTailCovered(ownCoverageDir, targetFile)
  })

  it('does not warm source maps for a foreign coverage directory', async () => {
    const ownCoverageDir = path.join(fixtureDir, 'own-coverage')
    const foreignCoverageDir = path.join(fixtureDir, 'foreign-coverage')
    markCoverageDirectory(ownCoverageDir)
    const { childCoverageLog, lookupLog, targetFile } = await runFixture(ownCoverageDir, fixtureDir, {
      childCoverageDir: foreignCoverageDir,
    })

    assert.strictEqual(await readFile(childCoverageLog, 'utf8'), foreignCoverageDir)
    await assert.rejects(readFile(lookupLog), { code: 'ENOENT' })
    await assertTailCovered(foreignCoverageDir, targetFile)
  })

  it('does not warm source maps without coverage', async () => {
    const { childCoverageLog, lookupLog } = await runFixture(undefined, fixtureDir)

    assert.strictEqual(await readFile(childCoverageLog, 'utf8'), '')
    await assert.rejects(readFile(lookupLog), { code: 'ENOENT' })
  })

  it('continues when a source map lookup fails', async () => {
    const ownCoverageDir = path.join(fixtureDir, 'own-coverage')
    markCoverageDirectory(ownCoverageDir)
    const { lookupLog, targetFile } = await runFixture(ownCoverageDir, fixtureDir, { failLookup: true })

    const lookups = await readFile(lookupLog, 'utf8')
    assert.ok(lookups.includes(pathToFileURL(targetFile).href), `No source map lookup found for ${targetFile}`)
    await assertTailCovered(ownCoverageDir, targetFile)
  })

  it('warms exit-time source maps before disconnecting the inspector', async () => {
    const ownCoverageDir = path.join(fixtureDir, 'own-coverage')
    markCoverageDirectory(ownCoverageDir)
    const { lateFile, lookupLog, targetFile } =
      await runFixture(ownCoverageDir, fixtureDir, { loadAtExit: true })

    const lookupLogContent = await readFile(lookupLog, 'utf8')
    const entries = lookupLogContent.trimEnd().split('\n')
    const lateUrl = pathToFileURL(lateFile).href
    const lateIndex = entries.indexOf(lateUrl)
    const disconnectIndex = entries.indexOf('disconnect')
    assert.notStrictEqual(lateIndex, -1, `No source map lookup found for ${lateFile}`)
    assert.strictEqual(disconnectIndex, entries.length - 1)
    assert.strictEqual(entries.lastIndexOf('disconnect'), disconnectIndex)
    await assertTailCovered(ownCoverageDir, targetFile)
  })
})
