'use strict'

/* eslint-disable no-console */

// Wraps `bun audit` so an accepted advisory has to carry a written reason, and so an acceptance that is no longer
// needed fails instead of lingering. `bun audit --ignore <id>` accepts ids it never saw without complaining, so an
// inline ignore list keeps suppressing an advisory long after the dependency was patched and nothing ever reports that
// the entry is dead. Severity is resolved per directory because a moderate advisory in `vendor` is bundled and reaches
// customers, while the same severity in the dev-only trees does not.
//
//   node scripts/audit.js [--allowlist <path>] [<directory> ...]
//
// Directories resolve against the working directory and default to every directory the allowlist names.

const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { getBunBinary } = require('./bun')

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const DEFAULT_ALLOWLIST = path.join(__dirname, '..', '.github', 'audit-allowlist.json')

/**
 * @param {string[]} argv
 * @returns {{ allowlistPath: string, directories: string[] }}
 */
function parseArguments (argv) {
  let allowlistPath = DEFAULT_ALLOWLIST
  const directories = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allowlist') {
      allowlistPath = path.resolve(argv[++i])
    } else {
      directories.push(argv[i])
    }
  }
  return { allowlistPath, directories }
}

/**
 * @param {string} url
 * @returns {string} The GHSA identifier the advisory URL ends with.
 */
function ghsaId (url) {
  return String(url).split('/').pop()
}

/**
 * @param {string} directory
 * @returns {Map<string, { id: string, package: string, severity: string, title: string }>}
 */
function runAudit (directory) {
  const result = spawnSync(getBunBinary(), ['audit', '--json'], {
    cwd: path.resolve(directory),
    encoding: 'utf8',
    // `bun audit` exits non-zero whenever it finds anything, so the status alone cannot tell "advisories present" from
    // "the command failed"; parsing the report is what decides.
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (!result.stdout?.trim()) {
    // A clean tree still prints an empty object, so missing output means bun itself failed.
    throw new Error(`\`bun audit\` produced no output in '${directory}':\n${result.stderr ?? ''}`)
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error(`Could not parse \`bun audit --json\` output in '${directory}':\n${result.stdout}`)
  }

  const advisories = new Map()
  for (const [packageName, entries] of Object.entries(report)) {
    for (const advisory of [entries].flat()) {
      // Without a URL there is no GHSA id to match an acceptance against, and a synthesized one would silently never
      // match, so surface it instead.
      if (!advisory?.url) throw new Error(`Advisory for ${packageName} in '${directory}' has no URL to identify it.`)
      const id = ghsaId(advisory.url)
      advisories.set(id, { id, package: packageName, severity: advisory.severity, title: advisory.title })
    }
  }
  return advisories
}

/**
 * @param {string} directory
 * @param {{ level: string, allow: Array<{ id: string, package: string, reason: string }> }} config
 * @param {string} allowlistLabel
 * @returns {string[]} One description per failure, empty when the directory is clean.
 */
function auditDirectory (directory, config, allowlistLabel) {
  const threshold = SEVERITIES.indexOf(config.level)
  if (threshold === -1) throw new Error(`Unknown level '${config.level}' for '${directory}'`)

  const allowed = new Map()
  for (const entry of config.allow) {
    if (!entry.reason?.trim()) throw new Error(`Allowlist entry ${entry.id} for '${directory}' needs a reason.`)
    allowed.set(entry.id, entry)
  }

  const advisories = runAudit(directory)
  const problems = []

  for (const advisory of advisories.values()) {
    if (allowed.has(advisory.id) || SEVERITIES.indexOf(advisory.severity) < threshold) continue
    problems.push(
      `${directory}: unaccepted ${advisory.severity} advisory ${advisory.id} in ${advisory.package} ` +
      `(${advisory.title}). Resolve a patched version, or add it to ${allowlistLabel} with a reason why it cannot ` +
      'be resolved.'
    )
  }

  for (const entry of allowed.values()) {
    if (advisories.has(entry.id)) continue
    problems.push(
      `${directory}: accepted advisory ${entry.id} (${entry.package}) is no longer reported. ` +
      `Remove it from ${allowlistLabel}.`
    )
  }

  return problems
}

const { allowlistPath, directories: requested } = parseArguments(process.argv.slice(2))
const allowlistLabel = path.relative(process.cwd(), allowlistPath) || allowlistPath
const { directories } = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const selected = requested.length > 0 ? requested : Object.keys(directories)
const problems = []

for (const directory of selected) {
  const config = directories[directory]
  if (!config) throw new Error(`'${directory}' has no entry in ${allowlistLabel}.`)
  problems.push(...auditDirectory(directory, config, allowlistLabel))
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

console.log(`No unaccepted advisories in: ${selected.join(', ')}`)
