'use strict'

const { readFileSync } = require('node:fs')
const path = require('node:path')

const COVERAGE_BACKFILL_CACHE_DIRECTORY = 'dd-trace-coverage-backfill'
const TRANSFORM_OPTIONS = {
  instrument: true,
  supportsDynamicImport: true,
  supportsExportNamespaceFrom: true,
  supportsStaticESM: true,
  supportsTopLevelAwait: true,
}

function getCoverageBackfillFiles (skippableSuitesCoverage, rootDir, getTestSuitePath) {
  const files = []
  for (const filename of Object.keys(skippableSuitesCoverage || {})) {
    const relativeFilename = path.isAbsolute(filename)
      ? getTestSuitePath(filename, rootDir)
      : filename
    files.push(relativeFilename)
  }
  return files
}

// Use a separate Jest cache namespace for synthetic backfill transforms so they cannot reuse or overwrite normal
// Jest transform cache entries produced during the user's test run.
function getCoverageBackfillConfig (config) {
  if (!config?.cacheDirectory) return config

  return {
    ...config,
    cacheDirectory: path.join(config.cacheDirectory, COVERAGE_BACKFILL_CACHE_DIRECTORY),
  }
}

function getCoverageBackfillDependencies (CoverageReporter, getCoverageBackfillRequire) {
  const coverageWorkerRequire = getCoverageBackfillRequire(CoverageReporter)

  return {
    createFileCoverage: coverageWorkerRequire('istanbul-lib-coverage').createFileCoverage,
    createScriptTransformer: coverageWorkerRequire('@jest/transform').createScriptTransformer,
    readInitialCoverage: coverageWorkerRequire('istanbul-lib-instrument').readInitialCoverage,
  }
}

// Some transformers expose Istanbul coverage as a literal that readInitialCoverage does not parse.
function extractCoverageDataObject (code) {
  const marker = 'var coverageData = '
  const start = code.indexOf(marker)
  if (start === -1) return

  let depth = 0
  let quote
  let escaped = false
  let index = start + marker.length
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
    return new Function(`return (${code.slice(start + marker.length, index)})`)()
  } catch {
    // Ignore transformer output that does not contain parseable Istanbul metadata.
  }
}

// Read the Istanbul file metadata emitted by Jest's transformer.
function getCoverageDataFromCode (code, readInitialCoverage) {
  return readInitialCoverage(code)?.coverageData || extractCoverageDataObject(code)
}

function transformFileWithTransformers (absoluteFile, sourceText, transformers, readInitialCoverage) {
  return Promise.all(transformers.map(transformer => {
    return transformer.transformSourceAsync(absoluteFile, sourceText, TRANSFORM_OPTIONS)
      .then(({ code }) => getCoverageDataFromCode(code, readInitialCoverage))
      .catch(() => {})
  })).then(coverageDataByContext => coverageDataByContext.find(Boolean))
}

function getBackfillCoverageDataForFile (file, rootDir, transformers, coverageMap, readInitialCoverage) {
  const absoluteFile = path.isAbsolute(file) ? file : path.join(rootDir, file)
  if (coverageMap.data[absoluteFile]) return Promise.resolve()

  let sourceText
  try {
    sourceText = readFileSync(absoluteFile, 'utf8')
  } catch {
    return Promise.resolve()
  }

  return transformFileWithTransformers(absoluteFile, sourceText, transformers, readInitialCoverage)
}

// Seed Jest's coverage map with files that did not run locally but are covered by backend meta.coverage.
function addCoverageBackfillUntestedFiles ({
  coverageMap,
  testContexts,
  rootDir,
  CoverageReporter,
  coverageBackfillFiles,
  getCoverageBackfillRequire,
}) {
  if (!coverageBackfillFiles?.length || !coverageMap || !rootDir) return Promise.resolve()

  let createFileCoverage, createScriptTransformer, readInitialCoverage
  try {
    ({
      createFileCoverage,
      createScriptTransformer,
      readInitialCoverage,
    } = getCoverageBackfillDependencies(CoverageReporter, getCoverageBackfillRequire))
  } catch {
    return Promise.resolve()
  }

  const contexts = [...(testContexts || [])]
  return Promise.all(contexts.map(context => {
    return createScriptTransformer(getCoverageBackfillConfig(context.config)).catch(() => {})
  }))
    .then(transformers => transformers.filter(Boolean))
    .then(transformers => {
      if (!transformers.length) return []
      return Promise.all(coverageBackfillFiles.map(file => {
        return getBackfillCoverageDataForFile(file, rootDir, transformers, coverageMap, readInitialCoverage)
      }))
    })
    .then(coverageDataByFile => {
      for (const coverageData of coverageDataByFile) {
        if (coverageData && !coverageMap.data[coverageData.path]) {
          coverageMap.addFileCoverage(createFileCoverage(coverageData))
        }
      }
    })
}

module.exports = {
  addCoverageBackfillUntestedFiles,
  getCoverageBackfillFiles,
}
