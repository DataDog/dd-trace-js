'use strict'

const fs = require('fs')
const path = require('path')

const satisfies = require('../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../version')
const {
  getFrameworkDefinitions,
  runDiagnosis,
} = require('../diagnose')

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
  const report = runDiagnosis({ root: manifest.repository.root })
  const reportPath = path.join(out, 'static-diagnosis.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
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

  const staticVersionError = findStaticVersionError(definition, diagnosis)
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

function findStaticVersionError (definition, diagnosis) {
  const results = Array.isArray(diagnosis.results) ? diagnosis.results : []
  return results.find(result => {
    return result.status === 'error' &&
      typeof result.title === 'string' &&
      result.title.startsWith(`${definition.name} `) &&
      result.title.includes(' is not supported')
  })
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
