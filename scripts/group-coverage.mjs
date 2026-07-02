import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

/* eslint-disable no-console */

// Sorts the per-cell `coverage-*` artifacts that `download-artifacts.mjs` placed under
// `coverage-results/` into a single directory under `coverage-upload/`, so the All Green upload
// steps send one report per backend instead of one per matrix cell (400+). Codecov silently parks
// uploads past its ~150-per-commit ceiling in `started` (never merged), so the cell-per-upload
// model dropped coverage; a single upload keeps the count well under that ceiling no matter how
// many integrations or matrix cells a workflow adds.
//
// The reports are not merged here — both backends merge same-flag uploads server-side, so this only
// copies each cell's already-patched `lcov.info`/`coverage-final.json` into the shared directory.
// That keeps the harness free of any istanbul dependency in All Green's sparse checkout and passes
// each report through byte-for-byte, so the `getLineCoverage` patch the producers baked in survives
// untouched.
//
// Per-integration/per-area flags were dropped: `.codecov.yml` only gates the separate
// `master-coverage` flag (attached to every upload regardless of grouping), so a finer-grained flag
// carried no gating weight of its own — it only fed a "coverage by plugin" breakdown in the
// Codecov/Datadog UI, which wasn't worth the extra upload round trips.

const INPUT_DIR = 'coverage-results'
const OUTPUT_DIR = 'coverage-upload'
const ARTIFACT_PREFIX = 'coverage-'

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

function main () {
  rmSync(OUTPUT_DIR, { force: true, recursive: true })

  const files = collectCoverageFiles(INPUT_DIR)
  if (files.length === 0) {
    console.log(`No coverage reports found under ${INPUT_DIR}/.`)
    return
  }

  const { reportsByArtifact, artifacts } = planCoverageGroups(files)

  console.log(`Routing ${reportsByArtifact.size} cell report set(s) into ${OUTPUT_DIR}/.`)
  const counts = new Map()
  for (const artifact of artifacts) {
    for (const { format, reportPath } of reportsByArtifact.get(artifact)) {
      const index = counts.get(format) ?? 0
      const formatDir = join(OUTPUT_DIR, format)
      mkdirSync(formatDir, { recursive: true })
      copyFileSync(reportPath, join(formatDir, `${artifact}-${index}.${format}`))
      counts.set(format, index + 1)
    }
  }
  const summary = [...counts].map(([format, count]) => `${count} ${format}`).join(', ')
  console.log(`  ${artifacts.length} cell(s): ${summary}`)

  writeFileSync(join(OUTPUT_DIR, 'groups.txt'), 'coverage\n')
}

export { planCoverageGroups }

if (argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
