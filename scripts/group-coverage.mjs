import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Merges one workflow run's downloaded per-cell `coverage-*` artifact lcov reports into a single
// lcov file under `coverage-upload/<run-id>/`, scoped to that run alone. All Green calls this as
// soon as a sibling workflow finishes, instead of waiting for every workflow to complete before
// merging and uploading anything — the goal is for each workflow's coverage to reach Datadog and
// Codecov shortly after that workflow finishes, in parallel with the rest still running.
//
// Only lcov is uploaded, not istanbul's JSON: this repo's `patch-istanbul-lib-coverage.js` already
// folds branch/function hit data into lcov's `DA:` records, and `.codecov.yml` only gates line-level
// `patch` coverage, so the JSON report added merge cost without affecting the gate. lcov itself still
// needs a real per-file merge, not concatenation: every matrix cell in a workflow run (each Node.js
// version, each plugin partition) writes its own complete report, so a shared source file gets an
// `SF:` block from every cell. Concatenating those blocks produces a report with duplicate `SF:`
// sections per file, which downstream lcov consumers (including Codecov) resolve by keeping only the
// last block for that file rather than summing across blocks — silently discarding most of the
// branch/function data every earlier cell had recorded. `mergeLcov` sums `DA:`/`FNDA:`/`BRDA:` hit
// counts per file across cells instead, the way `lcov --add-tracefile` does.
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
 * @typedef {object} LcovFileRecord
 * @property {Map<string, number>} lines line number -> summed hit count
 * @property {Map<string, { line: string, count: number }>} functions function name -> declaration
 *   line and summed hit count
 * @property {Map<string, { hits: number, reached: boolean }>} branches `line,block,branch` -> summed
 *   hit count and whether any cell reported the enclosing block as reached (lcov uses `-` for a
 *   branch whose block was never reached, distinct from a reached block whose branch was never taken)
 */

/**
 * Split an lcov record line into its tag and payload, e.g. `DA:1,1` -> `['DA', '1,1']`.
 *
 * @param {string} line
 * @returns {[string, string]}
 */
function splitLcovLine (line) {
  const index = line.indexOf(':')
  return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)]
}

/**
 * Fold one `SF:`-delimited record's `DA:`/`FN:`/`FNDA:`/`BRDA:` lines into the running per-file
 * merge state, summing hit counts for lines/functions/branches already seen from earlier cells.
 *
 * @param {string[]} recordLines
 * @param {Map<string, LcovFileRecord>} files source file path -> merge state
 * @param {string[]} order source file paths in first-seen order
 * @returns {void}
 */
function mergeLcovRecord (recordLines, files, order) {
  const sourceFileLine = recordLines.find(line => line.startsWith('SF:'))
  if (!sourceFileLine) return

  const path = splitLcovLine(sourceFileLine)[1]
  if (!files.has(path)) {
    files.set(path, { lines: new Map(), functions: new Map(), branches: new Map() })
    order.push(path)
  }
  const record = files.get(path)

  for (const line of recordLines) {
    const [tag, rest] = splitLcovLine(line)
    if (tag === 'DA') {
      const [lineNumber, count] = rest.split(',')
      record.lines.set(lineNumber, (record.lines.get(lineNumber) ?? 0) + Number(count))
    } else if (tag === 'FN') {
      const [lineNumber, name] = rest.split(',')
      if (!record.functions.has(name)) record.functions.set(name, { line: lineNumber, count: 0 })
    } else if (tag === 'FNDA') {
      const [count, name] = rest.split(',')
      const fn = record.functions.get(name) ?? { line: '0', count: 0 }
      fn.count += Number(count)
      record.functions.set(name, fn)
    } else if (tag === 'BRDA') {
      const [lineNumber, block, branch, count] = rest.split(',')
      const key = `${lineNumber},${block},${branch}`
      const branchRecord = record.branches.get(key) ?? { hits: 0, reached: false }
      if (count !== '-') {
        branchRecord.hits += Number(count)
        branchRecord.reached = true
      }
      record.branches.set(key, branchRecord)
    }
  }
}

/**
 * Serialize one file's merged coverage state back into lcov record lines, recomputing the
 * `LF`/`LH`/`FNF`/`FNH`/`BRF`/`BRH` summary lines from the merged data.
 *
 * @param {string} path
 * @param {LcovFileRecord} record
 * @returns {string}
 */
function serializeLcovRecord (path, record) {
  const lines = [`SF:${path}`]

  for (const [name, fn] of record.functions) lines.push(`FN:${fn.line},${name}`)
  for (const [name, fn] of record.functions) lines.push(`FNDA:${fn.count},${name}`)
  if (record.functions.size > 0) {
    const hit = [...record.functions.values()].filter(fn => fn.count > 0).length
    lines.push(`FNF:${record.functions.size}`, `FNH:${hit}`)
  }

  for (const [key, branch] of record.branches) {
    lines.push(`BRDA:${key},${branch.reached ? branch.hits : '-'}`)
  }
  if (record.branches.size > 0) {
    const hit = [...record.branches.values()].filter(branch => branch.hits > 0).length
    lines.push(`BRF:${record.branches.size}`, `BRH:${hit}`)
  }

  for (const [lineNumber, count] of record.lines) lines.push(`DA:${lineNumber},${count}`)
  if (record.lines.size > 0) {
    const hit = [...record.lines.values()].filter(count => count > 0).length
    lines.push(`LF:${record.lines.size}`, `LH:${hit}`)
  }

  lines.push('end_of_record')
  return `${lines.join('\n')}\n`
}

/**
 * Merge every cell's lcov report into a single lcov file, summing hit counts per source file
 * instead of concatenating records — see the module comment for why concatenation silently drops
 * coverage when the same file appears in more than one cell's report.
 *
 * @param {string[]} reportPaths
 * @returns {string}
 */
function mergeLcov (reportPaths) {
  const files = new Map()
  const order = []

  for (const reportPath of reportPaths) {
    const contents = readFileSync(reportPath, 'utf8')
    for (const record of contents.split('end_of_record')) {
      const recordLines = record.split('\n').map(line => line.trim()).filter(Boolean)
      if (recordLines.length > 0) mergeLcovRecord(recordLines, files, order)
    }
  }

  return order.map(path => serializeLcovRecord(path, files.get(path))).join('')
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

  return runOutputDir
}

export { mergeLcov, mergeRunCoverage, planCoverageGroups }
