import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

/* eslint-disable no-console */

// Collapses the per-cell `coverage-*` artifacts that `download-artifacts.mjs` placed under
// `coverage-results/` into a handful of merged LCOV reports — one per logical integration — so a
// single commit uploads ~100 reports to Codecov/Datadog instead of ~430. Codecov silently parks
// uploads past its per-commit ceiling in `started` (never merged), so the cell-per-upload model
// dropped coverage; one report per integration keeps every upload under the ceiling while staying
// readable: the flag names an integration, never a Node.js or library version.
//
// Runs in the `all-green` job, whose sparse checkout carries no `node_modules`/`vendor`. The
// producers already wrote each `lcov.info` through the patched `getLineCoverage`, so merging the
// LCOV text (summing hit counters per source file) needs no istanbul dependency and preserves the
// patch for free.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'
// `upload-coverage-artifact` names each cell `coverage-<flag>__<job>-<job-index>`; the `__` separates
// the grouping flag from the per-cell uniqueness suffix so two matrix cells sharing a flag (cypress
// varies `spec` outside its flag) still upload distinct artifacts instead of clobbering each other.
const UNIQUE_SEPARATOR = '__'

// Tokens that name a Node.js major, a library version, or a runtime/OS/module-format axis — all
// noise for "which integration regressed". Stripping every trailing noise token folds a flag like
// `apm-integrations-next-oldest-14.2.6` down to its integration `apm-integrations-next`.
const NOISE_TOKENS = new Set([
  'latest', 'oldest', 'eol', 'active', 'maintenance', 'all', // Node.js / range_clean aliases
  'ubuntu', 'macos', 'windows', // runner OS
  'commonjs', 'esm', // module format
])
// A bare version (`14.2.6`, `18`) or a `range_clean` qualifier that packs the operator and version
// into one dash-token (`gte.5.2.0`, `gte.6.16.0.and.lt.7.0.0`).
const VERSION_RE = /^(?:gte|gt|lte|lt|eq)?\.?\d+(?:\.\d+)*(?:\.(?:and|or|gte|gt|lte|lt|eq)\b.*)?$/

// Keep a busy area's one-cell libraries from each becoming their own upload: pack them into buckets
// of at most this many libraries, named for their members so the flag still points at a library.
const MAX_LIBS_PER_BUCKET = 3

/**
 * @param {string} token
 * @returns {boolean}
 */
function isNoiseToken (token) {
  return NOISE_TOKENS.has(token.toLowerCase()) || VERSION_RE.test(token)
}

/**
 * The integration a per-cell flag belongs to, with every version/OS/tier/format token removed
 * wherever it sits. Node.js tier and library version commonly land in the middle of a flag (e.g.
 * `serverless-aws-sdk-oldest-s3`, where `oldest` is the Node.js tier and `s3` a real sub-suite of
 * the one `aws-sdk` integration), so a tail-only strip would leave the tier stranded mid-flag.
 *
 * @param {string} flag
 * @returns {string}
 */
function integrationOf (flag) {
  const tokens = flag.split('-').filter(token => !isNoiseToken(token))
  return tokens.length > 0 ? tokens.join('-') : flag
}

/**
 * Recursively collect `lcov.info` files beneath a directory.
 *
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function collectLcovFiles (dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectLcovFiles(full, out)
    } else if (entry.name === 'lcov.info') {
      out.push(full)
    }
  }
  return out
}

/**
 * The artifact a downloaded file came from. `download-artifacts.mjs` lays files out as
 * `coverage-results/<run-id>/<artifact-name>/...`; a single artifact can hold more than one
 * `lcov.info` (a cell that ran coverage across several Node.js versions writes one per version),
 * so the run-id distinguishes the same artifact name reuploaded by a rerun from those siblings.
 *
 * @param {string} lcovPath
 * @returns {{ runId: string, name: string } | undefined}
 */
function artifactInstanceOf (lcovPath) {
  const parts = lcovPath.split('/')
  const index = parts.indexOf(INPUT_DIR)
  const runId = parts[index + 1]
  const name = parts[index + 2]
  return runId !== undefined && name !== undefined ? { runId, name } : undefined
}

/**
 * The Codecov flag carried by an artifact name, dropping the `coverage-` prefix and the
 * `__<unique>` cell-uniqueness suffix.
 *
 * @param {string} artifact
 * @returns {string}
 */
function flagOf (artifact) {
  const withoutPrefix = artifact.slice(ARTIFACT_PREFIX.length)
  const separator = withoutPrefix.indexOf(UNIQUE_SEPARATOR)
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator)
}

/**
 * @typedef {object} FileCoverage
 * @property {Map<string, number>} fn  Function declaration line keyed by name.
 * @property {Map<string, number>} fnda  Function hit count keyed by name.
 * @property {Map<number, number>} da  Line hit count keyed by line number.
 * @property {Map<string, number>} brda  Branch hit count keyed by `line:block:branch`.
 */

/**
 * Parse istanbul `lcovonly` text into a per-source-file map, summing counters when a source file
 * already appeared (so merging two cells that both touched a file adds their hits).
 *
 * @param {string} text
 * @param {Map<string, FileCoverage>} files
 * @returns {Map<string, FileCoverage>}
 */
function mergeLcovText (text, files) {
  let current
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('SF:')) {
      const sourceFile = line.slice(3)
      current = files.get(sourceFile)
      if (!current) {
        current = { fn: new Map(), fnda: new Map(), da: new Map(), brda: new Map() }
        files.set(sourceFile, current)
      }
    } else if (current === undefined) {
      continue
    } else if (line.startsWith('DA:')) {
      const comma = line.indexOf(',')
      const lineNumber = Number(line.slice(3, comma))
      current.da.set(lineNumber, (current.da.get(lineNumber) ?? 0) + Number(line.slice(comma + 1)))
    } else if (line.startsWith('FN:')) {
      const comma = line.indexOf(',')
      current.fn.set(line.slice(comma + 1), Number(line.slice(3, comma)))
    } else if (line.startsWith('FNDA:')) {
      const comma = line.indexOf(',')
      const name = line.slice(comma + 1)
      current.fnda.set(name, (current.fnda.get(name) ?? 0) + Number(line.slice(5, comma)))
    } else if (line.startsWith('BRDA:')) {
      const [lineNumber, block, branch, taken] = line.slice(5).split(',')
      const key = `${lineNumber}:${block}:${branch}`
      const hits = taken === '-' ? 0 : Number(taken)
      current.brda.set(key, (current.brda.get(key) ?? 0) + hits)
    } else if (line === 'end_of_record') {
      current = undefined
    }
  }
  return files
}

/**
 * Serialize a merged per-file map back to istanbul-compatible LCOV, recomputing the hit/found
 * totals Codecov reads off each record.
 *
 * @param {Map<string, FileCoverage>} files
 * @returns {string}
 */
function serializeLcov (files) {
  const out = []
  for (const [sourceFile, coverage] of files) {
    out.push('TN:', `SF:${sourceFile}`)
    for (const [name, declLine] of coverage.fn) {
      out.push(`FN:${declLine},${name}`)
    }
    out.push(`FNF:${coverage.fn.size}`, `FNH:${countHit(coverage.fnda)}`)
    for (const [name, hits] of coverage.fnda) {
      out.push(`FNDA:${hits},${name}`)
    }
    for (const [lineNumber, hits] of [...coverage.da].sort((a, b) => a[0] - b[0])) {
      out.push(`DA:${lineNumber},${hits}`)
    }
    out.push(`LF:${coverage.da.size}`, `LH:${countHit(coverage.da)}`)
    for (const [key, hits] of coverage.brda) {
      const [lineNumber, block, branch] = key.split(':')
      out.push(`BRDA:${lineNumber},${block},${branch},${hits === 0 ? '-' : hits}`)
    }
    out.push(`BRF:${coverage.brda.size}`, `BRH:${countHit(coverage.brda)}`, 'end_of_record')
  }
  return out.join('\n') + '\n'
}

/**
 * @param {Map<unknown, number>} counts
 * @returns {number}
 */
function countHit (counts) {
  let hit = 0
  for (const value of counts.values()) {
    if (value > 0) hit++
  }
  return hit
}

/**
 * Assign each integration to an upload group. Integrations exercised by more than one cell stay on
 * their own; the one-cell tail of a busy area is packed into buckets named for their libraries so a
 * flag still reads as a set of integrations rather than an opaque index.
 *
 * @param {Map<string, string[]>} cellsByIntegration  Integration → artifact names feeding it.
 * @returns {Map<string, string[]>}  Group flag → integrations it owns.
 */
function planGroups (cellsByIntegration) {
  const groups = new Map()
  const singletonsByArea = new Map()

  for (const [integration, cells] of cellsByIntegration) {
    if (cells.length > 1) {
      groups.set(integration, [integration])
      continue
    }
    const area = integration.split('-')[0]
    const list = singletonsByArea.get(area)
    if (list) {
      list.push(integration)
    } else {
      singletonsByArea.set(area, [integration])
    }
  }

  for (const [area, integrations] of singletonsByArea) {
    integrations.sort()
    if (integrations.length <= 2) {
      for (const integration of integrations) {
        groups.set(integration, [integration])
      }
      continue
    }
    for (let i = 0; i < integrations.length; i += MAX_LIBS_PER_BUCKET) {
      const chunk = integrations.slice(i, i + MAX_LIBS_PER_BUCKET)
      const suffix = chunk.map(integration => integration.slice(area.length + 1)).join('+')
      groups.set(`${area}-${suffix}`, chunk)
    }
  }

  return groups
}

/**
 * @typedef {object} ArtifactInstance
 * @property {string} runId  The workflow run the artifact was downloaded from.
 * @property {string} name   The artifact name (`coverage-<flag>__<job>-<index>`).
 * @property {string[]} lcovPaths  Every `lcov.info` the artifact carried.
 */

/**
 * Reduce artifact instances to one per cell — All Green reruns failed workflows, so the same
 * artifact name can arrive from more than one run; the newest run reflects the cell's final state,
 * and merging a stale rerun's counters on top would double-count lines. Then group the surviving
 * cells by integration.
 *
 * @param {ArtifactInstance[]} instances
 * @returns {{ groups: Map<string, string[]>, lcovPathsByArtifact: Map<string, string[]>,
 *   cellsByIntegration: Map<string, string[]> }}
 */
function planCoverageGroups (instances) {
  const newestRunByArtifact = new Map()
  for (const { runId, name } of instances) {
    const previous = newestRunByArtifact.get(name)
    if (previous === undefined || runId > previous) {
      newestRunByArtifact.set(name, runId)
    }
  }

  const lcovPathsByArtifact = new Map()
  const cellsByIntegration = new Map()
  for (const { runId, name, lcovPaths } of instances) {
    if (runId !== newestRunByArtifact.get(name)) continue
    const existing = lcovPathsByArtifact.get(name)
    if (existing) {
      existing.push(...lcovPaths)
      continue
    }
    lcovPathsByArtifact.set(name, [...lcovPaths])
    const integration = integrationOf(flagOf(name))
    const owned = cellsByIntegration.get(integration)
    if (owned) {
      owned.push(name)
    } else {
      cellsByIntegration.set(integration, [name])
    }
  }

  return { groups: planGroups(cellsByIntegration), lcovPathsByArtifact, cellsByIntegration }
}

function main () {
  rmSync(OUTPUT_DIR, { force: true, recursive: true })

  // Collapse the discovered lcov paths into one entry per artifact instance (run-id + name).
  const instances = new Map()
  for (const lcovPath of collectLcovFiles(INPUT_DIR)) {
    const instance = artifactInstanceOf(lcovPath)
    if (!instance?.name.startsWith(ARTIFACT_PREFIX)) continue
    const key = `${instance.runId}/${instance.name}`
    const existing = instances.get(key)
    if (existing) {
      existing.lcovPaths.push(lcovPath)
    } else {
      instances.set(key, { ...instance, lcovPaths: [lcovPath] })
    }
  }
  if (instances.size === 0) {
    console.log(`No lcov.info files found under ${INPUT_DIR}/.`)
    return
  }

  const { groups, lcovPathsByArtifact, cellsByIntegration } = planCoverageGroups([...instances.values()])

  console.log(`Merging ${lcovPathsByArtifact.size} cell report(s) into ${groups.size} group(s):`)
  for (const [flag, integrations] of [...groups].sort()) {
    const files = new Map()
    for (const integration of integrations) {
      for (const artifact of cellsByIntegration.get(integration)) {
        for (const lcovPath of lcovPathsByArtifact.get(artifact)) {
          mergeLcovText(readFileSync(lcovPath, 'utf8'), files)
        }
      }
    }
    const outPath = join(OUTPUT_DIR, flag, 'lcov.info')
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, serializeLcov(files))
    console.log(`  ${flag} (${integrations.length} integration(s), ${files.size} file(s))`)
  }
}

export { flagOf, integrationOf, mergeLcovText, planCoverageGroups, planGroups, serializeLcov }

if (argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
