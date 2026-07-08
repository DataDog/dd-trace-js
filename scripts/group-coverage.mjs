import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* eslint-disable no-console */

// Merges one workflow run's downloaded per-cell `coverage-*` artifact lcov reports into a single
// lcov file under `coverage-upload/<run-id>/`, scoped to that run alone. All Green calls this as
// soon as a sibling workflow finishes, instead of waiting for every workflow to complete before
// merging and uploading anything — the goal is for each workflow's coverage to reach Datadog and
// Codecov shortly after that workflow finishes, in parallel with the rest still running.
//
// lcov is a plain-text, per-source-file record format, so concatenating reports is a valid merge on
// its own (`lcov`/`genhtml` do the same to combine reports) — no per-file hit-count summing is
// needed, unlike istanbul's JSON, which is why only lcov is uploaded: this repo's
// `patch-istanbul-lib-coverage.js` already folds branch/function hit data into lcov's `DA:` records,
// and `.codecov.yml` only gates line-level `patch` coverage, so istanbul's JSON added merge cost
// (summing hit counts across cells for shared files) without affecting the gate.
//
// Per-integration/per-area flags were dropped: `.codecov.yml` only gates the separate
// `master-coverage` flag (attached to every upload regardless of grouping), so a finer-grained flag
// carried no gating weight of its own — it only fed a "coverage by plugin" breakdown in the
// Codecov/Datadog UI, which wasn't worth the extra upload round trips.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'

// Only lcov is collected: both backends read it, and it's cheap to merge by concatenation.
const REPORTS = new Map([
  ['lcov.info', 'lcov'],
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
 * Merge a single workflow run's downloaded lcov reports into one file for upload.
 *
 * @param {string|number} runId
 * @param {string} [inputDir]
 * @param {string} [outputDir]
 * @returns {string|null} Directory containing the merged `lcov.info`, or null if the run has none.
 */
function mergeRunCoverage (runId, inputDir = INPUT_DIR, outputDir = OUTPUT_DIR) {
  const files = collectCoverageFiles(join(inputDir, String(runId)), [], { runId: String(runId) })
  if (files.length === 0) return null

  const { reportsByArtifact, artifacts } = planCoverageGroups(files)
  const reportPaths = artifacts.flatMap(artifact => reportsByArtifact.get(artifact).map(r => r.reportPath))
  if (reportPaths.length === 0) return null

  const runOutputDir = join(outputDir, String(runId), 'lcov')
  mkdirSync(runOutputDir, { recursive: true })
  writeFileSync(join(runOutputDir, 'lcov.info'), mergeLcov(reportPaths))

  console.log(`Merged ${artifacts.length} cell(s) of run ${runId} into ${runOutputDir}/lcov.info`)
  return runOutputDir
}

export { mergeLcov, mergeRunCoverage, planCoverageGroups }
