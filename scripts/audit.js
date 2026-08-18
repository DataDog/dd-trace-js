'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { getBunBinary } = require('./bun')

const severities = ['info', 'low', 'moderate', 'high', 'critical']
const defaultAllowlist = path.join(__dirname, '..', '.github', 'audit-allowlist.json')

/**
 * @typedef {{ id: string, package: string, reason: string }} AcceptedAdvisory
 * @typedef {{ level: string, allow: AcceptedAdvisory[] }} AuditConfig
 * @typedef {{ id: string, package: string, severity: string, title: string }} AuditAdvisory
 */

/**
 * @param {string[]} arguments_
 * @returns {{ allowlistPath: string, directories: string[] }}
 */
function parseArguments (arguments_) {
  let allowlistPath = defaultAllowlist
  const directories = []

  for (let i = 0; i < arguments_.length; i++) {
    if (arguments_[i] === '--allowlist') {
      i++
      if (arguments_[i] === undefined) throw new Error('--allowlist needs a path.')
      allowlistPath = path.resolve(arguments_[i])
    } else {
      directories.push(arguments_[i])
    }
  }

  return { allowlistPath, directories }
}

/**
 * @param {string} url
 * @returns {string}
 */
function getGhsaId (url) {
  return url.slice(url.lastIndexOf('/') + 1)
}

/**
 * @param {string} directory
 * @returns {Map<string, AuditAdvisory>}
 */
function runAudit (directory) {
  const result = spawnSync(getBunBinary(), ['audit', '--json'], {
    cwd: path.resolve(directory),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (!result.stdout?.trim()) {
    throw new Error(`\`bun audit\` produced no output in '${directory}':\n${result.stderr}`)
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`Could not parse \`bun audit --json\` output in '${directory}':\n${result.stdout}`, {
      cause: error,
    })
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error(`\`bun audit --json\` returned an invalid report in '${directory}'.`)
  }

  /** @type {Map<string, AuditAdvisory>} */
  const advisories = new Map()
  for (const [packageName, entries] of Object.entries(report)) {
    for (const advisory of Array.isArray(entries) ? entries : [entries]) {
      if (!advisory?.url) throw new Error(`Advisory for ${packageName} in '${directory}' has no URL.`)

      const id = getGhsaId(String(advisory.url))
      if (!severities.includes(advisory.severity)) {
        throw new Error(`Advisory ${id} in '${directory}' reports unknown severity '${advisory.severity}'.`)
      }
      const existing = advisories.get(id)
      if (existing) {
        throw new Error(
          `Advisory ${id} in '${directory}' is reported for both ${existing.package} and ${packageName}.`
        )
      }
      advisories.set(id, {
        id,
        package: packageName,
        severity: advisory.severity,
        title: advisory.title,
      })
    }
  }

  if (result.status !== 0 && advisories.size === 0) {
    throw new Error(`\`bun audit\` failed in '${directory}':\n${result.stderr || result.stdout}`)
  }

  return advisories
}

/**
 * @param {string} directory
 * @param {AuditConfig} config
 * @param {string} allowlistLabel
 * @returns {string[]}
 */
function auditDirectory (directory, config, allowlistLabel) {
  const threshold = severities.indexOf(config.level)
  if (threshold === -1) throw new Error(`Unknown level '${config.level}' for '${directory}'.`)

  const allowed = new Map()
  for (const entry of config.allow) {
    if (!entry.reason?.trim()) throw new Error(`Allowlist entry ${entry.id} for '${directory}' needs a reason.`)
    if (allowed.has(entry.id)) throw new Error(`Allowlist entry ${entry.id} for '${directory}' is duplicated.`)
    allowed.set(entry.id, entry)
  }

  const advisories = runAudit(directory)
  const problems = []

  for (const advisory of advisories.values()) {
    const accepted = allowed.get(advisory.id)
    if (accepted && accepted.package !== advisory.package) {
      problems.push(
        `${directory}: accepted advisory ${advisory.id} names ${accepted.package}, but Bun reports ` +
        `${advisory.package}. Update ${allowlistLabel}.`
      )
      continue
    }
    if (accepted || severities.indexOf(advisory.severity) < threshold) continue

    problems.push(
      `${directory}: unaccepted ${advisory.severity} advisory ${advisory.id} in ${advisory.package} ` +
      `(${advisory.title}). Resolve a patched version, or add it to ${allowlistLabel} with a reason.`
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

const { allowlistPath, directories: requestedDirectories } = parseArguments(process.argv.slice(2))
const allowlistLabel = path.relative(process.cwd(), allowlistPath)
const { directories } = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const selectedDirectories = requestedDirectories.length > 0 ? requestedDirectories : Object.keys(directories)
const problems = []

for (const directory of selectedDirectories) {
  /** @type {AuditConfig | undefined} */
  const config = directories[directory]
  if (!config) throw new Error(`'${directory}' has no entry in ${allowlistLabel}.`)
  problems.push(...auditDirectory(directory, config, allowlistLabel))
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

console.log(`No unaccepted advisories in: ${selectedDirectories.join(', ')}`)
