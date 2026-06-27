'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const libCoverage = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')
const v8toIstanbul = require('v8-to-istanbul')
const TestExclude = require('test-exclude')

const baseNycConfig = require('../../nyc.config')
const { REPO_ROOT, getMergedReportDir, getV8CoverageDir } = require('./runtime')

// Same include/exclude as the istanbul reporters used, so the file set is identical regardless of
// which tool collected. c8's own `excludeAfterRemap` semantics are reproduced here: we decide
// inclusion on the resolved on-disk path, after mapping the V8 url back to a real file.
const exclude = new TestExclude({
  cwd: REPO_ROOT,
  include: baseNycConfig.include,
  exclude: baseNycConfig.exclude,
  excludeNodeModules: true,
  extension: ['.js', '.mjs'],
})

// Integration tests run against dd-trace installed as a packed tarball inside a throwaway sandbox
// (`<tmp>/<id>/node_modules/dd-trace/…`). V8 records that sandbox path, and the sandbox is deleted
// before this merge runs, so the entry would both fail the REPO_ROOT check and be unloadable. The
// tarball ships source verbatim (`packages/*/src/**`, `index.js`, …), so the segment after
// `node_modules/dd-trace/` maps 1:1 onto the repo tree. Rebase onto REPO_ROOT and load the still-
// present repo copy, whose bytes are identical to the sandbox copy V8 measured.
const SANDBOX_MARKER = `${path.sep}node_modules${path.sep}dd-trace${path.sep}`

/**
 * @param {string} filePath
 * @returns {string}
 */
function rebaseSandboxPath (filePath) {
  const markerIndex = filePath.lastIndexOf(SANDBOX_MARKER)
  if (markerIndex === -1) return filePath
  return path.join(REPO_ROOT, filePath.slice(markerIndex + SANDBOX_MARKER.length))
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldInclude (filePath) {
  if (!filePath.startsWith(REPO_ROOT + path.sep)) return false
  if (filePath.includes(`${path.sep}node_modules${path.sep}`)) return false
  if (filePath.includes(`${path.sep}versions${path.sep}`)) return false
  return exclude.shouldInstrument(filePath)
}

/**
 * Convert one process' raw V8 coverage file into an istanbul coverage map and merge it into `into`.
 * Each entry whose source is an in-scope repo file is run through `v8-to-istanbul` (patched to fix
 * the multi-line-statement over-report) and folded in; everything else (node internals, deps,
 * test files) is skipped.
 *
 * @param {import('istanbul-lib-coverage').CoverageMap} into
 * @param {string} v8File absolute path to a raw V8 coverage JSON file
 * @returns {Promise<number>} count of in-scope script entries merged
 */
async function mergeV8File (into, v8File) {
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(v8File, 'utf8'))
  } catch {
    return 0
  }
  let merged = 0
  for (const entry of parsed.result ?? []) {
    if (!entry.url || !entry.url.startsWith('file://')) continue
    let filePath
    try {
      filePath = fileURLToPath(entry.url)
    } catch {
      continue
    }
    filePath = rebaseSandboxPath(filePath)
    if (!shouldInclude(filePath)) continue

    const converter = v8toIstanbul(filePath, 0)
    try {
      await converter.load()
      converter.applyCoverage(entry.functions)
      into.merge(converter.toIstanbul())
      merged++
    } catch {
      // A file that changed on disk since the run, or a source map we can't resolve, is skipped
      // rather than failing the whole merge.
    }
  }
  return merged
}

/**
 * Convert every raw V8 profile in `v8Dir` into a merged istanbul report (lcov + html + json) under
 * `outputDir`. Shared by the integration harness (this script's `main`) and the in-process
 * `scripts/c8-ci.js`, so both produce identical reports from the same patched converter.
 *
 * @param {string} v8Dir directory of raw `NODE_V8_COVERAGE` JSON files
 * @param {string} outputDir report destination (`coverage/node-<version>-<label>`)
 * @returns {Promise<{scripts: number, profiles: number, files: number}>}
 */
async function convertV8DirToReport (v8Dir, outputDir) {
  await fs.mkdir(outputDir, { recursive: true })

  let files
  try {
    files = await fs.readdir(v8Dir)
  } catch {
    files = []
  }
  const v8Files = files.filter(f => f.endsWith('.json'))

  const coverageMap = libCoverage.createCoverageMap({})
  let scripts = 0
  // Sequential rather than parallel: v8-to-istanbul reads + parses each source, and a wide fan-out
  // across thousands of entries spikes memory; the merge is not the slow part of a coverage run.
  for (const file of v8Files) {
    scripts += await mergeV8File(coverageMap, path.join(v8Dir, file))
  }

  if (coverageMap.files().length === 0) {
    // Sentinel for `verify-coverage.js` to skip upload when matrix filters drop every test.
    await fs.writeFile(path.join(outputDir, '.skipped'), '')
    return { scripts: 0, profiles: v8Files.length, files: 0 }
  }

  const context = libReport.createContext({ coverageMap, dir: outputDir, defaultSummarizer: 'nested' })
  reports.create('lcovonly', { file: 'lcov.info', projectRoot: REPO_ROOT }).execute(context)
  reports.create('html', { subdir: 'html' }).execute(context)
  reports.create('text-summary', { file: 'text-summary.txt' }).execute(context)

  await fs.writeFile(path.join(outputDir, 'coverage-final.json'), JSON.stringify(coverageMap.toJSON()))

  return { scripts, profiles: v8Files.length, files: coverageMap.files().length }
}

async function main () {
  const outputDir = getMergedReportDir()
  const { scripts, profiles, files } = await convertV8DirToReport(getV8CoverageDir(), outputDir)
  if (files === 0) {
    process.stdout.write('No V8 coverage data found to merge.\n')
    return
  }
  process.stdout.write(
    `Converted ${scripts} V8 script entries across ${profiles} process profile(s) into ` +
    `${files} file section(s). HTML report: ${path.join(outputDir, 'html', 'index.html')}\n`
  )
}

module.exports = { convertV8DirToReport }

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`${err.stack || err.message}\n`)
    process.exitCode = 1
  })
}
