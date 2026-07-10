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
const CI_WIRING_STATUSES = new Set([
  'pass',
  'fail',
  'skip',
  'unknown',
])
const UNRESOLVED_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/

const GENERATED_SCENARIO_IDS = new Set([
  'basic-pass',
  'atr-fail-once',
  'test-management-target',
])
const GENERATED_SCENARIO_EXIT_CODES = {
  'basic-pass': 0,
  'atr-fail-once': 1,
  'test-management-target': 0,
}

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

  if (manifest.ciDiscovery) {
    validateCiDiscovery(manifest.ciDiscovery, 'ciDiscovery', errors)
  }

  if (Array.isArray(manifest.frameworks)) {
    validateUniqueFrameworkIds(manifest.frameworks, errors)
    for (const [index, framework] of manifest.frameworks.entries()) {
      validateFramework(framework, index, errors)
    }
  }

  return errors
}

function validateCiDiscovery (ciDiscovery, prefix, errors) {
  if (!ciDiscovery || typeof ciDiscovery !== 'object' || Array.isArray(ciDiscovery)) {
    errors.push(`${prefix} must be an object when present.`)
    return
  }

  for (const field of ['searched', 'found', 'staticFound', 'warnings', 'notes', 'contradictions']) {
    if (ciDiscovery[field] !== undefined) {
      if (Array.isArray(ciDiscovery[field])) {
        validateStringArray(ciDiscovery, field, errors, prefix)
      } else {
        errors.push(`${prefix}.${field} must be an array when present.`)
      }
    }
  }

  if (ciDiscovery.method !== undefined && typeof ciDiscovery.method !== 'string') {
    errors.push(`${prefix}.method must be a string when present.`)
  }
}

function validateFramework (framework, index, errors) {
  const prefix = `frameworks[${index}]`
  requiredString(framework, 'id', errors, prefix)
  enumString(framework, 'framework', FRAMEWORKS, errors, prefix)
  enumString(framework, 'status', STATUSES, errors, prefix)
  requiredObject(framework, 'project', errors, prefix)

  if (framework.project) {
    requiredAbsolutePath(framework.project, 'root', errors, `${prefix}.project`)
    optionalAbsolutePath(framework.project, 'packageJson', errors, `${prefix}.project`)
    optionalAbsolutePathArray(framework.project, 'configFiles', errors, `${prefix}.project`)
  }

  if (framework.status === 'runnable') {
    requiredCommand(framework, 'existingTestCommand', errors, prefix)
    validateDatadogCleanCommand(framework.existingTestCommand, `${prefix}.existingTestCommand`, errors)
    requiredObject(framework, 'preflight', errors, prefix)
    requiredObject(framework, 'ciWiring', errors, prefix)
  } else {
    requireNonEmptyNotes(framework, errors, prefix)
  }

  if (framework.ciWiringCommand) {
    requiredCommand(framework, 'ciWiringCommand', errors, prefix)
  }

  if (framework.ciWiring) {
    validateCiWiring(framework, prefix, errors)
  }

  if (framework.forcedLocalCommand) {
    requiredCommand(framework, 'forcedLocalCommand', errors, prefix)
    validateDatadogCleanCommand(framework.forcedLocalCommand, `${prefix}.forcedLocalCommand`, errors)
  }

  if (framework.setup?.commands) {
    if (Array.isArray(framework.setup.commands)) {
      for (const [commandIndex, command] of framework.setup.commands.entries()) {
        requiredCommand({ command }, 'command', errors, `${prefix}.setup.commands[${commandIndex}]`)
      }
    } else {
      errors.push(`${prefix}.setup.commands must be an array.`)
    }
  }

  if (framework.generatedTestStrategy) {
    validateGeneratedTestStrategy(framework.generatedTestStrategy, `${prefix}.generatedTestStrategy`, errors)
  }
}

function validateGeneratedTestStrategy (strategy, prefix, errors) {
  if (!['planned', 'verified', 'proposed', 'not_possible'].includes(strategy.status)) {
    errors.push(`${prefix}.status must be planned, verified, proposed, or not_possible.`)
  }

  const completeStrategy = strategy.status === 'planned' || strategy.status === 'verified'
  if (completeStrategy) {
    requiredArray(strategy, 'files', errors, prefix)
    requiredArray(strategy, 'scenarios', errors, prefix)
    requiredArray(strategy, 'cleanupPaths', errors, prefix)
    validateCompleteGeneratedScenarioSet(strategy, prefix, errors)
  } else if ((strategy.status === 'proposed' || strategy.status === 'not_possible') &&
    (typeof strategy.reason !== 'string' || strategy.reason.trim() === '')) {
    errors.push(`${prefix}.reason must explain why the generated test strategy is ${strategy.status}.`)
  }

  if (Array.isArray(strategy.files)) {
    for (const [index, file] of strategy.files.entries()) {
      requiredAbsolutePath(file, 'path', errors, `${prefix}.files[${index}]`)
      requiredArray(file, 'contentLines', errors, `${prefix}.files[${index}]`)
      validateStringArray(file, 'contentLines', errors, `${prefix}.files[${index}]`)
    }
  }

  if (Array.isArray(strategy.scenarios)) {
    for (const [index, scenario] of strategy.scenarios.entries()) {
      requiredString(scenario, 'id', errors, `${prefix}.scenarios[${index}]`)
      enumString(scenario, 'id', GENERATED_SCENARIO_IDS, errors, `${prefix}.scenarios[${index}]`)
      requiredCommand(scenario, 'runCommand', errors, `${prefix}.scenarios[${index}]`)
      validateDatadogCleanCommand(scenario.runCommand, `${prefix}.scenarios[${index}].runCommand`, errors)
      validateScenarioIdentities(
        scenario,
        `${prefix}.scenarios[${index}]`,
        errors,
        completeStrategy
      )
      if (completeStrategy) {
        validateGeneratedScenarioOutcome(scenario, `${prefix}.scenarios[${index}]`, errors)
      }
    }
  }

  optionalAbsolutePath(strategy, 'testDirectory', errors, prefix)
  optionalAbsolutePathArray(strategy, 'cleanupPaths', errors, prefix)
}

function validateCiWiring (framework, prefix, errors) {
  const ciWiring = framework.ciWiring
  if (!ciWiring || typeof ciWiring !== 'object' || Array.isArray(ciWiring)) {
    errors.push(`${prefix}.ciWiring must be an object when present.`)
    return
  }

  if (!CI_WIRING_STATUSES.has(ciWiring.status)) {
    errors.push(`${prefix}.ciWiring.status must be pass, fail, skip, or unknown.`)
  }

  if ((ciWiring.status === 'pass' || ciWiring.status === 'fail') && !framework.ciWiringCommand) {
    errors.push(`${prefix}.ciWiringCommand is required when ciWiring.status is ${ciWiring.status}.`)
  }

  if (framework.ciWiringCommand) {
    for (const field of ['provider', 'configFile', 'job', 'step', 'whySelected']) {
      requiredString(ciWiring, field, errors, `${prefix}.ciWiring`)
    }
    requiredAbsolutePath(ciWiring, 'configFile', errors, `${prefix}.ciWiring`)
    requiredAbsolutePath(ciWiring, 'workingDirectory', errors, `${prefix}.ciWiring`)
    if (path.resolve(ciWiring.workingDirectory || '') !== path.resolve(framework.ciWiringCommand.cwd || '')) {
      errors.push(`${prefix}.ciWiringCommand.cwd must match ${prefix}.ciWiring.workingDirectory.`)
    }
  }

  if ((ciWiring.status === 'skip' || ciWiring.status === 'unknown') &&
    !hasNonEmptyString(ciWiring.diagnosis) && !hasNonEmptyString(ciWiring.reason)) {
    errors.push(`${prefix}.ciWiring must explain why CI wiring is ${ciWiring.status}.`)
  }
}

function hasNonEmptyString (value) {
  return typeof value === 'string' && value.trim() !== ''
}

function validateDatadogCleanCommand (command, prefix, errors) {
  for (const [name, value] of Object.entries(command?.env || {})) {
    if (name.startsWith('DD_') || (name === 'NODE_OPTIONS' && /dd-trace/.test(String(value)))) {
      errors.push(`${prefix}.env.${name} must not configure Datadog initialization for local validation.`)
    }
  }
}

function validateGeneratedScenarioOutcome (scenario, prefix, errors) {
  const expected = scenario.expectedWithoutDatadog
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    errors.push(`${prefix}.expectedWithoutDatadog must be an object when generatedTestStrategy is planned or verified.`)
    return
  }

  const expectedExitCode = GENERATED_SCENARIO_EXIT_CODES[scenario.id]
  if (expectedExitCode !== undefined && expected.exitCode !== expectedExitCode) {
    errors.push(`${prefix}.expectedWithoutDatadog.exitCode must be ${expectedExitCode} for ${scenario.id}.`)
  }
  if (expected.observedTestCount !== 1) {
    errors.push(`${prefix}.expectedWithoutDatadog.observedTestCount must be 1 so the command isolates this scenario.`)
  }
}

function validateCompleteGeneratedScenarioSet (strategy, prefix, errors) {
  if (!Array.isArray(strategy.scenarios)) return

  const seen = new Set()
  for (const scenario of strategy.scenarios) {
    if (typeof scenario?.id === 'string') seen.add(scenario.id)
  }

  for (const scenarioId of GENERATED_SCENARIO_IDS) {
    if (!seen.has(scenarioId)) {
      errors.push(`${prefix}.scenarios must include generated scenario "${scenarioId}" when status is planned or ` +
        'verified.')
    }
  }
}

function validateUniqueFrameworkIds (frameworks, errors) {
  const seen = new Set()
  for (const [index, framework] of frameworks.entries()) {
    if (typeof framework?.id !== 'string') continue
    if (seen.has(framework.id)) {
      errors.push(`frameworks[${index}].id must be unique; duplicate "${framework.id}".`)
    }
    seen.add(framework.id)
  }
}

function requireNonEmptyNotes (framework, errors, prefix) {
  if (!Array.isArray(framework.notes) || framework.notes.length === 0) {
    errors.push(`${prefix}.notes must include a reason when status is ${framework.status}.`)
    return
  }
  validateStringArray(framework, 'notes', errors, prefix)
}

function validateScenarioIdentities (scenario, prefix, errors, required = false) {
  if (!Array.isArray(scenario.testIdentities)) {
    if (required) {
      errors.push(`${prefix}.testIdentities must be a non-empty array when generatedTestStrategy is planned or ` +
        'verified.')
    }
    return
  }

  if (required && scenario.testIdentities.length === 0) {
    errors.push(`${prefix}.testIdentities must be a non-empty array when generatedTestStrategy is planned or verified.`)
  }

  for (const [index, identity] of scenario.testIdentities.entries()) {
    optionalAbsolutePath(identity, 'file', errors, `${prefix}.testIdentities[${index}]`)
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
  rejectUnresolvedPlaceholder(value.cwd, `${key}.cwd`, errors)
  if (value.usesShell) {
    requiredString(value, 'shellCommand', errors, key)
    rejectUnresolvedPlaceholder(value.shellCommand, `${key}.shellCommand`, errors)
  } else if (!Array.isArray(value.argv) || value.argv.length === 0) {
    errors.push(`${key}.argv must be a non-empty array unless usesShell is true.`)
  } else {
    validateStringArray(value, 'argv', errors, key)
    for (const [index, arg] of value.argv.entries()) {
      rejectUnresolvedPlaceholder(arg, `${key}.argv[${index}]`, errors)
    }
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) {
      errors.push(`${key}.env must be an object when present.`)
    } else {
      for (const [name, envValue] of Object.entries(value.env)) {
        rejectUnresolvedPlaceholder(envValue, `${key}.env.${name}`, errors)
      }
    }
  }
  if (value.requiredEnvVars !== undefined) {
    if (Array.isArray(value.requiredEnvVars)) {
      for (const [index] of value.requiredEnvVars.entries()) {
        requiredString(value.requiredEnvVars, index, errors, `${key}.requiredEnvVars`)
      }
    } else {
      errors.push(`${key}.requiredEnvVars must be an array when present.`)
    }
  }
  if (value.timeoutMs !== undefined && (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) {
    errors.push(`${key}.timeoutMs must be a positive number when present.`)
  }
}

function rejectUnresolvedPlaceholder (value, key, errors) {
  if (typeof value !== 'string' || !UNRESOLVED_PLACEHOLDER_PATTERN.test(value)) return
  errors.push(`${key} contains an unresolved placeholder. Resolve it before live validation.`)
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

function optionalAbsolutePath (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    errors.push(`${join(prefix, field)} must be an absolute path when present.`)
  }
}

function optionalAbsolutePathArray (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${join(prefix, field)} must be an array when present.`)
    return
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !path.isAbsolute(item)) {
      errors.push(`${join(prefix, field)}[${index}] must be an absolute path.`)
    }
  }
}

function validateStringArray (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (!Array.isArray(value)) return

  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push(`${join(prefix, field)}[${index}] must be a string.`)
    }
  }
}

function join (prefix, field) {
  return prefix ? `${prefix}.${field}` : field
}

module.exports = { validateManifest }
