'use strict'

const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const log = require('../../dd-trace/src/log')
const { getTestSuitePath } = require('../../dd-trace/src/plugins/util/test')

const COVERAGE_BACKFILL_ANCHOR_SUITE_COUNT = 1
const COVERAGE_BACKFILL_CACHE_DIRECTORY = 'dd-trace-coverage-backfill'
const COVERAGE_DATA_MARKER = 'var coverageData = '

// Converts a backend coverage filename into a repository-relative path Jest can resolve.
function getCoverageBackfillRelativeFile (filename, rootDir) {
  if (!filename) return

  const relativeFile = path.isAbsolute(filename)
    ? getTestSuitePath(filename, rootDir)
    : filename
  const normalizedRelativeFile = path.posix.normalize(relativeFile.replaceAll('\\', '/'))
  if (
    normalizedRelativeFile === '..' ||
    normalizedRelativeFile.startsWith('../')
  ) {
    return
  }

  return normalizedRelativeFile.startsWith('./') ? normalizedRelativeFile.slice(2) : normalizedRelativeFile
}

// Builds the unique set of backend-covered files that should be seeded into Jest's coverage map.
function getCoverageBackfillCoveredFiles (skippedCoverage, rootDir) {
  const coveredFiles = new Set()
  for (const filename of Object.keys(skippedCoverage || {})) {
    const relativeFile = getCoverageBackfillRelativeFile(filename, rootDir)
    if (relativeFile) {
      coveredFiles.add(relativeFile)
    }
  }
  return coveredFiles
}

// Returns collectCoverageFrom-style entries only when this run actually skipped suites.
function getCoverageBackfillCollectCoverageFrom ({
  skippedSuites,
  skippedCoverage,
  rootDir,
}) {
  if (!skippedSuites.length) return

  const coveredFiles = getCoverageBackfillCoveredFiles(skippedCoverage, rootDir)
  return coveredFiles.size ? [...coveredFiles] : undefined
}

// Turns repository-relative backend paths into absolute paths for Jest's transformer.
function getCoverageBackfillAbsoluteFiles (rootDir, collectCoverageFrom) {
  const absoluteFiles = []
  for (const file of collectCoverageFrom || []) {
    absoluteFiles.push(path.join(rootDir, file))
  }
  return absoluteFiles
}

// Uses a separate Jest cache directory so synthetic instrumentation does not affect user caches.
function getCoverageBackfillConfig (config) {
  if (!config?.cacheDirectory) return config

  return {
    ...config,
    cacheDirectory: path.join(config.cacheDirectory, COVERAGE_BACKFILL_CACHE_DIRECTORY),
  }
}

// Extracts SWC coverage metadata when istanbul-lib-instrument cannot read it directly.
function extractCoverageDataObject (code) {
  const start = code.indexOf(COVERAGE_DATA_MARKER)
  if (start === -1) return

  let depth = 0
  let quote
  let escaped = false
  let index = start + COVERAGE_DATA_MARKER.length
  for (; index < code.length; index++) {
    const char = code[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        index++
        break
      }
    }
  }
  if (depth !== 0) return

  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${code.slice(start + COVERAGE_DATA_MARKER.length, index)})`)()
  } catch {}
}

// Reads Istanbul coverage metadata from transformed source code.
function getCoverageDataFromCode (code, readInitialCoverage) {
  return readInitialCoverage(code)?.coverageData || extractCoverageDataObject(code)
}

// Adds backend-covered files that did not run locally to Jest's Istanbul coverage map.
async function addCoverageBackfillUntestedFiles ({
  coverageReporter,
  testContexts,
  rootDir,
  CoverageReporter,
  collectCoverageFrom,
}) {
  if (!collectCoverageFrom?.length || !coverageReporter?._coverageMap || !rootDir) return

  const coverageWorkerRequire = createRequire(
    `${path.join(path.dirname(CoverageReporter.filename), 'CoverageWorker')}.js`
  )
  const { createScriptTransformer } = coverageWorkerRequire('@jest/transform')
  const { readInitialCoverage } = coverageWorkerRequire('istanbul-lib-instrument')
  const { createFileCoverage } = coverageWorkerRequire('istanbul-lib-coverage')
  const processedFiles = new Set()
  const files = getCoverageBackfillAbsoluteFiles(rootDir, collectCoverageFrom)
  if (files.length === 0) return

  for (const context of testContexts || []) {
    const config = getCoverageBackfillConfig(context.config)
    // eslint-disable-next-line no-await-in-loop
    const transformer = await createScriptTransformer(config)

    for (const file of files) {
      if (processedFiles.has(file) || coverageReporter._coverageMap.data[file]) continue

      try {
        // eslint-disable-next-line no-await-in-loop
        const { code } = await transformer.transformSourceAsync(file, readFileSync(file, 'utf8'), {
          instrument: true,
          supportsDynamicImport: true,
          supportsExportNamespaceFrom: true,
          supportsStaticESM: true,
          supportsTopLevelAwait: true,
        })
        const coverageData = getCoverageDataFromCode(code, readInitialCoverage)
        if (coverageData) {
          coverageReporter._coverageMap.addFileCoverage(createFileCoverage(coverageData))
          processedFiles.add(file)
        }
      } catch (err) {
        log.debug('Error generating coverage backfill for %s: %s', file, err.message)
      }
    }
  }
}

module.exports = {
  COVERAGE_BACKFILL_ANCHOR_SUITE_COUNT,
  addCoverageBackfillUntestedFiles,
  getCoverageBackfillCollectCoverageFrom,
}
