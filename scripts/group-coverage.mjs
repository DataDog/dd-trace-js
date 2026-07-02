import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

/* eslint-disable no-console */

// Sorts the per-cell `coverage-*` artifacts that `download-artifacts.mjs` placed under
// `coverage-results/` into one directory per top-level area under `coverage-upload/<area>/`, so the
// All Green upload steps send a handful of grouped reports to Codecov/Datadog instead of one per
// matrix cell (400+). Codecov silently parks uploads past its ~150-per-commit ceiling in `started`
// (never merged), so the cell-per-upload model dropped coverage; grouping by area keeps the upload
// count in the low teens no matter how many integrations or matrix cells a workflow adds.
//
// The reports are not merged here — both backends merge same-flag uploads server-side, so this only
// routes each cell's already-patched `lcov.info` into its area's directory. That keeps the harness
// free of any istanbul dependency in All Green's sparse checkout and passes each report through
// byte-for-byte, so the `getLineCoverage` patch the producers baked in survives untouched.
//
// Grouping is by area (one flag per workflow, e.g. `appsec`, `apm-integrations`), not by individual
// integration: `.codecov.yml` only gates the separate `master-coverage` flag (attached to every
// upload regardless of area), so a per-integration flag carried no gating weight of its own — it
// only fed a "coverage by plugin" breakdown in the Codecov/Datadog UI. Areas keep that breakdown at
// the workflow level while cutting the upload count, and therefore All Green's wall time, by an
// order of magnitude.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'
// `upload-coverage-artifact` names each cell `coverage-<flag>__<job>-<job-index>`; the `__` separates
// the grouping flag from the per-cell uniqueness suffix so two matrix cells sharing a flag (cypress
// varies `spec` outside its flag) still upload distinct artifacts instead of clobbering each other.
const UNIQUE_SEPARATOR = '__'

// Every area a coverage flag can start with, longest first so a compound area (`apm-integrations`)
// matches before a shorter prefix (`apm`) would. Sourced from the `flags:` values set across
// .github/workflows/*.yml — one area per workflow file that reports coverage.
const AREAS = [
  'apm-integrations',
  'apm-capabilities',
  'test-optimization',
  'instrumentations',
  'serverless',
  'openfeature',
  'profiling',
  'platform',
  'debugger',
  'aiguard',
  'appsec',
  'llmobs',
]

/**
 * The top-level area a per-cell flag belongs to (e.g. `apm-integrations-kafkajs-18` → `apm-integrations`).
 * Falls back to the flag's first token when it doesn't match a known area, so an unrecognized flag
 * still lands in a small group of its own instead of silently disappearing.
 *
 * @param {string} flag
 * @returns {string}
 */
function areaOf (flag) {
  const area = AREAS.find(candidate => flag === candidate || flag.startsWith(`${candidate}-`))
  return area ?? flag.split('-')[0]
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

// Codecov reads branch/function coverage from istanbul's JSON; Datadog only ingests the lcov. Each
// report is routed by format into its own subdirectory so the two upload steps search the one their
// backend reads. The extension marks which.
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
 * Reduce discovered report files to one cell per artifact name and bucket the cells by area. All
 * Green reruns failed workflows, so the same artifact name can arrive from more than one run; the
 * newest run reflects the cell's final state, so older reuploads are dropped.
 *
 * @param {Array<{ runId: string, name: string, format: string, reportPath: string }>} files
 * @returns {{ reportsByArtifact: Map<string, Array<{ format: string, reportPath: string }>>,
 *   cellsByArea: Map<string, string[]> }}
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
  const cellsByArea = new Map()
  for (const { runId, name, format, reportPath } of files) {
    if (runId !== newestRunByArtifact.get(name)) continue
    const existing = reportsByArtifact.get(name)
    if (existing) {
      existing.push({ format, reportPath })
      continue
    }
    reportsByArtifact.set(name, [{ format, reportPath }])
    const area = areaOf(flagOf(name))
    const owned = cellsByArea.get(area)
    if (owned) {
      owned.push(name)
    } else {
      cellsByArea.set(area, [name])
    }
  }

  return { reportsByArtifact, cellsByArea }
}

function main () {
  rmSync(OUTPUT_DIR, { force: true, recursive: true })

  const files = collectCoverageFiles(INPUT_DIR)
  if (files.length === 0) {
    console.log(`No coverage reports found under ${INPUT_DIR}/.`)
    return
  }

  const { reportsByArtifact, cellsByArea } = planCoverageGroups(files)

  console.log(`Routing ${reportsByArtifact.size} cell report set(s) into ${cellsByArea.size} area(s):`)
  for (const [area, artifacts] of [...cellsByArea].sort()) {
    const counts = new Map()
    for (const artifact of artifacts) {
      for (const { format, reportPath } of reportsByArtifact.get(artifact)) {
        const index = counts.get(format) ?? 0
        const formatDir = join(OUTPUT_DIR, area, format)
        mkdirSync(formatDir, { recursive: true })
        copyFileSync(reportPath, join(formatDir, `${artifact}-${index}.${format}`))
        counts.set(format, index + 1)
      }
    }
    const summary = [...counts].map(([format, count]) => `${count} ${format}`).join(', ')
    console.log(`  ${area} (${artifacts.length} cell(s): ${summary})`)
  }

  writeFileSync(join(OUTPUT_DIR, 'groups.txt'), [...cellsByArea.keys()].sort().join('\n') + '\n')
}

export { areaOf, flagOf, planCoverageGroups }

if (argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
