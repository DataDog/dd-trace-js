'use strict'

const path = require('node:path')

const { getArtifactId } = require('./artifact-id')
const { BLOCKER_CATEGORY_VALUES } = require('./blocker-category')
const {
  MAX_GENERATED_FILES,
  getGeneratedFileContentError,
} = require('./generated-file-policy')
const { getGeneratedTestContractError } = require('./generated-test-contract')
const { hasUnsafeInvisibleCharacter, sanitizeString } = require('./redaction')
const {
  getRunnerArgsError,
  getRunnerEnvironmentError,
  getRunnerInputError,
} = require('./runner-contract')

const FRAMEWORKS = new Set(['cucumber', 'cypress', 'jest', 'mocha', 'playwright', 'vitest'])
const STATUSES = new Set([
  'detected_not_runnable',
  'requires_manual_setup',
  'runnable',
  'unsupported_by_validator',
])
const INITIALIZATION_STATUSES = new Set(['configured', 'not_configured', 'unknown'])
const TRANSPORT_MODES = new Set(['agent', 'agentless', 'none', 'unknown'])
const GENERATED_SCENARIOS = new Set(['basic-pass', 'atr-fail-once', 'test-management-target'])
const GENERATED_EXIT_CODES = {
  'basic-pass': 0,
  'atr-fail-once': 1,
  'test-management-target': 0,
}
const FORBIDDEN_EXECUTION_FIELDS = new Set([
  'argv',
  'existingTestCommand',
  'forcedLocalCommand',
  'isolationTestCandidate',
  'isolationTestCandidates',
  'localTestCandidates',
  'runCommand',
  'setup',
  'shell',
  'shellCommand',
  'usesShell',
])
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_ENV_PATTERN =
  /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|PASS(?:WORD|WD)?|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i
const EXECUTION_ENV_PATTERN =
  /^(?:(?:BASH_ENV|ENV|NODE_EXTRA_CA_CERTS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_TLS_REJECT_UNAUTHORIZED)$|LD_|DYLD_)/i
const MAX_ARRAY_ENTRIES = 1000
const MAX_FRAMEWORKS = 100
const MAX_STRING_BYTES = 256 * 1024
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MAX_VALIDATION_ERRORS = 50

/**
 * Validates a data-only Test Optimization manifest.
 *
 * @param {object} manifest parsed manifest
 * @returns {string[]} bounded validation errors
 */
function validateManifest (manifest) {
  const errors = createErrorCollector()
  if (!isObject(manifest)) return ['Manifest must be a JSON object.']

  requiredString(manifest, 'schemaVersion', 'manifest', errors)
  if (manifest.schemaVersion !== '2.0') errors.push('schemaVersion must be "2.0".')
  requiredObject(manifest, 'repository', 'manifest', errors)
  requiredObject(manifest, 'environment', 'manifest', errors)
  requiredArray(manifest, 'frameworks', 'manifest', errors)
  rejectExecutionFields(manifest, 'manifest', errors)

  if (isObject(manifest.repository)) {
    requiredAbsolutePath(manifest.repository, 'root', 'repository', errors)
  }

  if (Array.isArray(manifest.frameworks)) {
    if (manifest.frameworks.length === 0) errors.push('frameworks must not be empty.')
    if (manifest.frameworks.length > MAX_FRAMEWORKS) {
      errors.push(`frameworks must contain at most ${MAX_FRAMEWORKS} entries.`)
    }
    validateFrameworks(manifest, errors)
  }

  validateStringArray(manifest.omitted, 'omitted', errors)
  validateAllStrings(manifest, 'manifest', errors)
  return errors.finalize()
}

/**
 * Validates framework entries and cross-framework uniqueness.
 *
 * @param {object} manifest validation manifest
 * @param {{push: function(string): void, full: function(): boolean}} errors error collector
 * @returns {void}
 */
function validateFrameworks (manifest, errors) {
  const ids = new Set()
  const artifactIds = new Set()
  const generatedPaths = new Map()

  for (const [index, framework] of manifest.frameworks.slice(0, MAX_FRAMEWORKS).entries()) {
    if (errors.full()) return
    const prefix = `frameworks[${index}]`
    if (!isObject(framework)) {
      errors.push(`${prefix} must be an object.`)
      continue
    }

    requiredString(framework, 'id', prefix, errors)
    requiredString(framework, 'framework', prefix, errors)
    enumString(framework, 'status', STATUSES, prefix, errors)
    if (framework.blockerCategory !== undefined &&
      !BLOCKER_CATEGORY_VALUES.has(framework.blockerCategory)) {
      errors.push(
        `${prefix}.blockerCategory must be one of ${[...BLOCKER_CATEGORY_VALUES].join(', ')} when provided.`
      )
    }
    requiredObject(framework, 'project', prefix, errors)
    rejectExecutionFields(framework, prefix, errors)

    if (typeof framework.framework === 'string' &&
      framework.status !== 'unsupported_by_validator' &&
      !FRAMEWORKS.has(framework.framework)) {
      errors.push(`${prefix}.framework must be one of: ${[...FRAMEWORKS].join(', ')}.`)
    }

    if (typeof framework.id === 'string') {
      if (ids.has(framework.id)) errors.push(`${prefix}.id must be unique.`)
      ids.add(framework.id)
      const artifactId = getArtifactId(framework.id)
      if (artifactIds.has(artifactId)) errors.push(`${prefix}.id collides after artifact normalization.`)
      artifactIds.add(artifactId)
    }

    validateProject(manifest.repository?.root, framework.project, `${prefix}.project`, errors)
    validateCiWiring(manifest.repository?.root, framework.ciWiring, `${prefix}.ciWiring`, errors)

    if (framework.status === 'runnable') {
      if (typeof framework.allCandidatesRequireLocalSocket !== 'boolean') {
        errors.push(`${prefix}.allCandidatesRequireLocalSocket must be a boolean.`)
      }
      if (typeof framework.buildArtifactRequired !== 'boolean') {
        errors.push(`${prefix}.buildArtifactRequired must be a boolean.`)
      }
      validateRunnableFramework(manifest.repository?.root, framework, prefix, generatedPaths, errors)
    } else {
      for (const field of ['validation', 'preflight', 'generatedTestStrategy']) {
        if (framework[field] !== undefined) {
          errors.push(`${prefix}.${field} must be omitted when status is not runnable.`)
        }
      }
    }
    validateStringArray(framework.notes, `${prefix}.notes`, errors)
  }
}

/**
 * Validates project metadata.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} project project metadata
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateProject (repositoryRoot, project, prefix, errors) {
  if (!isObject(project)) return
  requiredString(project, 'name', prefix, errors)
  requiredAbsolutePath(project, 'root', prefix, errors)
  requiredAbsolutePath(project, 'packageJson', prefix, errors)
  containedPath(repositoryRoot, project.root, `${prefix}.root`, errors)
  containedPath(repositoryRoot, project.packageJson, `${prefix}.packageJson`, errors)
  if (Array.isArray(project.configFiles)) {
    if (project.configFiles.length > 20) errors.push(`${prefix}.configFiles must contain at most 20 entries.`)
    for (const [index, filename] of project.configFiles.slice(0, 20).entries()) {
      absolutePathValue(filename, `${prefix}.configFiles[${index}]`, errors)
      containedPath(repositoryRoot, filename, `${prefix}.configFiles[${index}]`, errors)
    }
  } else {
    errors.push(`${prefix}.configFiles must be an array.`)
  }
}

/**
 * Validates direct-runner fields and generated recipes.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} framework runnable framework entry
 * @param {string} prefix error prefix
 * @param {Map<string, string>} generatedPaths generated paths used by other frameworks
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateRunnableFramework (repositoryRoot, framework, prefix, generatedPaths, errors) {
  if (!isObject(framework.validation)) {
    errors.push(`${prefix}.validation must be an object for a runnable framework.`)
    return
  }

  const validation = framework.validation
  rejectExecutionFields(validation, `${prefix}.validation`, errors)
  requiredAbsolutePath(validation, 'runner', `${prefix}.validation`, errors)
  requiredAbsolutePath(validation, 'testFile', `${prefix}.validation`, errors)
  if (!['bounded_direct_runner', 'instrumented_event_identity'].includes(validation.selectorScope)) {
    errors.push(
      `${prefix}.validation.selectorScope must be bounded_direct_runner or instrumented_event_identity.`
    )
  }
  containedPath(repositoryRoot, validation.runner, `${prefix}.validation.runner`, errors)
  containedPath(repositoryRoot, validation.testFile, `${prefix}.validation.testFile`, errors)
  validateFallbackTests(repositoryRoot, validation, `${prefix}.validation`, errors)
  const runnerArgsError = getRunnerArgsError(framework.framework, validation.runnerArgs)
  if (runnerArgsError) errors.push(`${prefix}.validation.runnerArgs ${runnerArgsError}.`)
  if (validation.omittedRunnerOptions !== undefined) {
    validateStringArray(validation.omittedRunnerOptions, `${prefix}.validation.omittedRunnerOptions`, errors)
    for (const option of Array.isArray(validation.omittedRunnerOptions) ? validation.omittedRunnerOptions : []) {
      if (!['-R', '--reporter', '--run', '--typecheck'].includes(option)) {
        errors.push(`${prefix}.validation.omittedRunnerOptions contains unsupported option ${option}.`)
      }
    }
  }
  const runnerEnvironmentError = getRunnerEnvironmentError(validation.environment)
  if (runnerEnvironmentError) errors.push(`${prefix}.validation.environment ${runnerEnvironmentError}.`)
  if (!runnerArgsError &&
    !runnerEnvironmentError &&
    typeof framework.project?.root === 'string' &&
    typeof repositoryRoot === 'string' &&
    Array.isArray(framework.project?.configFiles)) {
    const runnerInputError = getRunnerInputError(
      validation.runnerArgs,
      validation.environment,
      framework.project?.root,
      repositoryRoot,
      framework.project?.configFiles
    )
    if (runnerInputError) errors.push(`${prefix}.validation runner configuration ${runnerInputError}.`)
  }
  validateStringArray(validation.requiredEnvVars, `${prefix}.validation.requiredEnvVars`, errors)
  if (validation.requiredEnvVars) {
    for (const name of validation.requiredEnvVars) {
      if (!ENV_NAME_PATTERN.test(name)) {
        errors.push(`${prefix}.validation.requiredEnvVars contains an invalid environment name.`)
      }
      if (/^(?:DD_|DATADOG_|OTEL_|NODE_OPTIONS$|TS_NODE_PROJECT$)/i.test(name)) {
        errors.push(
          `${prefix}.validation.requiredEnvVars must not inherit Datadog, OpenTelemetry, NODE_OPTIONS, or ` +
            'TS_NODE_PROJECT.'
        )
      }
      if (SECRET_ENV_PATTERN.test(name)) {
        errors.push(`${prefix}.validation.requiredEnvVars must not inherit secret-like environment variables.`)
      }
      if (EXECUTION_ENV_PATTERN.test(name)) {
        errors.push(`${prefix}.validation.requiredEnvVars must not inherit executable-loading environment variables.`)
      }
    }
  }
  if (!Number.isInteger(validation.timeoutMs) || validation.timeoutMs < 1 || validation.timeoutMs > MAX_TIMEOUT_MS) {
    errors.push(`${prefix}.validation.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`)
  }

  if (!isObject(framework.generatedTestStrategy)) {
    errors.push(`${prefix}.generatedTestStrategy must be an object for a runnable framework.`)
    return
  }
  validateGeneratedStrategy(repositoryRoot, framework, prefix, generatedPaths, errors)
}

/**
 * Validates bounded fallback test paths and their statically discovered prerequisites.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} validation direct-runner validation data
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateFallbackTests (repositoryRoot, validation, prefix, errors) {
  if (validation.fallbackTests === undefined) return
  if (!Array.isArray(validation.fallbackTests)) {
    errors.push(`${prefix}.fallbackTests must be an array.`)
    return
  }
  if (validation.fallbackTests.length > 2) {
    errors.push(`${prefix}.fallbackTests must contain at most 2 entries.`)
  }

  const testFiles = new Set()
  for (const [index, fallback] of validation.fallbackTests.slice(0, 2).entries()) {
    const fallbackPrefix = `${prefix}.fallbackTests[${index}]`
    if (!isObject(fallback)) {
      errors.push(`${fallbackPrefix} must be an object.`)
      continue
    }
    rejectExecutionFields(fallback, fallbackPrefix, errors)
    requiredAbsolutePath(fallback, 'testFile', fallbackPrefix, errors)
    containedPath(repositoryRoot, fallback.testFile, `${fallbackPrefix}.testFile`, errors)
    if (typeof fallback.buildArtifactRequired !== 'boolean') {
      errors.push(`${fallbackPrefix}.buildArtifactRequired must be a boolean.`)
    }
    if (typeof fallback.localSocketRequired !== 'boolean') {
      errors.push(`${fallbackPrefix}.localSocketRequired must be a boolean.`)
    }
    if (fallback.testFile === validation.testFile) {
      errors.push(`${fallbackPrefix}.testFile must differ from ${prefix}.testFile.`)
    }
    if (testFiles.has(fallback.testFile)) {
      errors.push(`${prefix}.fallbackTests must contain unique testFile values.`)
    }
    testFiles.add(fallback.testFile)
  }
}

/**
 * Validates canonical generated test data.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} framework framework entry
 * @param {string} prefix framework error prefix
 * @param {Map<string, string>} generatedPaths generated paths used by other frameworks
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateGeneratedStrategy (repositoryRoot, framework, prefix, generatedPaths, errors) {
  const strategy = framework.generatedTestStrategy
  if (!['planned', 'verified', 'not_possible'].includes(strategy.status)) {
    errors.push(`${prefix}.generatedTestStrategy.status must be planned, verified, or not_possible.`)
  }
  if (strategy.status === 'not_possible') {
    requiredString(strategy, 'reason', `${prefix}.generatedTestStrategy`, errors)
    return
  }

  requiredAbsolutePath(strategy, 'testDirectory', `${prefix}.generatedTestStrategy`, errors)
  containedPath(repositoryRoot, strategy.testDirectory, `${prefix}.generatedTestStrategy.testDirectory`, errors)
  requiredArray(strategy, 'files', `${prefix}.generatedTestStrategy`, errors)
  requiredArray(strategy, 'scenarios', `${prefix}.generatedTestStrategy`, errors)
  requiredArray(strategy, 'cleanupPaths', `${prefix}.generatedTestStrategy`, errors)

  if (Array.isArray(strategy.files)) {
    if (strategy.files.length > MAX_GENERATED_FILES) {
      errors.push(`${prefix}.generatedTestStrategy.files must contain at most ${MAX_GENERATED_FILES} entries.`)
    }
    for (const [index, file] of strategy.files.slice(0, MAX_GENERATED_FILES).entries()) {
      const filePrefix = `${prefix}.generatedTestStrategy.files[${index}]`
      if (!isObject(file)) {
        errors.push(`${filePrefix} must be an object.`)
        continue
      }
      requiredAbsolutePath(file, 'path', filePrefix, errors)
      validateStringArray(file.contentLines, `${filePrefix}.contentLines`, errors)
      containedPath(repositoryRoot, file.path, `${filePrefix}.path`, errors)
      const policyError = getGeneratedFileContentError(file.contentLines)
      if (policyError) errors.push(`${filePrefix}.contentLines ${policyError}.`)
      claimGeneratedPath(file.path, framework.id, filePrefix, generatedPaths, errors)
    }
  }

  if (Array.isArray(strategy.cleanupPaths)) {
    for (const [index, filename] of strategy.cleanupPaths.slice(0, MAX_ARRAY_ENTRIES).entries()) {
      const pathPrefix = `${prefix}.generatedTestStrategy.cleanupPaths[${index}]`
      absolutePathValue(filename, pathPrefix, errors)
      containedPath(repositoryRoot, filename, pathPrefix, errors)
      claimGeneratedPath(filename, framework.id, pathPrefix, generatedPaths, errors)
    }
  }

  if (Array.isArray(strategy.scenarios)) {
    if (strategy.scenarios.length !== GENERATED_SCENARIOS.size) {
      errors.push(`${prefix}.generatedTestStrategy.scenarios must contain all three canonical scenarios.`)
    }
    const scenarioIds = new Set()
    for (const [index, scenario] of strategy.scenarios.slice(0, GENERATED_SCENARIOS.size).entries()) {
      const scenarioPrefix = `${prefix}.generatedTestStrategy.scenarios[${index}]`
      if (!isObject(scenario)) {
        errors.push(`${scenarioPrefix} must be an object.`)
        continue
      }
      enumString(scenario, 'id', GENERATED_SCENARIOS, scenarioPrefix, errors)
      rejectExecutionFields(scenario, scenarioPrefix, errors)
      scenarioIds.add(scenario.id)
      validateScenarioIdentity(repositoryRoot, scenario, scenarioPrefix, errors)
      const expected = scenario.expectedWithoutDatadog
      if (!isObject(expected) ||
        expected.exitCode !== GENERATED_EXIT_CODES[scenario.id] ||
        expected.observedTestCount !== 1) {
        errors.push(`${scenarioPrefix}.expectedWithoutDatadog must retain the canonical exit code and one test.`)
      }
    }
    for (const id of GENERATED_SCENARIOS) {
      if (!scenarioIds.has(id)) errors.push(`${prefix}.generatedTestStrategy.scenarios is missing ${id}.`)
    }
  }

  const contractError = getGeneratedTestContractError(framework)
  if (contractError) errors.push(`${prefix}.generatedTestStrategy ${contractError}`)
}

/**
 * Validates one generated test identity.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} scenario generated scenario
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateScenarioIdentity (repositoryRoot, scenario, prefix, errors) {
  if (!Array.isArray(scenario.testIdentities) || scenario.testIdentities.length !== 1) {
    errors.push(`${prefix}.testIdentities must contain exactly one identity.`)
    return
  }
  const identity = scenario.testIdentities[0]
  if (!isObject(identity)) {
    errors.push(`${prefix}.testIdentities[0] must be an object.`)
    return
  }
  requiredAbsolutePath(identity, 'file', `${prefix}.testIdentities[0]`, errors)
  requiredString(identity, 'name', `${prefix}.testIdentities[0]`, errors)
  requiredString(identity, 'suite', `${prefix}.testIdentities[0]`, errors)
  containedPath(repositoryRoot, identity.file, `${prefix}.testIdentities[0].file`, errors)
}

/**
 * Validates inert CI evidence.
 *
 * @param {string} repositoryRoot repository root
 * @param {object|undefined} ciWiring CI evidence
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateCiWiring (repositoryRoot, ciWiring, prefix, errors) {
  if (ciWiring === undefined) return
  if (!isObject(ciWiring)) {
    errors.push(`${prefix} must be an object.`)
    return
  }
  rejectExecutionFields(ciWiring, prefix, errors, new Set(['command']))
  for (const field of ['command', 'job', 'step']) optionalStringOrNull(ciWiring, field, prefix, errors)
  optionalAbsolutePathOrNull(ciWiring, 'configFile', prefix, errors)
  optionalAbsolutePathOrNull(ciWiring, 'workingDirectory', prefix, errors)
  containedPath(repositoryRoot, ciWiring.configFile, `${prefix}.configFile`, errors)
  containedPath(repositoryRoot, ciWiring.workingDirectory, `${prefix}.workingDirectory`, errors)
  if (typeof ciWiring.reviewComplete !== 'boolean') errors.push(`${prefix}.reviewComplete must be a boolean.`)
  validateStringArray(ciWiring.unresolved, `${prefix}.unresolved`, errors)

  if (!isObject(ciWiring.initialization) ||
    !INITIALIZATION_STATUSES.has(ciWiring.initialization.status)) {
    errors.push(`${prefix}.initialization.status must be configured, not_configured, or unknown.`)
  } else {
    validateStringArray(ciWiring.initialization.evidence, `${prefix}.initialization.evidence`, errors)
  }
  if (!isObject(ciWiring.transport) || !TRANSPORT_MODES.has(ciWiring.transport.mode)) {
    errors.push(`${prefix}.transport.mode must be agent, agentless, none, or unknown.`)
  } else {
    validateStringArray(ciWiring.transport.evidence, `${prefix}.transport.evidence`, errors)
  }
}

/**
 * Rejects execution-shaped keys anywhere in a data object.
 *
 * @param {object} value object to inspect
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @param {Set<string>} [allowed] explicitly inert keys
 * @returns {void}
 */
function rejectExecutionFields (value, prefix, errors, allowed = new Set()) {
  if (!isObject(value)) return
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_EXECUTION_FIELDS.has(key) && !allowed.has(key)) {
      errors.push(`${prefix}.${key} is not supported. Executable commands are validator-owned.`)
    }
  }
}

/**
 * Claims a generated path for one framework.
 *
 * @param {string} filename generated path
 * @param {string} owner framework id
 * @param {string} prefix error prefix
 * @param {Map<string, string>} generatedPaths previously claimed paths
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function claimGeneratedPath (filename, owner, prefix, generatedPaths, errors) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return
  const normalized = path.normalize(filename)
  const previousOwner = generatedPaths.get(normalized)
  if (previousOwner !== undefined && previousOwner !== owner) {
    errors.push(`${prefix} conflicts with another framework's generated or cleanup path.`)
  }
  generatedPaths.set(normalized, owner)
}

/**
 * Validates every string in a bounded object graph.
 *
 * @param {unknown} value current value
 * @param {string} prefix error prefix
 * @param {{push: function(string): void, full: function(): boolean}} errors error collector
 * @returns {void}
 */
function validateAllStrings (value, prefix, errors) {
  if (errors.full()) return
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_STRING_BYTES) errors.push(`${prefix} exceeds the string size limit.`)
    const inertCiLabel = /\.ciWiring\.(?:job|step)$/.test(prefix)
    const text = inertCiLabel ? value.replaceAll(/[\uFE0E\uFE0F]/g, '') : value
    if (hasUnsafeInvisibleCharacter(text)) errors.push(`${prefix} contains an unsafe invisible character.`)
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.slice(0, MAX_ARRAY_ENTRIES).entries()) {
      validateAllStrings(item, `${prefix}[${index}]`, errors)
    }
    return
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) validateAllStrings(item, `${prefix}.${key}`, errors)
  }
}

/**
 * Validates a required object.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function requiredObject (object, field, prefix, errors) {
  if (!isObject(object[field])) errors.push(`${prefix}.${field} must be an object.`)
}

/**
 * Validates a required array.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function requiredArray (object, field, prefix, errors) {
  if (!Array.isArray(object[field])) errors.push(`${prefix}.${field} must be an array.`)
}

/**
 * Validates a required string.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function requiredString (object, field, prefix, errors) {
  if (typeof object?.[field] !== 'string' || object[field].trim() === '') {
    errors.push(`${prefix}.${field} must be a non-empty string.`)
  }
}

/**
 * Validates an enum string.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {Set<string>} values accepted values
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function enumString (object, field, values, prefix, errors) {
  if (!values.has(object?.[field])) {
    errors.push(`${prefix}.${field} must be one of: ${[...values].join(', ')}.`)
  }
}

/**
 * Validates a required absolute path.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function requiredAbsolutePath (object, field, prefix, errors) {
  absolutePathValue(object?.[field], `${prefix}.${field}`, errors)
}

/**
 * Validates an absolute path value.
 *
 * @param {unknown} value path value
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function absolutePathValue (value, prefix, errors) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) errors.push(`${prefix} must be an absolute path.`)
}

/**
 * Validates an optional nullable absolute path.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function optionalAbsolutePathOrNull (object, field, prefix, errors) {
  if (object[field] !== null && object[field] !== undefined &&
    (typeof object[field] !== 'string' || !path.isAbsolute(object[field]))) {
    errors.push(`${prefix}.${field} must be an absolute path or null.`)
  }
}

/**
 * Validates an optional nullable string.
 *
 * @param {object} object parent object
 * @param {string} field field name
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function optionalStringOrNull (object, field, prefix, errors) {
  if (object[field] !== null && object[field] !== undefined && typeof object[field] !== 'string') {
    errors.push(`${prefix}.${field} must be a string or null.`)
  }
}

/**
 * Validates a string array when present.
 *
 * @param {unknown} value array value
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function validateStringArray (value, prefix, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${prefix} must be an array of strings.`)
    return
  }
  if (value.length > MAX_ARRAY_ENTRIES) errors.push(`${prefix} must contain at most ${MAX_ARRAY_ENTRIES} entries.`)
  if (value.slice(0, MAX_ARRAY_ENTRIES).some(item => typeof item !== 'string')) {
    errors.push(`${prefix} must contain only strings.`)
  }
}

/**
 * Checks lexical repository containment.
 *
 * @param {string} root repository root
 * @param {unknown} filename candidate path
 * @param {string} prefix error prefix
 * @param {{push: function(string): void}} errors error collector
 * @returns {void}
 */
function containedPath (root, filename, prefix, errors) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
    typeof filename !== 'string' || !path.isAbsolute(filename)) return
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    errors.push(`${prefix} must be inside repository.root.`)
  }
}

/**
 * Returns whether a value is a plain object.
 *
 * @param {unknown} value candidate value
 * @returns {boolean} whether the value is an object
 */
function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Creates a bounded error collector.
 *
 * @returns {{push: function(string): void, full: function(): boolean, finalize: function(): string[]}} collector
 */
function createErrorCollector () {
  const errors = []
  let omitted = false
  return {
    push (message) {
      if (errors.length < MAX_VALIDATION_ERRORS) {
        errors.push(sanitizeString(message))
      } else {
        omitted = true
      }
    },
    full () {
      return errors.length >= MAX_VALIDATION_ERRORS
    },
    finalize () {
      if (omitted) errors.push('Additional validation errors were omitted.')
      return errors
    },
  }
}

module.exports = { validateManifest }
