'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const libReport = require('istanbul-lib-report')
const NYC = require('nyc')
const reports = require('istanbul-reports')

const {
  REPO_ROOT,
  canonicalizePath,
  ensureCollectorRoot,
  getSandboxCollectorDir,
  getSandboxNycPaths,
  isCoverageActive,
} = require('./runtime')

/**
 * Re-keys each `FileCoverage` from its sandbox-local absolute path (e.g.
 * `/tmp/sandbox/node_modules/dd-trace/packages/foo.js`) to the equivalent repo path so merged
 * reports link to the checked-out sources even after sandbox teardown.
 *
 * @param {import('istanbul-lib-coverage').CoverageMap} coverageMap
 * @param {string} coverageRoot
 * @returns {string}
 */
function serializeRebasedCoverage (coverageMap, coverageRoot) {
  const result = {}

  for (const file of coverageMap.files()) {
    const relative = path.relative(coverageRoot, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue

    const rebasedPath = path.join(REPO_ROOT, relative)
    result[rebasedPath] = { ...coverageMap.fileCoverageFor(file).data, path: rebasedPath }
  }

  return JSON.stringify(result)
}

/**
 * Generates sandbox-local LCOV/summary artifacts plus a repo-keyed `coverage-final.json` and
 * copies everything into the repo-side collector directory for this sandbox.
 *
 * @param {string} folder - the sandbox folder that is about to be removed
 * @param {string | undefined} coverageRoot
 * @returns {Promise<void>}
 */
async function finalizeSandbox (folder, coverageRoot) {
  if (!isCoverageActive() || !coverageRoot) return

  coverageRoot = canonicalizePath(coverageRoot)

  const { reportDir, tempDir } = getSandboxNycPaths(coverageRoot)
  try {
    await fs.access(tempDir)
  } catch {
    return
  }

  await ensureCollectorRoot()

  const { createConfig } = require('./nyc.sandbox.config')
  const nyc = new NYC({ ...createConfig(coverageRoot), cwd: coverageRoot, silent: true })
  await nyc.createTempDirectory()
  const coverageMap = await nyc.getCoverageMapFromAllCoverageFiles()

  const context = libReport.createContext({ coverageMap, dir: reportDir })
  reports.create('lcovonly', { file: 'lcov.info', projectRoot: coverageRoot }).execute(context)
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
    fs.writeFile(path.join(outputDir, 'coverage-final.json'), serializeRebasedCoverage(coverageMap, coverageRoot)),
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
