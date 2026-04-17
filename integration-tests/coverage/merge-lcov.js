'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const libCoverage = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')

const { REPO_ROOT, getCollectorRoot, getMergedReportDir } = require('./runtime')

/**
 * Loads every per-sandbox `coverage-final.json` emitted by `finalize-sandbox.js` and merges them
 * into a single `CoverageMap` keyed by repo-relative paths.
 *
 * @param {string} sandboxesDir
 * @returns {Promise<{ coverageMap: import('istanbul-lib-coverage').CoverageMap, sandboxCount: number }>}
 */
async function loadMergedCoverage (sandboxesDir) {
  const merged = libCoverage.createCoverageMap({})

  let entries
  try {
    entries = await fs.readdir(sandboxesDir, { withFileTypes: true })
  } catch {
    return { coverageMap: merged, sandboxCount: 0 }
  }

  const reads = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const jsonPath = path.join(sandboxesDir, entry.name, 'coverage-final.json')
    reads.push(readSandboxJson(jsonPath))
  }

  let sandboxCount = 0
  for (const item of await Promise.all(reads)) {
    if (!item) continue
    try {
      merged.merge(JSON.parse(item.content))
      sandboxCount++
    } catch (err) {
      process.stderr.write(`Skipping unreadable coverage file ${item.jsonPath}: ${err.message}\n`)
    }
  }

  return { coverageMap: merged, sandboxCount }
}

/**
 * @param {string} jsonPath
 * @returns {Promise<{ jsonPath: string, content: string } | undefined>}
 */
async function readSandboxJson (jsonPath) {
  try {
    return { jsonPath, content: await fs.readFile(jsonPath, 'utf8') }
  } catch {}
}

async function main () {
  const sandboxesDir = path.join(getCollectorRoot(), 'sandboxes')
  const outputDir = getMergedReportDir()

  await fs.mkdir(outputDir, { recursive: true })

  const { coverageMap, sandboxCount } = await loadMergedCoverage(sandboxesDir)

  if (sandboxCount === 0) {
    await Promise.all([
      fs.writeFile(path.join(outputDir, 'lcov.info'), ''),
      fs.writeFile(path.join(outputDir, 'coverage-final.json'), '{}'),
    ])
    process.stdout.write('No sandbox coverage reports found to merge.\n')
    return
  }

  // The merged CoverageMap uses absolute repo paths, so the HTML reporter resolves sources
  // directly; `lcovonly`'s `projectRoot` strips the prefix to produce repo-relative `SF:` lines.
  const context = libReport.createContext({ coverageMap, dir: outputDir, defaultSummarizer: 'nested' })
  reports.create('lcovonly', { file: 'lcov.info', projectRoot: REPO_ROOT }).execute(context)
  reports.create('html', { subdir: 'html' }).execute(context)
  reports.create('text-summary', { file: 'text-summary.txt' }).execute(context)

  await fs.writeFile(path.join(outputDir, 'coverage-final.json'), JSON.stringify(coverageMap.toJSON()))

  process.stdout.write(
    `Merged ${sandboxCount} sandbox report(s) across ${coverageMap.files().length} file section(s). ` +
    `HTML report: ${path.join(outputDir, 'html', 'index.html')}\n`
  )
}

async function run () {
  try {
    await main()
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`)
    process.exitCode = 1
  }
}

run()
