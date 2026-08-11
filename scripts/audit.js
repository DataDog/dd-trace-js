#!/usr/bin/env node

'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { getBunBinary } = require('./bun')

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const DEFAULT_ALLOWLIST = path.join(__dirname, '..', '.github', 'audit-allowlist.json')

/**
 * @param {string[]} arguments_
 * @returns {{ allowlistPath: string, directories: string[] }}
 */
function parseArguments (arguments_) {
  let allowlistPath = DEFAULT_ALLOWLIST
  const directories = []

  for (let index = 0; index < arguments_.length; index++) {
    if (arguments_[index] === '--allowlist') {
      allowlistPath = path.resolve(arguments_[++index])
    } else {
      directories.push(arguments_[index])
    }
  }

  if (directories.length === 0) throw new Error('Pass at least one directory to audit.')
  return { allowlistPath, directories }
}

/**
 * @param {string} directory
 * @returns {Array<{ id: string, package: string, severity: string, title: string }>}
 */
function runAudit (directory) {
  const result = spawnSync(getBunBinary(), ['audit', '--json'], {
    cwd: path.resolve(directory),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) throw result.error
  if (result.signal) throw new Error(`\`bun audit\` exited on ${result.signal} in '${directory}'.`)
  if (!result.stdout?.trim()) {
    throw new Error(`\`bun audit\` produced no output in '${directory}':\n${result.stderr}`)
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error(`Could not parse \`bun audit --json\` output in '${directory}':\n${result.stdout}`)
  }

  const advisories = []
  for (const [packageName, entries] of Object.entries(report)) {
    for (const advisory of [entries].flat()) {
      if (!advisory?.url) throw new Error(`Advisory for ${packageName} in '${directory}' has no URL.`)
      const id = String(advisory.url).split('/').pop()
      if (!SEVERITIES.includes(advisory.severity)) {
        throw new Error(`Advisory ${id} in '${directory}' reports unknown severity '${advisory.severity}'.`)
      }
      advisories.push({ id, package: packageName, severity: advisory.severity, title: advisory.title })
    }
  }

  if (result.status !== 0 && advisories.length === 0) {
    throw new Error(`\`bun audit\` failed without reporting an advisory in '${directory}':\n${result.stderr}`)
  }
  return advisories
}

/**
 * @typedef {object} AuditException
 * @property {string} id
 * @property {string} package
 * @property {string} reason
 */

/**
 * @param {string} directory
 * @param {{ level?: string, allow?: AuditException[] }} config
 * @param {string} allowlistLabel
 * @returns {string[]}
 */
function auditDirectory (directory, config, allowlistLabel) {
  const level = config.level ?? 'high'
  const threshold = SEVERITIES.indexOf(level)
  if (threshold === -1) throw new Error(`Unknown level '${level}' for '${directory}'.`)

  const allowed = new Map()
  if (config.allow) {
    for (const entry of config.allow) {
      if (allowed.has(entry.id)) throw new Error(`Duplicate exception ${entry.id} for '${directory}'.`)
      if (!entry.reason?.trim()) throw new Error(`Exception ${entry.id} for '${directory}' needs a reason.`)
      allowed.set(entry.id, entry)
    }
  }

  const matched = new Set()
  const problems = []
  for (const advisory of runAudit(directory)) {
    const exception = allowed.get(advisory.id)
    const severity = SEVERITIES.indexOf(advisory.severity)

    if (exception) {
      matched.add(exception.id)
      if (exception.package !== advisory.package) {
        problems.push(
          `${directory}: exception ${exception.id} expects package ${exception.package}, but Bun reported ` +
          `${advisory.package}.`
        )
      } else if (severity < threshold) {
        problems.push(
          `${directory}: exception ${exception.id} (${exception.package}) is below the ${level} threshold. ` +
          `Remove it from ${allowlistLabel}.`
        )
      }
      continue
    }

    if (severity >= threshold) {
      problems.push(
        `${directory}: unaccepted ${advisory.severity} advisory ${advisory.id} in ${advisory.package} ` +
        `(${advisory.title}). Resolve a patched version, or add it to ${allowlistLabel} with a reason.`
      )
    }
  }

  for (const exception of allowed.values()) {
    if (!matched.has(exception.id)) {
      problems.push(
        `${directory}: exception ${exception.id} (${exception.package}) is no longer reported. ` +
        `Remove it from ${allowlistLabel}.`
      )
    }
  }

  return problems
}

const { allowlistPath, directories } = parseArguments(process.argv.slice(2))
const allowlistLabel = path.relative(process.cwd(), allowlistPath)
const policy = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const problems = []

for (const directory of directories) {
  problems.push(...auditDirectory(directory, policy[directory] ?? {}, allowlistLabel))
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

console.log(`No unaccepted advisories in: ${directories.join(', ')}`)
