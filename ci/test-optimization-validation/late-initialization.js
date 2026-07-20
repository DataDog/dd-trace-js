'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_FILE_BYTES = 512 * 1024
const SCRIPT_LITERAL_PATTERN = /['"]([^'"]+\.[cm]?[jt]sx?)['"]/g

/**
 * Finds Test Optimization initialization loaded from a Vitest setup file.
 *
 * @param {object} manifest normalized manifest
 * @param {object} framework manifest framework
 * @returns {{configFile: string, setupFile: string}[]} late initialization evidence
 */
function findLateInitialization (manifest, framework) {
  if (framework.framework !== 'vitest') return []

  const findings = []
  const seen = new Set()
  for (const configFile of framework.project?.configFiles || []) {
    const config = readSmallFile(configFile)
    if (!config || !/\bsetupFiles\b/.test(config)) continue

    if (/setupFiles[\s\S]{0,1000}?dd-trace\/ci\/init/.test(config)) {
      addFinding(findings, seen, configFile, 'dd-trace/ci/init')
    }

    for (const match of config.matchAll(SCRIPT_LITERAL_PATTERN)) {
      for (const candidate of getSetupFileCandidates(manifest.repository.root, configFile, match[1])) {
        const setup = readSmallFile(candidate)
        if (!setup || !/dd-trace\/ci\/init/.test(setup)) continue
        addFinding(findings, seen, configFile, candidate)
      }
    }
  }
  return findings
}

function getSetupFileCandidates (repositoryRoot, configFile, filename) {
  if (path.isAbsolute(filename)) return [filename]
  return [
    path.resolve(path.dirname(configFile), filename),
    path.resolve(repositoryRoot, filename),
  ]
}

function readSmallFile (filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

function addFinding (findings, seen, configFile, setupFile) {
  const key = `${configFile}:${setupFile}`
  if (seen.has(key)) return
  seen.add(key)
  findings.push({ configFile, setupFile })
}

module.exports = { findLateInitialization }
