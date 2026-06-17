'use strict'

const path = require('path')

const FRAMEWORKS = new Set([
  'jest',
  'vitest',
  'mocha',
  'cucumber',
  'cypress',
  'playwright',
  'node:test',
  'ava',
  'tap',
  'jasmine',
  'karma',
  'uvu',
  'testcafe',
  'custom',
  'unknown',
])

const STATUSES = new Set([
  'runnable',
  'detected_not_runnable',
  'requires_external_service',
  'requires_manual_setup',
  'unsupported_by_validator',
  'unknown',
])

function validateManifest (manifest) {
  const errors = []

  if (!manifest || typeof manifest !== 'object') {
    return ['Manifest must be a JSON object.']
  }

  requiredString(manifest, 'schemaVersion', errors)
  requiredObject(manifest, 'repository', errors)
  requiredObject(manifest, 'environment', errors)
  requiredArray(manifest, 'frameworks', errors)

  if (manifest.repository) {
    requiredAbsolutePath(manifest.repository, 'root', errors)
  }

  if (Array.isArray(manifest.frameworks)) {
    for (const [index, framework] of manifest.frameworks.entries()) {
      validateFramework(framework, index, errors)
    }
  }

  return errors
}

function validateFramework (framework, index, errors) {
  const prefix = `frameworks[${index}]`
  requiredString(framework, 'id', errors, prefix)
  enumString(framework, 'framework', FRAMEWORKS, errors, prefix)
  enumString(framework, 'status', STATUSES, errors, prefix)
  requiredObject(framework, 'project', errors, prefix)

  if (framework.project) {
    requiredAbsolutePath(framework.project, 'root', errors, `${prefix}.project`)
  }

  if (framework.status === 'runnable') {
    requiredCommand(framework, 'existingTestCommand', errors, prefix)
  }

  if (framework.generatedTestStrategy) {
    validateGeneratedTestStrategy(framework.generatedTestStrategy, `${prefix}.generatedTestStrategy`, errors)
  }
}

function validateGeneratedTestStrategy (strategy, prefix, errors) {
  if (!['verified', 'proposed', 'not_possible'].includes(strategy.status)) {
    errors.push(`${prefix}.status must be verified, proposed, or not_possible.`)
  }

  if (strategy.status === 'verified') {
    requiredArray(strategy, 'files', errors, prefix)
    requiredArray(strategy, 'scenarios', errors, prefix)
    requiredArray(strategy, 'cleanupPaths', errors, prefix)
  }

  if (Array.isArray(strategy.files)) {
    for (const [index, file] of strategy.files.entries()) {
      requiredAbsolutePath(file, 'path', errors, `${prefix}.files[${index}]`)
      requiredArray(file, 'contentLines', errors, `${prefix}.files[${index}]`)
    }
  }

  if (Array.isArray(strategy.scenarios)) {
    for (const [index, scenario] of strategy.scenarios.entries()) {
      requiredString(scenario, 'id', errors, `${prefix}.scenarios[${index}]`)
      requiredCommand(scenario, 'runCommand', errors, `${prefix}.scenarios[${index}]`)
    }
  }
}

function requiredCommand (target, field, errors, prefix = '') {
  const value = target && target[field]
  const key = join(prefix, field)
  if (!value || typeof value !== 'object') {
    errors.push(`${key} must be an object.`)
    return
  }
  requiredAbsolutePath(value, 'cwd', errors, key)
  if (value.usesShell) {
    requiredString(value, 'shellCommand', errors, key)
  } else if (!Array.isArray(value.argv) || value.argv.length === 0) {
    errors.push(`${key}.argv must be a non-empty array unless usesShell is true.`)
  }
  if (value.timeoutMs !== undefined && (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) {
    errors.push(`${key}.timeoutMs must be a positive number when present.`)
  }
}

function requiredObject (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${join(prefix, field)} must be an object.`)
  }
}

function requiredArray (target, field, errors, prefix = '') {
  if (!Array.isArray(target && target[field])) {
    errors.push(`${join(prefix, field)} must be an array.`)
  }
}

function requiredString (target, field, errors, prefix = '') {
  if (typeof (target && target[field]) !== 'string' || target[field].length === 0) {
    errors.push(`${join(prefix, field)} must be a non-empty string.`)
  }
}

function enumString (target, field, values, errors, prefix = '') {
  if (!values.has(target && target[field])) {
    errors.push(`${join(prefix, field)} must be one of: ${[...values].join(', ')}.`)
  }
}

function requiredAbsolutePath (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    errors.push(`${join(prefix, field)} must be an absolute path.`)
  }
}

function join (prefix, field) {
  return prefix ? `${prefix}.${field}` : field
}

module.exports = { validateManifest }
