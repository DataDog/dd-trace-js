'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { setTimeout } = require('node:timers/promises')

const libCoverage = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')

const {
  PRE_INSTRUMENTED_ROOT,
  REPO_ROOT,
  canonicalizePath,
  getSandboxCollectorDir,
  getSandboxNycPaths,
  isCoverageActive,
  isPreInstrumentedSandbox,
} = require('./runtime')

// Both writers (`pre-instrumented-writer.js#flush` and `nyc.wrap()`'s exit hook) flush
// via `writeFileSync`, which opens with `O_TRUNC` and then writes. A grandchild that is
// still flushing on its `'exit'` while we already tear the sandbox down hands us an
// empty or truncated buffer in that window, so we retry briefly: ENOENT short-circuits,
// empty / unparseable content polls again. 5 × 10 ms is enough in practice; bumping it
// only matters if a single child's coverage payload grows past tens of megabytes.
const MAX_READ_ATTEMPTS = 5
const READ_RETRY_DELAY_MS = 10

async function readCoverageJsonWhenStable (filePath) {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    let content
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    if (content.length > 0) {
      try {
        return JSON.parse(content)
      } catch {}
    }
    await setTimeout(READ_RETRY_DELAY_MS)
  }
}

async function loadSandboxCoverage (tempDir) {
  const map = libCoverage.createCoverageMap({})

  let entries
  try {
    entries = await fs.readdir(tempDir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return map
    throw err
  }

  const reads = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    reads.push(readCoverageJsonWhenStable(path.join(tempDir, entry.name)))
  }
  for (const report of await Promise.all(reads)) {
    if (report) map.merge(report)
  }
  return map
}

function serializeRebasedCoverage (coverageMap, rebaseRoot) {
  const result = {}
  for (const file of coverageMap.files()) {
    const relative = path.relative(rebaseRoot, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    const rebased = path.join(REPO_ROOT, relative)
    result[rebased] = { ...coverageMap.fileCoverageFor(file).data, path: rebased }
  }
  return JSON.stringify(result)
}

/**
 * @param {string} folder
 * @param {string | undefined} coverageRoot
 * @returns {Promise<void>}
 */
async function finalizeSandbox (folder, coverageRoot) {
  if (!isCoverageActive() || !coverageRoot) return
  coverageRoot = canonicalizePath(coverageRoot)

  const rebaseRoot = isPreInstrumentedSandbox(coverageRoot) ? PRE_INSTRUMENTED_ROOT : coverageRoot

  const { reportDir, tempDir } = getSandboxNycPaths(coverageRoot)
  const coverageMap = await loadSandboxCoverage(tempDir)
  if (coverageMap.files().length === 0) return

  await fs.mkdir(reportDir, { recursive: true })

  const context = libReport.createContext({ coverageMap, dir: reportDir })
  reports.create('lcovonly', { file: 'lcov.info', projectRoot: rebaseRoot }).execute(context)
  reports.create('text-summary').execute(context)

  let reportEntries
  try {
    reportEntries = await fs.readdir(reportDir, { withFileTypes: true })
  } catch {
    return
  }

  const outputDir = getSandboxCollectorDir(folder)
  await fs.rm(outputDir, { force: true, recursive: true })
  await fs.mkdir(outputDir, { recursive: true })

  const pending = [
    fs.writeFile(path.join(outputDir, 'coverage-final.json'), serializeRebasedCoverage(coverageMap, rebaseRoot)),
  ]
  for (const entry of reportEntries) {
    pending.push(fs.cp(
      path.join(reportDir, entry.name),
      path.join(outputDir, entry.name),
      { recursive: entry.isDirectory() },
    ))
  }
  await Promise.all(pending)
}

module.exports = finalizeSandbox
