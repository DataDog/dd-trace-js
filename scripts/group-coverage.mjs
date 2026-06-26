import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

/* eslint-disable no-console */

// Sorts the per-cell `coverage-*` artifacts that `download-artifacts.mjs` placed under
// `coverage-results/` into one directory per integration under `coverage-upload/<group>/`, so the
// All Green upload steps send ~100 grouped reports to Codecov/Datadog instead of ~430. Codecov
// silently parks uploads past its ~150-per-commit ceiling in `started` (never merged), so the
// cell-per-upload model dropped coverage; one upload per integration stays under the ceiling.
//
// The reports are not merged here — both backends merge same-flag uploads server-side, so this only
// routes each cell's already-patched `lcov.info` into its group's directory. That keeps the harness
// free of any istanbul dependency in All Green's sparse checkout and passes each report through
// byte-for-byte, so the `getLineCoverage` patch the producers baked in survives untouched.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'
// `upload-coverage-artifact` names each cell `coverage-<flag>__<job>-<job-index>`; the `__` separates
// the grouping flag from the per-cell uniqueness suffix so two matrix cells sharing a flag (cypress
// varies `spec` outside its flag) still upload distinct artifacts instead of clobbering each other.
const UNIQUE_SEPARATOR = '__'

// Tokens that name a Node.js major, a library version, or a runtime/OS/module-format axis — all
// noise for "which integration regressed". Stripping every noise token folds a flag like
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
 * Recursively collect `lcov.info` files beneath a directory, paired with the artifact instance
 * (run-id + name) they came from. `download-artifacts.mjs` lays files out as
 * `coverage-results/<run-id>/<artifact-name>/...`; a single artifact can hold more than one
 * `lcov.info` (a cell that ran coverage across several Node.js versions writes one per version),
 * so the run-id distinguishes a rerun's reupload from those siblings.
 *
 * @param {string} dir
 * @param {Array<{ runId: string, name: string, lcovPath: string }>} out
 * @param {{ runId?: string, name?: string }} context
 * @returns {Array<{ runId: string, name: string, lcovPath: string }>}
 */
function collectLcovFiles (dir, out = [], context = {}) {
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
      collectLcovFiles(full, out, { runId, name })
    } else if (entry.name === 'lcov.info' && context.name?.startsWith(ARTIFACT_PREFIX)) {
      out.push({ runId: context.runId, name: context.name, lcovPath: full })
    }
  }
  return out
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
 * Reduce discovered lcov files to one cell per artifact name and bucket the cells by integration.
 * All Green reruns failed workflows, so the same artifact name can arrive from more than one run;
 * the newest run reflects the cell's final state, so older reuploads are dropped.
 *
 * @param {Array<{ runId: string, name: string, lcovPath: string }>} files
 * @returns {{ groups: Map<string, string[]>, lcovPathsByArtifact: Map<string, string[]>,
 *   cellsByIntegration: Map<string, string[]> }}
 */
function planCoverageGroups (files) {
  const newestRunByArtifact = new Map()
  for (const { runId, name } of files) {
    const previous = newestRunByArtifact.get(name)
    if (previous === undefined || runId > previous) {
      newestRunByArtifact.set(name, runId)
    }
  }

  const lcovPathsByArtifact = new Map()
  const cellsByIntegration = new Map()
  for (const { runId, name, lcovPath } of files) {
    if (runId !== newestRunByArtifact.get(name)) continue
    const existing = lcovPathsByArtifact.get(name)
    if (existing) {
      existing.push(lcovPath)
      continue
    }
    lcovPathsByArtifact.set(name, [lcovPath])
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

  const files = collectLcovFiles(INPUT_DIR)
  if (files.length === 0) {
    console.log(`No lcov.info files found under ${INPUT_DIR}/.`)
    return
  }

  const { groups, lcovPathsByArtifact, cellsByIntegration } = planCoverageGroups(files)

  console.log(`Routing ${lcovPathsByArtifact.size} cell report(s) into ${groups.size} group(s):`)
  for (const [flag, integrations] of [...groups].sort()) {
    let copied = 0
    for (const integration of integrations) {
      for (const artifact of cellsByIntegration.get(integration)) {
        for (const lcovPath of lcovPathsByArtifact.get(artifact)) {
          const destination = join(OUTPUT_DIR, flag, `${artifact}-${copied}.lcov`)
          mkdirSync(join(OUTPUT_DIR, flag), { recursive: true })
          copyFileSync(lcovPath, destination)
          copied++
        }
      }
    }
    console.log(`  ${flag} (${integrations.length} integration(s), ${copied} report(s))`)
  }

  writeFileSync(join(OUTPUT_DIR, 'groups.txt'), [...groups.keys()].sort().join('\n') + '\n')
}

export { flagOf, integrationOf, planCoverageGroups, planGroups }

if (argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
