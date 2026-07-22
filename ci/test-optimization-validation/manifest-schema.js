'use strict'

const path = require('path')

const { getArtifactId } = require('./artifact-id')
const {
  MAX_GENERATED_FILES,
  getGeneratedFileContentError,
} = require('./generated-file-policy')
const { getInlineDatadogInitialization } = require('./local-command')
const {
  hasUnsafeExecutionCharacter,
  hasUnsafeInvisibleCharacter,
  isSensitiveName,
  sanitizeForReport,
  sanitizeString,
} = require('./redaction')

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
const CI_INITIALIZATION_STATUSES = new Set(['configured', 'not_configured', 'unknown'])
const UNRESOLVED_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000
const MAX_FRAMEWORKS = 100
const MAX_MANIFEST_ARRAY_ENTRIES = 1000
const MAX_SETUP_COMMANDS = 100
const MAX_LOCAL_TEST_CANDIDATES = 3
const MAX_VALIDATION_ERRORS = 50
const MAX_REPRESENTATIVE_TESTS = 1000
const SECRET_PLACEHOLDER = 'dd-validation-placeholder'
const SAFE_SECRET_FIELD_VALUES = new Set(['', '0', '1', 'false', 'true', 'none', 'disabled'])
const COMMAND_FIELDS = new Set([
  'argv',
  'cwd',
  'description',
  'env',
  'required',
  'requiredEnvVars',
  'shell',
  'shellCommand',
  'shellReason',
  'timeoutMs',
  'usesShell',
  'id',
  'outputPaths',
])

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
  const errors = createErrorCollector()

  if (!manifest || typeof manifest !== 'object') {
    return ['Manifest must be a JSON object.']
  }

  requiredString(manifest, 'schemaVersion', errors)
  requiredObject(manifest, 'repository', errors)
  requiredObject(manifest, 'environment', errors)
  requiredArray(manifest, 'frameworks', errors)
  if (Array.isArray(manifest.frameworks) && manifest.frameworks.length === 0) {
    errors.push('frameworks must include at least one framework entry.')
  }
  validateArrayLimit(manifest, 'frameworks', MAX_FRAMEWORKS, errors)
  validateArrayLimit(manifest, 'omitted', MAX_MANIFEST_ARRAY_ENTRIES, errors)
  validateArrayLimit(manifest, 'omittedTestCommands', MAX_MANIFEST_ARRAY_ENTRIES, errors)

  if (manifest.repository) {
    requiredAbsolutePath(manifest.repository, 'root', errors)
  }

  if (manifest.ciDiscovery) {
    validateCiDiscovery(manifest.ciDiscovery, 'ciDiscovery', errors)
  }

  if (Array.isArray(manifest.frameworks)) {
    const frameworks = manifest.frameworks.slice(0, MAX_FRAMEWORKS)
    validateUniqueFrameworkIds(frameworks, errors)
    validateUniqueArtifactIds(frameworks, errors)
    validateGeneratedPathCollisions(frameworks, errors)
    for (const [index, framework] of frameworks.entries()) {
      validateFramework(framework, index, errors)
    }
  }

  validateRepositoryContainedPaths(manifest, errors)

  return errors.finalize()
}

/**
 * Rejects generated files or cleanup targets shared by multiple framework entries.
 *
 * @param {object[]} frameworks manifest framework entries
 * @param {{push: function(string): void}} errors bounded validation error collector
 * @returns {void}
 */
function validateGeneratedPathCollisions (frameworks, errors) {
  const seen = new Map()
  for (const [index, framework] of frameworks.entries()) {
    const strategy = framework?.generatedTestStrategy
    const frameworkPaths = new Map([
      ...limitedArray(strategy?.files, MAX_GENERATED_FILES).map(file => file?.path),
      ...limitedArray(strategy?.cleanupPaths, MAX_MANIFEST_ARRAY_ENTRIES),
    ].filter(filename => typeof filename === 'string' && path.isAbsolute(filename))
      .map(filename => [path.normalize(filename), filename]))

    for (const [key, filename] of frameworkPaths) {
      const previous = seen.get(key)
      if (previous === undefined) {
        seen.set(key, index)
        continue
      }
      errors.push(
        `frameworks[${index}].generatedTestStrategy path ${JSON.stringify(filename)} conflicts with ` +
        `frameworks[${previous}].generatedTestStrategy. Generated files and cleanup paths must be unique across ` +
        'framework entries.'
      )
    }
  }
}

function validateUniqueArtifactIds (frameworks, errors) {
  const seen = new Map()
  for (const [index, framework] of frameworks.entries()) {
    if (typeof framework?.id !== 'string') continue
    const artifactId = getArtifactId(framework.id)
    const previous = seen.get(artifactId)
    if (previous !== undefined && previous !== framework.id) {
      errors.push(
        `frameworks[${index}].id collides with another framework artifact identifier after normalization.`
      )
    } else {
      seen.set(artifactId, framework.id)
    }
  }
}

function validateRepositoryContainedPaths (manifest, errors) {
  const repositoryRoot = manifest.repository?.root
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) return

  const frameworks = Array.isArray(manifest.frameworks) ? manifest.frameworks.slice(0, MAX_FRAMEWORKS) : []
  for (const [index, framework] of frameworks.entries()) {
    if (!framework || typeof framework !== 'object' || Array.isArray(framework)) continue
    const prefix = `frameworks[${index}]`
    containedPath(repositoryRoot, framework.project?.root, `${prefix}.project.root`, errors)
    containedPath(repositoryRoot, framework.project?.packageJson, `${prefix}.project.packageJson`, errors)
    for (const [configIndex, configFile] of
      limitedArray(framework.project?.configFiles, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
      containedPath(repositoryRoot, configFile, `${prefix}.project.configFiles[${configIndex}]`, errors)
    }

    for (const [name, command] of getFrameworkCommands(framework)) {
      containedPath(repositoryRoot, command?.cwd, `${prefix}.${name}.cwd`, errors)
    }

    containedPath(repositoryRoot, framework.ciWiring?.configFile, `${prefix}.ciWiring.configFile`, errors)
    containedPath(repositoryRoot, framework.ciWiring?.workingDirectory, `${prefix}.ciWiring.workingDirectory`, errors)

    const strategy = framework.generatedTestStrategy
    containedPath(repositoryRoot, strategy?.testDirectory, `${prefix}.generatedTestStrategy.testDirectory`, errors)
    for (const [fileIndex, file] of limitedArray(strategy?.files, MAX_GENERATED_FILES).entries()) {
      containedPath(repositoryRoot, file?.path, `${prefix}.generatedTestStrategy.files[${fileIndex}].path`, errors)
    }
    for (const [cleanupIndex, cleanupPath] of
      limitedArray(strategy?.cleanupPaths, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
      containedPath(
        repositoryRoot,
        cleanupPath,
        `${prefix}.generatedTestStrategy.cleanupPaths[${cleanupIndex}]`,
        errors
      )
    }
    for (const [scenarioIndex, scenario] of
      limitedArray(strategy?.scenarios, GENERATED_SCENARIO_IDS.size).entries()) {
      for (const [identityIndex, identity] of
        limitedArray(scenario?.testIdentities, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
        containedPath(
          repositoryRoot,
          identity?.file,
          `${prefix}.generatedTestStrategy.scenarios[${scenarioIndex}].testIdentities[${identityIndex}].file`,
          errors
        )
      }
    }
  }
}

function getFrameworkCommands (framework) {
  const commands = []
  for (const name of ['existingTestCommand']) {
    if (framework[name]) commands.push([name, framework[name]])
  }
  for (const [index, command] of limitedArray(framework.setup?.commands, MAX_SETUP_COMMANDS).entries()) {
    commands.push([`setup.commands[${index}]`, command])
  }
  for (const [index, scenario] of
    limitedArray(framework.generatedTestStrategy?.scenarios, GENERATED_SCENARIO_IDS.size).entries()) {
    if (scenario?.runCommand) {
      commands.push([`generatedTestStrategy.scenarios[${index}].runCommand`, scenario.runCommand])
    }
  }
  return commands
}

function containedPath (root, candidate, key, errors) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return
  errors.push(`${key} must be inside repository.root.`)
}

function validateCiDiscovery (ciDiscovery, prefix, errors) {
  if (!ciDiscovery || typeof ciDiscovery !== 'object' || Array.isArray(ciDiscovery)) {
    errors.push(`${prefix} must be an object when present.`)
    return
  }

  for (const field of ['searched', 'found', 'reviewTargets', 'staticFound', 'warnings', 'notes', 'contradictions']) {
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
  if (ciDiscovery.reviewRequired !== undefined && typeof ciDiscovery.reviewRequired !== 'boolean') {
    errors.push(`${prefix}.reviewRequired must be a boolean when present.`)
  }
}

function validateFramework (framework, index, errors) {
  const prefix = `frameworks[${index}]`
  if (!framework || typeof framework !== 'object' || Array.isArray(framework)) {
    errors.push(`${prefix} must be an object.`)
    return
  }
  requiredString(framework, 'id', errors, prefix)
  enumString(framework, 'framework', FRAMEWORKS, errors, prefix)
  enumString(framework, 'status', STATUSES, errors, prefix)
  requiredObject(framework, 'project', errors, prefix)

  if (framework.project) {
    requiredAbsolutePath(framework.project, 'root', errors, `${prefix}.project`)
    optionalAbsolutePath(framework.project, 'packageJson', errors, `${prefix}.project`)
    optionalAbsolutePathArray(framework.project, 'configFiles', errors, `${prefix}.project`)
    validateArrayLimit(framework.project, 'configFiles', MAX_MANIFEST_ARRAY_ENTRIES, errors, `${prefix}.project`)
  }

  if (framework.status === 'runnable') {
    requiredCommand(framework, 'existingTestCommand', errors, prefix, { datadogClean: true })
    validateDatadogCleanCommand(framework.existingTestCommand, `${prefix}.existingTestCommand`, errors)
    validateLocalTestCandidates(framework, prefix, errors)
    requiredObject(framework, 'preflight', errors, prefix)
    validatePreflight(framework.preflight, `${prefix}.preflight`, errors)
    requiredObject(framework, 'ciWiring', errors, prefix)
  } else {
    requireNonEmptyNotes(framework, errors, prefix)
    validateNonRunnableFramework(framework, prefix, errors)
  }

  if (framework.ciWiring) {
    validateCiWiring(framework, prefix, errors)
  }

  if (framework.ciWiringCommand !== undefined) {
    errors.push(
      `${prefix}.ciWiringCommand is not supported. Record the CI command as inert text in ` +
      `${prefix}.ciWiring.command.`
    )
  }

  if (framework.forcedLocalCommand !== undefined) {
    errors.push(
      `${prefix}.forcedLocalCommand is not supported. Use the focused existingTestCommand for Basic Reporting ` +
      'and record CI initialization only as static ciWiring evidence.'
    )
  }

  if (framework.setup?.commands) {
    if (Array.isArray(framework.setup.commands)) {
      validateArrayLimit(framework.setup, 'commands', MAX_SETUP_COMMANDS, errors, `${prefix}.setup`)
      for (const [commandIndex, command] of framework.setup.commands.slice(0, MAX_SETUP_COMMANDS).entries()) {
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

/**
 * Rejects live execution instructions on framework entries that cannot be run.
 *
 * @param {object} framework manifest framework entry
 * @param {string} prefix manifest field path
 * @param {{push: function(string): void}} errors bounded validation error collector
 * @returns {void}
 */
function validateNonRunnableFramework (framework, prefix, errors) {
  for (const field of [
    'existingTestCommand',
    'localTestCandidates',
    'preflight',
    'generatedTestStrategy',
  ]) {
    if (framework[field] !== undefined) {
      errors.push(`${prefix}.${field} must be omitted when ${prefix}.status is not runnable.`)
    }
  }
  if (Array.isArray(framework.setup?.commands) && framework.setup.commands.length > 0) {
    errors.push(`${prefix}.setup.commands must be empty or omitted when ${prefix}.status is not runnable.`)
  }
}

/**
 * Validates the bounded, approval-visible commands tried before Basic Reporting.
 *
 * @param {object} framework framework manifest entry
 * @param {string} prefix manifest field path
 * @param {{push: function(string): void}} errors bounded validation error collector
 * @returns {void}
 */
function validateLocalTestCandidates (framework, prefix, errors) {
  const candidates = framework.localTestCandidates
  if (candidates === undefined) return
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_LOCAL_TEST_CANDIDATES) {
    errors.push(
      `${prefix}.localTestCandidates must contain between 1 and ${MAX_LOCAL_TEST_CANDIDATES} candidates.`
    )
    return
  }

  for (const [index, candidate] of candidates.entries()) {
    const candidatePrefix = `${prefix}.localTestCandidates[${index}]`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      errors.push(`${candidatePrefix} must be an object.`)
      continue
    }
    requiredCommand(candidate, 'command', errors, candidatePrefix, { datadogClean: true })
    validateDatadogCleanCommand(candidate.command, `${candidatePrefix}.command`, errors)
    if (!Number.isInteger(candidate.maxTestCount) || candidate.maxTestCount < 1 ||
      candidate.maxTestCount > MAX_REPRESENTATIVE_TESTS) {
      errors.push(
        `${candidatePrefix}.maxTestCount must be an integer between 1 and ${MAX_REPRESENTATIVE_TESTS}.`
      )
    }
    requiredAbsolutePath(candidate, 'sourceFile', errors, candidatePrefix)
  }
}

/**
 * Validates the approved upper bound for a representative test command.
 *
 * @param {object} preflight preflight declaration
 * @param {string} prefix manifest field path
 * @param {{push: function(string): void}} errors bounded validation error collector
 * @returns {void}
 */
function validatePreflight (preflight, prefix, errors) {
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) return

  if (!Number.isInteger(preflight.maxTestCount) || preflight.maxTestCount < 1) {
    errors.push(`${prefix}.maxTestCount must be a positive integer.`)
  } else if (preflight.maxTestCount > MAX_REPRESENTATIVE_TESTS) {
    errors.push(`${prefix}.maxTestCount must not exceed ${MAX_REPRESENTATIVE_TESTS}.`)
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
    if (strategy.files.length > MAX_GENERATED_FILES) {
      errors.push(`${prefix}.files must contain at most ${MAX_GENERATED_FILES} generated files.`)
    }
    for (const [index, file] of strategy.files.slice(0, MAX_GENERATED_FILES).entries()) {
      requiredAbsolutePath(file, 'path', errors, `${prefix}.files[${index}]`)
      requiredArray(file, 'contentLines', errors, `${prefix}.files[${index}]`)
      validateStringArray(file, 'contentLines', errors, `${prefix}.files[${index}]`)
      const policyError = getGeneratedFileContentError(file.contentLines)
      if (policyError) errors.push(`${prefix}.files[${index}].contentLines ${policyError}.`)
    }
  }

  if (Array.isArray(strategy.scenarios)) {
    validateArrayLimit(strategy, 'scenarios', GENERATED_SCENARIO_IDS.size, errors, prefix)
    for (const [index, scenario] of strategy.scenarios.slice(0, GENERATED_SCENARIO_IDS.size).entries()) {
      requiredString(scenario, 'id', errors, `${prefix}.scenarios[${index}]`)
      enumString(scenario, 'id', GENERATED_SCENARIO_IDS, errors, `${prefix}.scenarios[${index}]`)
      requiredCommand(scenario, 'runCommand', errors, `${prefix}.scenarios[${index}]`, { datadogClean: true })
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

  if (ciWiring.initialization === undefined) {
    errors.push(`${prefix}.ciWiring.initialization must record the static CI configuration conclusion.`)
  } else {
    validateCiInitialization(ciWiring.initialization, `${prefix}.ciWiring.initialization`, errors)
  }
  if (ciWiring.ciWiringCommand !== undefined) {
    errors.push(`${prefix}.ciWiring.ciWiringCommand is not supported; use ${prefix}.ciWiring.command text.`)
  }
  if (ciWiring.command !== undefined && typeof ciWiring.command !== 'string') {
    errors.push(`${prefix}.ciWiring.command must be a string when present.`)
  }
  if (ciWiring.shell !== undefined && ciWiring.shell !== null) {
    if (typeof ciWiring.shell !== 'string' || ciWiring.shell.trim() === '') {
      errors.push(`${prefix}.ciWiring.shell must be a non-empty string when present.`)
    } else if (hasUnsafeExecutionCharacter(ciWiring.shell)) {
      errors.push(`${prefix}.ciWiring.shell must not contain invisible or control characters.`)
    }
  }
  if (ciWiring.initialization?.status === 'unknown' &&
    !hasNonEmptyString(ciWiring.diagnosis) && !hasNonEmptyString(ciWiring.reason)) {
    errors.push(`${prefix}.ciWiring must explain why CI initialization is unknown.`)
  }
}

function validateCiInitialization (initialization, prefix, errors) {
  if (!initialization || typeof initialization !== 'object' || Array.isArray(initialization)) {
    errors.push(`${prefix} must be an object when present.`)
    return
  }

  if (!CI_INITIALIZATION_STATUSES.has(initialization.status)) {
    errors.push(
      `${prefix}.status must be exactly configured, not_configured, or unknown. ` +
      'Use not_configured when the selected CI job does not initialize Test Optimization; do not use missing, ' +
      'absent, unconfigured, or other natural-language values.'
    )
  }
  if (Array.isArray(initialization.evidence)) {
    validateStringArray(initialization, 'evidence', errors, prefix)
    if (initialization.status !== 'unknown' && initialization.evidence.length === 0) {
      errors.push(`${prefix}.evidence must explain the ${initialization.status} conclusion.`)
    }
  } else {
    errors.push(`${prefix}.evidence must be an array.`)
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

  const inlineInitialization = getInlineDatadogInitialization(command)
  if (inlineInitialization) {
    errors.push(
      `${prefix} ${inlineInitialization} and must be Datadog-clean for local validation. ` +
      'Remove the inline initialization; record CI initialization only as static ciWiring evidence.'
    )
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
  for (const scenario of strategy.scenarios.slice(0, GENERATED_SCENARIO_IDS.size)) {
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
  validateArrayLimit(
    { testIdentities: scenario.testIdentities },
    'testIdentities',
    MAX_MANIFEST_ARRAY_ENTRIES,
    errors,
    prefix
  )

  for (const [index, identity] of scenario.testIdentities.slice(0, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
    const identityPrefix = `${prefix}.testIdentities[${index}]`
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      errors.push(`${identityPrefix} must be an object.`)
      continue
    }
    requiredString(identity, 'name', errors, identityPrefix)
    if (identity.suite !== undefined && identity.suite !== null && typeof identity.suite !== 'string') {
      errors.push(`${identityPrefix}.suite must be a string or null when present.`)
    }
    optionalAbsolutePath(identity, 'file', errors, identityPrefix)
  }
}

function requiredCommand (target, field, errors, prefix = '', options = {}) {
  const value = target && target[field]
  const key = join(prefix, field)
  if (!value || typeof value !== 'object') {
    errors.push(`${key} must be an object.`)
    return
  }
  for (const name of Object.keys(value)) {
    if (!COMMAND_FIELDS.has(name)) errors.push(`${key}.${name} is not an allowed command field.`)
  }
  if (value.usesShell !== undefined && typeof value.usesShell !== 'boolean') {
    errors.push(`${key}.usesShell must be a boolean when present.`)
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    errors.push(`${key}.required must be a boolean when present.`)
  }
  requiredAbsolutePath(value, 'cwd', errors, key)
  rejectUnresolvedPlaceholder(value.cwd, `${key}.cwd`, errors)
  if (value.shell !== undefined) {
    requiredString(value, 'shell', errors, key)
    rejectUnresolvedPlaceholder(value.shell, `${key}.shell`, errors)
    if (!value.usesShell) errors.push(`${key}.shell requires usesShell to be true.`)
    if (typeof value.shell === 'string' && hasUnsafeExecutionCharacter(value.shell)) {
      errors.push(`${key}.shell must not contain invisible or control characters.`)
    }
  }
  if (value.usesShell) {
    requiredString(value, 'shellCommand', errors, key)
    rejectUnresolvedPlaceholder(value.shellCommand, `${key}.shellCommand`, errors)
    if (typeof value.shellCommand === 'string' && hasUnsafeInvisibleCharacter(value.shellCommand)) {
      errors.push(`${key}.shellCommand must not contain invisible or control characters.`)
    } else if (typeof value.shellCommand === 'string' && sanitizeString(value.shellCommand) !== value.shellCommand) {
      errors.push(`${key}.shellCommand must not contain inline secret-like values. Put safe placeholders in env.`)
    }
  } else if (!Array.isArray(value.argv) || value.argv.length === 0) {
    errors.push(`${key}.argv must be a non-empty array unless usesShell is true.`)
  } else {
    validateStringArray(value, 'argv', errors, key)
    for (const [index, arg] of value.argv.slice(0, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
      rejectUnresolvedPlaceholder(arg, `${key}.argv[${index}]`, errors)
    }
    if (value.argv.some(hasUnsafeExecutionCharacter)) {
      errors.push(`${key}.argv must not contain invisible or control characters.`)
    } else if (JSON.stringify(sanitizeForReport(value.argv)) !== JSON.stringify(value.argv)) {
      errors.push(`${key}.argv must not contain inline secret-like values. Put safe placeholders in env.`)
    }
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) {
      errors.push(`${key}.env must be an object when present.`)
    } else {
      const environmentEntries = Object.entries(value.env)
      if (environmentEntries.length > MAX_MANIFEST_ARRAY_ENTRIES) {
        errors.push(`${key}.env must contain at most ${MAX_MANIFEST_ARRAY_ENTRIES} entries.`)
      }
      for (const [name, envValue] of environmentEntries.slice(0, MAX_MANIFEST_ARRAY_ENTRIES)) {
        if (!ENV_NAME_PATTERN.test(name)) {
          errors.push(`${key}.env contains invalid variable name ${JSON.stringify(name)}.`)
        }
        if (typeof envValue !== 'string') errors.push(`${key}.env.${name} must be a string.`)
        const validatePlaceholder = !(options.datadogClean && name.startsWith('DD_'))
        if (typeof envValue === 'string' && hasUnsafeExecutionCharacter(envValue)) {
          errors.push(`${key}.env.${name} must not contain invisible or control characters.`)
        } else if (validatePlaceholder && typeof envValue === 'string' && containsSecretValue(name, envValue) &&
          envValue !== SECRET_PLACEHOLDER) {
          errors.push(`${key}.env.${name} must use the safe placeholder ${JSON.stringify(SECRET_PLACEHOLDER)}.`)
        }
        rejectUnresolvedPlaceholder(envValue, `${key}.env.${name}`, errors)
      }
    }
  }
  if (value.requiredEnvVars !== undefined) {
    if (Array.isArray(value.requiredEnvVars)) {
      validateArrayLimit(value, 'requiredEnvVars', MAX_MANIFEST_ARRAY_ENTRIES, errors, key)
      for (const [index] of value.requiredEnvVars.slice(0, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
        requiredString(value.requiredEnvVars, index, errors, `${key}.requiredEnvVars`)
      }
    } else {
      errors.push(`${key}.requiredEnvVars must be an array when present.`)
    }
  }
  optionalAbsolutePathArray(value, 'outputPaths', errors, key)
  if (value.timeoutMs !== undefined && (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) {
    errors.push(`${key}.timeoutMs must be a positive number when present.`)
  } else if (value.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    errors.push(`${key}.timeoutMs must not exceed ${MAX_COMMAND_TIMEOUT_MS} ms.`)
  }
}

function containsSecretValue (name, value) {
  if (SAFE_SECRET_FIELD_VALUES.has(value.toLowerCase())) return false
  return isSensitiveName(name) || sanitizeString(value) !== value
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
  } else if (hasUnsafeExecutionCharacter(value)) {
    errors.push(`${join(prefix, field)} must not contain invisible or control characters.`)
  }
}

function optionalAbsolutePath (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    errors.push(`${join(prefix, field)} must be an absolute path when present.`)
  } else if (hasUnsafeExecutionCharacter(value)) {
    errors.push(`${join(prefix, field)} must not contain invisible or control characters.`)
  }
}

function optionalAbsolutePathArray (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${join(prefix, field)} must be an array when present.`)
    return
  }

  validateArrayLimit(target, field, MAX_MANIFEST_ARRAY_ENTRIES, errors, prefix)
  for (const [index, item] of value.slice(0, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
    if (typeof item !== 'string' || !path.isAbsolute(item)) {
      errors.push(`${join(prefix, field)}[${index}] must be an absolute path.`)
    } else if (hasUnsafeExecutionCharacter(item)) {
      errors.push(`${join(prefix, field)}[${index}] must not contain invisible or control characters.`)
    }
  }
}

function validateStringArray (target, field, errors, prefix = '') {
  const value = target && target[field]
  if (!Array.isArray(value)) return

  validateArrayLimit(target, field, MAX_MANIFEST_ARRAY_ENTRIES, errors, prefix)
  for (const [index, item] of value.slice(0, MAX_MANIFEST_ARRAY_ENTRIES).entries()) {
    if (typeof item !== 'string') {
      errors.push(`${join(prefix, field)}[${index}] must be a string.`)
    }
  }
}

function validateArrayLimit (target, field, limit, errors, prefix = '') {
  const value = target && target[field]
  if (Array.isArray(value) && value.length > limit) {
    errors.push(`${join(prefix, field)} must contain at most ${limit} entries.`)
  }
}

function limitedArray (value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

function createErrorCollector () {
  const errors = []
  let omitted = 0
  Object.defineProperties(errors, {
    push: {
      value (...messages) {
        for (const message of messages) {
          if (this.length < MAX_VALIDATION_ERRORS - 1) {
            Array.prototype.push.call(this, message)
          } else {
            omitted++
          }
        }
        return this.length
      },
    },
    finalize: {
      value () {
        if (omitted > 0) {
          Array.prototype.push.call(this, `${omitted} additional validation error(s) omitted.`)
        }
        return this
      },
    },
  })
  return errors
}

function join (prefix, field) {
  return prefix ? `${prefix}.${field}` : field
}

module.exports = {
  MAX_FRAMEWORKS,
  MAX_REPRESENTATIVE_TESTS,
  MAX_VALIDATION_ERRORS,
  validateManifest,
}
