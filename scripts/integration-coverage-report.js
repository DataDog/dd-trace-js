'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const { createCoverageMap } = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')
const { minimatch } = require('minimatch')
const v8ToIstanbul = require('v8-to-istanbul')

const nycConfig = require('../integration-tests/nyc-integration.config')

const REPO_ROOT = process.cwd()

function toPosixPath (value) {
  return value.split(path.sep).join('/')
}

function isFileUrl (value) {
  return typeof value === 'string' && value.startsWith('file://')
}

function normalizeScriptUrl (url) {
  if (!url || typeof url !== 'string') return null
  if (url.startsWith('node:') || url.startsWith('internal:')) return null
  if (url === '<anonymous>') return null
  if (isFileUrl(url)) return fileURLToPath(url)
  return url
}

function mapToRepoPath (filePath) {
  if (!filePath || !path.isAbsolute(filePath)) return filePath
  if (filePath.startsWith(REPO_ROOT)) return filePath

  const normalized = filePath.replace(/\\/g, '/')
  const markers = [
    '/node_modules/dd-trace/',
    '/packages/',
    '/integration-tests/'
  ]

  for (const marker of markers) {
    const idx = normalized.indexOf(marker)
    if (idx === -1) continue
    const rel = normalized.slice(idx + 1)
    const candidate = path.join(REPO_ROOT, rel)
    if (fs.existsSync(candidate)) return candidate
  }

  return filePath
}

function resolveCoverageDir (suiteName) {
  if (process.env.INTEGRATION_COVERAGE_DIR) return process.env.INTEGRATION_COVERAGE_DIR
  return path.join(process.cwd(), '.coverage', 'integration-v8', suiteName)
}

function resolveReportDir (suiteName) {
  return path.join(process.cwd(), 'coverage', `integration-${suiteName}`)
}

function resolveTempDir (suiteName) {
  return path.join(process.cwd(), '.nyc_output', `integration-${suiteName}`)
}

function getSuiteName () {
  const value = process.env.INTEGRATION_COVERAGE_NAME
  return value && value.trim() ? value.trim() : 'integration'
}

function matchesIncludeExclude (relPath, include, exclude) {
  if (include.length) {
    let matched = false
    for (const pattern of include) {
      if (minimatch(relPath, pattern, { dot: true })) {
        matched = true
        break
      }
    }
    if (!matched) return false
  }

  let excluded = false
  for (const pattern of exclude) {
    if (!pattern) continue
    const negated = pattern.startsWith('!')
    const glob = negated ? pattern.slice(1) : pattern
    if (!glob) continue
    if (minimatch(relPath, glob, { dot: true })) {
      excluded = !negated
    }
  }

  return !excluded
}

async function convertScriptCoverage (script, coverageMap, config) {
  const rawPath = normalizeScriptUrl(script.url)
  if (!rawPath || !path.isAbsolute(rawPath)) return
  const filePath = mapToRepoPath(rawPath)

  const relPath = toPosixPath(path.relative(config.cwd, filePath))
  if (relPath.startsWith('..')) return

  if (!matchesIncludeExclude(relPath, config.include, config.exclude)) return

  if (!fs.existsSync(filePath)) return

  const converter = v8ToIstanbul(filePath, 0, {
    source: fs.readFileSync(filePath, 'utf8')
  })
  await converter.load()
  converter.applyCoverage(script.functions || [])
  coverageMap.merge(converter.toIstanbul())
}

async function main () {
  const suiteName = getSuiteName()
  const coverageDir = resolveCoverageDir(suiteName)
  // TODO: ci-visibility tests don't spawn apps via helpers, so V8 coverage isn't emitted. Consider
  // a dedicated coverage hook for those suites or a separate coverage workflow.
  // TODO: profiler integration tests are excluded from coverage for now because OOM/exporter
  // subprocesses and telemetry batching make coverage collection flaky. Revisit when stabilized.
  if (!fs.existsSync(coverageDir)) {
    // eslint-disable-next-line no-console
    console.warn(`V8 coverage directory not found: ${coverageDir}`)
    return
  }

  const config = {
    cwd: REPO_ROOT,
    include: Array.isArray(nycConfig.include) ? nycConfig.include : [],
    exclude: Array.isArray(nycConfig.exclude) ? nycConfig.exclude : []
  }

  const files = fs.readdirSync(coverageDir).filter(file => file.endsWith('.json'))
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`No V8 coverage files found in ${coverageDir}`)
    return
  }

  const coverageMap = createCoverageMap({})
  for (const file of files) {
    const raw = fs.readFileSync(path.join(coverageDir, file), 'utf8')
    const data = JSON.parse(raw)
    const results = Array.isArray(data.result) ? data.result : []
    for (const script of results) {
      await convertScriptCoverage(script, coverageMap, config)
    }
  }

  const reportDir = resolveReportDir(suiteName)
  const tempDir = resolveTempDir(suiteName)
  fs.mkdirSync(reportDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  fs.writeFileSync(path.join(tempDir, 'coverage.json'), JSON.stringify(coverageMap.toJSON()))

  const context = libReport.createContext({ dir: reportDir, coverageMap })
  reports.create('text').execute(context)
  reports.create('lcov').execute(context)
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error.stack || error.message)
  process.exit(1)
})
