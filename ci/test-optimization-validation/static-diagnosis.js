'use strict'

const path = require('path')

const satisfies = require('../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../version')
const {
  getFrameworkDefinitions,
  runDiagnosis,
} = require('../diagnose')
const { sanitizeForReport } = require('./redaction')
const { writeFileSafely } = require('./safe-files')

const SUPPORTED_FRAMEWORKS = new Set([
  'jest',
  'mocha',
  'cucumber',
  'cypress',
  'playwright',
  'vitest',
])

const UNSUPPORTED_FRAMEWORK_NAMES = {
  ava: 'AVA',
  jasmine: 'Jasmine',
  karma: 'Karma',
  'node:test': 'Node.js test runner',
  tap: 'tap',
  testcafe: 'TestCafe',
  uvu: 'uvu',
}

function runStaticDiagnosis ({ manifest, out }) {
  const report = runDiagnosis({ root: manifest.repository.root, excludePaths: [out] })
  const reportPath = path.join(out, 'static-diagnosis.json')
  writeFileSafely(
    out,
    reportPath,
    `${JSON.stringify(sanitizeForReport(report), null, 2)}\n`,
    'static diagnosis artifact'
  )
  return { report, reportPath }
}

function getStaticBlocker (framework, diagnosis) {
  if (!SUPPORTED_FRAMEWORKS.has(framework.framework)) {
    return {
      reason: `Unsupported test framework detected: ${getUnsupportedFrameworkName(framework)}.`,
      recommendation: 'Choose Jest, Mocha, Cucumber, Cypress, Playwright, or Vitest for live validation.',
    }
  }

  const definition = getFrameworkDefinition(framework, diagnosis)
  if (!definition) return null

  const version = parseVersion(framework.frameworkVersion)
  if (version && !satisfies(version, definition.supportedRange)) {
    return {
      reason:
        `${definition.name} ${version} is not supported. Supported range is ${definition.supportedRange}.`,
      recommendation: definition.recommendation,
    }
  }

  const staticVersionError = findStaticVersionError(definition, diagnosis, framework, version)
  if (staticVersionError) {
    return {
      reason: staticVersionError.title,
      recommendation: staticVersionError.recommendation || staticVersionError.message,
    }
  }

  return null
}

function getFrameworkDefinition (framework, diagnosis) {
  const definitions = getFrameworkDefinitions(diagnosis.ddTraceMajor || DD_MAJOR)
  return definitions.find(definition => definition.id === framework.framework)
}

function getUnsupportedFrameworkName (framework) {
  return UNSUPPORTED_FRAMEWORK_NAMES[framework.framework] || framework.framework || framework.id
}

function findStaticVersionError (definition, diagnosis, framework, manifestVersion) {
  const results = Array.isArray(diagnosis.results) ? diagnosis.results : []
  return results.find(result => {
    return result.status === 'error' &&
      typeof result.title === 'string' &&
      result.title.startsWith(`${definition.name} `) &&
      result.title.includes(' is not supported') &&
      staticVersionErrorAppliesToFramework(result, diagnosis, framework, definition, manifestVersion)
  })
}

function staticVersionErrorAppliesToFramework (result, diagnosis, framework, definition, manifestVersion) {
  const locations = Array.isArray(result.locations) ? result.locations : []
  if (locations.length === 0) {
    return !(manifestVersion && satisfies(manifestVersion, definition.supportedRange))
  }

  return locations.some(location => locationMatchesFramework(location, diagnosis, framework))
}

function locationMatchesFramework (location, diagnosis, framework) {
  const relativeLocation = normalizeRelativePath(location)
  const exactLocations = getExactFrameworkLocations(diagnosis, framework)

  if (exactLocations.has(relativeLocation)) return true

  const projectRoot = getRelativeFrameworkProjectRoot(diagnosis, framework)
  return projectRoot !== '' &&
    (relativeLocation === projectRoot || relativeLocation.startsWith(`${projectRoot}/`))
}

function getExactFrameworkLocations (diagnosis, framework) {
  const locations = new Set()
  addRelativeFrameworkLocation(locations, diagnosis, framework.project?.packageJson)

  for (const configFile of framework.project?.configFiles || []) {
    addRelativeFrameworkLocation(locations, diagnosis, configFile)
  }

  return locations
}

function addRelativeFrameworkLocation (locations, diagnosis, location) {
  if (typeof location !== 'string' || location.length === 0) return
  locations.add(getRelativeLocation(diagnosis, location))
}

function getRelativeFrameworkProjectRoot (diagnosis, framework) {
  return getRelativeLocation(diagnosis, framework.project?.root)
}

function getRelativeLocation (diagnosis, location) {
  if (typeof location !== 'string' || location.length === 0) return ''
  const root = typeof diagnosis.root === 'string' ? diagnosis.root : ''
  const relativeLocation = path.isAbsolute(location) && root
    ? path.relative(root, location)
    : location

  return normalizeRelativePath(relativeLocation)
}

function normalizeRelativePath (location) {
  return location.split(path.sep).join('/').replace(/^\.\//, '')
}

function parseVersion (rawVersion) {
  if (typeof rawVersion !== 'string') return null
  const match = rawVersion.match(/\d+\.\d+\.\d+/)
  return match ? match[0] : null
}

module.exports = {
  getStaticBlocker,
  runStaticDiagnosis,
}
