import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

import istanbulLibCoverage from 'istanbul-lib-coverage'

/* eslint-disable no-console */

// Merges every downloaded per-cell `coverage-*` artifact into one lcov file and one istanbul JSON
// file under `coverage-upload/`, so the All Green upload steps send a single physical report to
// each backend instead of one per matrix cell (400+). Codecov silently parks uploads past its
// ~150-per-commit ceiling in `started` (never merged), so the cell-per-upload model dropped
// coverage; beyond that ceiling, both `datadog-ci` and `codecovcli` also pay a real per-file cost
// reading/packaging a directory before their single network call — one physical file each cuts
// that client-side overhead to (near) zero regardless of how many cells contributed to it.
//
// lcov is a plain-text, per-source-file record format, so concatenating reports is a valid merge on
// its own (`lcov`/`genhtml` do the same to combine reports). istanbul's JSON keys coverage by
// absolute file path, and a source file can be exercised by more than one cell (a shared core
// tracer file is hit by nearly every plugin's tests), so a naive object merge would drop or
// overwrite one cell's hit counts instead of summing them — `istanbul-lib-coverage`'s `merge` sums
// per-statement/branch/function hit counts across coverage maps for the same file, which is the
// same operation `nyc` already runs elsewhere in this repo.
//
// Per-integration/per-area flags were dropped: `.codecov.yml` only gates the separate
// `master-coverage` flag (attached to every upload regardless of grouping), so a finer-grained flag
// carried no gating weight of its own — it only fed a "coverage by plugin" breakdown in the
// Codecov/Datadog UI, which wasn't worth the extra upload round trips.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'

// Codecov reads branch/function coverage from istanbul's JSON; Datadog only ingests the lcov. Each
// report is routed by format so the merge step knows how to combine it.
const REPORTS = new Map([
  ['lcov.info', 'lcov'],
  ['coverage-final.json', 'json'],
])

/**
 * Recursively collect coverage report files beneath a directory, paired with the artifact instance
 * (run-id + name) they came from and their format. `download-artifacts.mjs` lays files out as
 * `coverage-results/<run-id>/<artifact-name>/...`; a single artifact can hold more than one report
 * per format (a cell that ran coverage across several Node.js versions writes one set per version),
 * so the run-id distinguishes a rerun's reupload from those siblings.
 *
 * @param {string} dir
 * @param {Array<{ runId: string, name: string, format: string, reportPath: string }>} out
 * @param {{ runId?: string, name?: string }} context
 * @returns {Array<{ runId: string, name: string, format: string, reportPath: string }>}
 */
function collectCoverageFiles (dir, out = [], context = {}) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const runId = context.runId ?? entry.name
      const name = context.runId === undefined ? undefined : (context.name ?? entry.name)
      collectCoverageFiles(full, out, { runId, name })
    } else if (REPORTS.has(entry.name) && context.name?.startsWith(ARTIFACT_PREFIX)) {
      out.push({ runId: context.runId, name: context.name, format: REPORTS.get(entry.name), reportPath: full })
    }
  }
  return out
}

/**
 * Reduce discovered report files to one cell per artifact name. All Green reruns failed workflows,
 * so the same artifact name can arrive from more than one run; the newest run reflects the cell's
 * final state, so older reuploads are dropped.
 *
 * @param {Array<{ runId: string, name: string, format: string, reportPath: string }>} files
 * @returns {{ reportsByArtifact: Map<string, Array<{ format: string, reportPath: string }>>,
 *   artifacts: string[] }}
 */
function planCoverageGroups (files) {
  const newestRunByArtifact = new Map()
  for (const { runId, name } of files) {
    const previous = newestRunByArtifact.get(name)
    if (previous === undefined || Number(runId) > Number(previous)) {
      newestRunByArtifact.set(name, runId)
    }
  }

  const reportsByArtifact = new Map()
  const artifacts = []
  for (const { runId, name, format, reportPath } of files) {
    if (runId !== newestRunByArtifact.get(name)) continue
    const existing = reportsByArtifact.get(name)
    if (existing) {
      existing.push({ format, reportPath })
      continue
    }
    reportsByArtifact.set(name, [{ format, reportPath }])
    artifacts.push(name)
  }

  return { reportsByArtifact, artifacts }
}

/**
 * Concatenate every cell's lcov report into a single lcov file. lcov's format is a sequence of
 * independent per-source-file records, so concatenation alone is a valid merge.
 *
 * @param {string[]} reportPaths
 * @returns {string}
 */
function mergeLcov (reportPaths) {
  return reportPaths.map(reportPath => {
    const contents = readFileSync(reportPath, 'utf8')
    return contents.endsWith('\n') ? contents : `${contents}\n`
  }).join('')
}

/**
 * Sum per-statement/branch/function hit counts across every cell's istanbul JSON report, so a
 * source file exercised by more than one cell keeps every cell's coverage instead of only the last
 * report merged for that file.
 *
 * @param {string[]} reportPaths
 * @returns {object}
 */
function mergeCoverageJson (reportPaths) {
  const map = istanbulLibCoverage.createCoverageMap({})
  for (const reportPath of reportPaths) {
    map.merge(JSON.parse(readFileSync(reportPath, 'utf8')))
  }
  return map.toJSON()
}

function main () {
  rmSync(OUTPUT_DIR, { force: true, recursive: true })

  const files = collectCoverageFiles(INPUT_DIR)
  if (files.length === 0) {
    console.log(`No coverage reports found under ${INPUT_DIR}/.`)
    return
  }

  const { reportsByArtifact, artifacts } = planCoverageGroups(files)

  const reportPathsByFormat = new Map()
  for (const artifact of artifacts) {
    for (const { format, reportPath } of reportsByArtifact.get(artifact)) {
      const reportPaths = reportPathsByFormat.get(format)
      if (reportPaths) {
        reportPaths.push(reportPath)
      } else {
        reportPathsByFormat.set(format, [reportPath])
      }
    }
  }

  console.log(`Merging ${reportsByArtifact.size} cell report set(s) into ${OUTPUT_DIR}/.`)

  const lcovReportPaths = reportPathsByFormat.get('lcov') ?? []
  if (lcovReportPaths.length > 0) {
    mkdirSync(join(OUTPUT_DIR, 'lcov'), { recursive: true })
    writeFileSync(join(OUTPUT_DIR, 'lcov', 'lcov.info'), mergeLcov(lcovReportPaths))
  }

  const jsonReportPaths = reportPathsByFormat.get('json') ?? []
  if (jsonReportPaths.length > 0) {
    mkdirSync(join(OUTPUT_DIR, 'json'), { recursive: true })
    writeFileSync(join(OUTPUT_DIR, 'json', 'coverage-final.json'), JSON.stringify(mergeCoverageJson(jsonReportPaths)))
  }

  console.log(`  ${artifacts.length} cell(s): ${lcovReportPaths.length} lcov, ${jsonReportPaths.length} json`)
}

export { mergeCoverageJson, mergeLcov, planCoverageGroups }

if (argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
