import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Merges one workflow run's downloaded per-cell `coverage-*` artifacts into a single lcov file under
// `coverage-upload/<run-id>/`, scoped to that run alone. All Green calls this as soon as a sibling
// workflow finishes, instead of waiting for every workflow to complete before merging and uploading
// anything — the goal is for each workflow's coverage to reach Datadog and Codecov shortly after that
// workflow finishes, in parallel with the rest still running.
//
// Both Datadog and Codecov ingest lcov only — istanbul JSON support (which Codecov used to read
// branch/function coverage from) was dropped: it doubled the merge cost on runs with many cells
// (`istanbul-lib-coverage`'s merge is far slower than `mergeLcov`) for coverage the lcov format
// doesn't carry (branch/function hit counts) — an acceptable trade-off. Merging is still required,
// not concatenation: every matrix cell in a workflow run (each Node.js version, each plugin
// partition) writes its own complete report, so a shared source file's coverage shows up once per
// cell. Concatenating lcov's `SF:` blocks produces a report with duplicate `SF:` sections per file,
// which downstream lcov consumers resolve by keeping only the last block for that file rather than
// summing across blocks — silently discarding most of the coverage every earlier cell had recorded.
// Uploading unmerged across sessions has the same problem one level up: Codecov's own cross-session
// merge has been observed overwriting rather than summing a shared file's coverage when more than one
// session reports it, so lcov is merged down to one report per run before upload instead of relying
// on the backend to reconcile per-session duplicates. `mergeLcov` sums `DA:`/`FNDA:`/`BRDA:` hit
// counts per file across cells, the way `lcov --add-tracefile` does.
//
// Per-integration/per-area flags were dropped: `.codecov.yml` only gates the separate
// `master-coverage` flag (attached to every upload regardless of grouping), so a finer-grained flag
// carried no gating weight of its own — it only fed a "coverage by plugin" breakdown in the
// Codecov/Datadog UI, which wasn't worth the extra upload round trips.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'

/**
 * Recursively collect lcov reports beneath one run directory. Only `coverage-*` artifact directories
 * are valid producers; nested directories retain the artifact name while locating version reports.
 *
 * @param {string} dir
 * @param {string[]} out
 * @param {string} [artifactName]
 * @returns {string[]}
 */
function collectCoverageFiles (dir, out = [], artifactName) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectCoverageFiles(full, out, artifactName ?? entry.name)
    } else if (entry.name === 'lcov.info' && artifactName?.startsWith(ARTIFACT_PREFIX)) {
      out.push(full)
    }
  }
  return out
}

/**
 * @typedef {object} LcovFileRecord
 * @property {Map<string, number>} lines line number -> summed hit count
 * @property {Map<string, { name: string, line: string, count: number }>} functions `line,name` ->
 *   name, declaration line, and summed hit count — keyed by line as well as name because distinct
 *   functions can share a name (e.g. two nested closures both named `shared`)
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
 * `FNDA:` lines carry only a function name, not its declaration line, so a same-named function
 * declared at two different lines can't be told apart by name alone; lcov writers emit `FNDA:` lines
 * in the same order as their `FN:` declarations, so they're paired positionally instead.
 *
 * @param {string[]} recordLines
 * @param {Map<string, LcovFileRecord>} files source file path -> merge state
 * @param {string[]} order source file paths in first-seen order
 * @returns {void}
 */
function mergeLcovRecord (recordLines, files, order) {
  const sourceFileLine = recordLines.find(line => line.startsWith('SF:'))
  if (!sourceFileLine) return

  // istanbul-reports' lcov writer derives SF: from `path.relative()`, which uses backslashes on
  // Windows; a workflow run mixing a Windows matrix cell with Linux/macOS cells (e.g. AppSec) would
  // otherwise key the same source file under two different SF: strings and split its coverage
  // across two records instead of summing it into one.
  const path = splitLcovLine(sourceFileLine)[1].replaceAll('\\', '/')
  if (!files.has(path)) {
    files.set(path, { lines: new Map(), functions: new Map(), branches: new Map() })
    order.push(path)
  }
  const record = files.get(path)

  const declaredFunctionKeys = []
  let functionDeclarationIndex = 0
  for (const line of recordLines) {
    const [tag, rest] = splitLcovLine(line)
    if (tag === 'DA') {
      const [lineNumber, count] = rest.split(',')
      record.lines.set(lineNumber, (record.lines.get(lineNumber) ?? 0) + Number(count))
    } else if (tag === 'FN') {
      const [lineNumber, name] = rest.split(',')
      const key = `${lineNumber},${name}`
      declaredFunctionKeys.push(key)
      if (!record.functions.has(key)) record.functions.set(key, { name, line: lineNumber, count: 0 })
    } else if (tag === 'FNDA') {
      const [count] = rest.split(',')
      const key = declaredFunctionKeys[functionDeclarationIndex++]
      if (key === undefined) continue
      record.functions.get(key).count += Number(count)
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

  for (const fn of record.functions.values()) lines.push(`FN:${fn.line},${fn.name}`)
  for (const fn of record.functions.values()) lines.push(`FNDA:${fn.count},${fn.name}`)
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
 * Merge a single workflow run's downloaded coverage reports into one lcov file for upload.
 *
 * @param {string|number} runId
 * @param {string} [inputDir]
 * @param {string} [outputDir]
 * @returns {{ lcovDir: string|null }} Directory containing the merged `lcov.info`, null if the run
 *   produced no coverage report.
 */
function mergeRunCoverage (runId, inputDir = INPUT_DIR, outputDir = OUTPUT_DIR) {
  const lcovReportPaths = collectCoverageFiles(join(inputDir, String(runId)))
  if (lcovReportPaths.length === 0) return { lcovDir: null }

  const lcovDir = join(outputDir, String(runId), 'lcov')
  mkdirSync(lcovDir, { recursive: true })
  writeFileSync(join(lcovDir, 'lcov.info'), mergeLcov(lcovReportPaths))

  return { lcovDir }
}

export { OUTPUT_DIR, mergeLcov, mergeRunCoverage }
