'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { parseArgs } = require('node:util')

const { cleanNycOutputDir } = require('./clean-nyc-sandbox-coverage')

const repoRootAbs = path.resolve(__dirname, '..')

/**
 * @returns {string|undefined}
 */
function autoDetectLatestNycOutputDir () {
  const entries = fs.readdirSync(repoRootAbs, { withFileTypes: true })
  /** @type {{ abs: string, mtimeMs: number }[]} */
  const candidates = []

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (!ent.name.startsWith('.nyc_output')) continue

    const abs = path.join(repoRootAbs, ent.name)
    const stat = fs.statSync(abs)
    candidates.push({ abs, mtimeMs: stat.mtimeMs })
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.abs
}

/**
 * @param {string} nycOutputDir
 * @returns {string}
 */
function defaultReportDirFromTempDir (nycOutputDir) {
  const base = path.basename(nycOutputDir)
  if (base.startsWith('.nyc_output-')) return path.join(repoRootAbs, `coverage-${base.slice('.nyc_output-'.length)}`)
  if (base.startsWith('.nyc_output')) return path.join(repoRootAbs, `coverage${base.slice('.nyc_output'.length)}`)
  return path.join(repoRootAbs, 'coverage')
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'nyc-output': { type: 'string' },
    'report-dir': { type: 'string' },
    'no-clean': { type: 'boolean' }
  }
})

let nycOutput = values['nyc-output'] || process.env.NYC_OUTPUT
if (!nycOutput) {
  nycOutput = autoDetectLatestNycOutputDir()
}
if (!nycOutput) {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: node scripts/regen-sandbox-coverage-report.js [--nyc-output <.nyc_output-...>] [--report-dir <dir>] [--no-clean]'
  )
  process.exitCode = 1
  return
}

const nycOutputAbs = path.resolve(repoRootAbs, nycOutput)
const reportDirAbs = values['report-dir']
  ? path.resolve(repoRootAbs, values['report-dir'])
  : defaultReportDirFromTempDir(nycOutputAbs)

if (!values['no-clean']) {
  cleanNycOutputDir(nycOutputAbs, { inPlace: true })
}

const nycBin = require.resolve('nyc/bin/nyc.js')
const result = childProcess.spawnSync(process.execPath, [
  nycBin,
  'report',
  '--cwd',
  repoRootAbs,
  '--temp-dir',
  nycOutputAbs,
  '--report-dir',
  reportDirAbs,
  '--reporter=html',
  '--reporter=lcov'
], {
  cwd: repoRootAbs,
  stdio: 'inherit'
})

if (result.status !== 0) {
  process.exitCode = result.status ?? 1
}

