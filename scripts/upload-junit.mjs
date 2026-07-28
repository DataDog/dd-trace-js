import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runUpload } from './run-upload.mjs'

const OUTPUT_DIR = 'junit-upload'

// One sibling workflow's upload bundles every matrix cell's (e.g. per-Node-version) junit XML
// together, so a per-test tag is the only way to tell which cell a result came from — the CI job
// name/ID tags datadog-ci attaches are the same for every file in one upload call.
// `.mochamultireporterrc.js` stamps each testsuite with a `node_version` property; this lifts it
// into a real tag using the xpath pattern datadog-ci documents for `<property>` extraction.
const NODE_VERSION_XPATH_TAG = "test.node_version=/testcase/..//property[@name='node_version']/@value"

/**
 * Recursively collect every junit XML file beneath a directory. `download-artifacts.mjs` lays
 * files out as `junit-results/<run-id>/<artifact-name>/*.xml`, one artifact per matrix cell.
 *
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function collectJunitFiles (dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectJunitFiles(full, out)
    } else if (entry.name.endsWith('.xml')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Parse a `<testsuites ...>` opening tag's attributes into a plain object.
 *
 * @param {string} attrsString
 * @returns {Record<string, string>}
 */
function parseRootAttrs (attrsString) {
  const attrs = {}
  for (const match of attrsString.matchAll(/(\w+)="([^"]*)"/g)) attrs[match[1]] = match[2]
  return attrs
}

/**
 * Merge every matrix cell's junit report into a single document, concatenating each report's
 * `<testsuite>` children under one `<testsuites>` root instead of uploading one file per cell —
 * every testcase already carries its own `node_version` property (see `NODE_VERSION_XPATH_TAG`),
 * so cells stay distinguishable after merging. The root's `time`/`tests`/`failures`/`skipped`
 * totals are recomputed across every report; unlike those, the root `name` isn't run-specific, so
 * the first report's value is kept as-is.
 *
 * @param {string[]} reportPaths
 * @returns {string}
 */
function mergeJunit (reportPaths) {
  let name
  let inner = ''
  const totals = { time: 0, tests: 0, failures: 0, skipped: 0 }

  for (const reportPath of reportPaths) {
    const contents = readFileSync(reportPath, 'utf8')
    const match = contents.match(/<testsuites([^>]*)>([\s\S]*)<\/testsuites>\s*$/)
    if (!match) continue

    const [, attrsString, reportInner] = match
    const attrs = parseRootAttrs(attrsString)
    if (name === undefined && attrs.name) name = attrs.name
    for (const key of Object.keys(totals)) totals[key] += Number(attrs[key]) || 0
    inner += reportInner
  }
  name ??= 'Mocha Tests'

  const skippedAttr = totals.skipped > 0 ? ` skipped="${totals.skipped}"` : ''
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites name="${name}" time="${totals.time.toFixed(3)}" tests="${totals.tests}" ` +
    `failures="${totals.failures}"${skippedAttr}>${inner}</testsuites>\n`
}

/**
 * Upload one workflow run's downloaded junit reports to Datadog, if it produced any. Every matrix
 * cell's report is merged into a single file before upload instead of letting `--auto-discovery`
 * upload each cell's file separately — one HTTP request per uploaded file, capped at
 * datadog-ci's default concurrency of 20, was the dominant cost for workflows with hundreds of
 * matrix cells.
 *
 * @param {{ id: number, name: string }} run
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadJunit (run) {
  const junitDir = join('junit-results', String(run.id))
  if (!existsSync(junitDir)) return []

  const reportPaths = collectJunitFiles(junitDir)
  if (reportPaths.length === 0) return []

  const outputDir = join(OUTPUT_DIR, String(run.id))
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'junit.xml'), mergeJunit(reportPaths))

  const result = await runUpload('datadog-ci', [
    'junit', 'upload', '--service', 'dd-trace-js-tests', '--auto-discovery', outputDir,
    '--xpath-tag', NODE_VERSION_XPATH_TAG,
  ])
  return [result]
}

export { mergeJunit }
