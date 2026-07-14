'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { getApprovalDigest } = require('./approval')
const { getCommandOutputPaths } = require('./command-output-policy')
const { getCommandSuitabilityError } = require('./command-suitability')
const { serializeApprovalCommand } = require('./command-runner')
const { getUnavailableExecutable } = require('./executable')
const { getLocalValidationCommand } = require('./local-command')
const {
  getOfflineFixturePaths,
  getOfflineScenarioNames,
} = require('./offline-fixtures')
const { sanitizeEnv, sanitizeString } = require('./redaction')
const { getBasicReportingCommand } = require('./scenarios/basic-reporting')
const { getCiWiringCommand } = require('./scenarios/ci-wiring')

const VALIDATOR_PATH = path.resolve(__dirname, '..', 'validate-test-optimization.js')
const DEFAULT_MANIFEST_FILENAME = 'dd-test-optimization-validation-manifest.json'
const DEFAULT_RESULTS_DIRECTORY = 'dd-test-optimization-validation-results'
const GENERATED_SCENARIO_DETAILS = {
  'basic-pass': {
    heading: 'Advanced Check: Early Flake Detection',
    description: 'Runs a temporary passing test and checks that Datadog recognizes it as new and retries it.',
  },
  'atr-fail-once': {
    heading: 'Advanced Check: Auto Test Retries',
    description: 'Runs a temporary test that fails once and checks that Datadog retries it successfully.',
  },
  'test-management-target': {
    heading: 'Advanced Check: Test Management',
    description: 'Runs a temporary target test and checks that Datadog applies its quarantine setting.',
  },
}
// eslint-disable-next-line prefer-regex-literals
const CONTROL_CHARACTERS_PATTERN = new RegExp(String.raw`[\u0000-\u001F\u007F]+`, 'g')

/**
 * Produces the deterministic execution plan shown before live validation.
 *
 * @param {object} input plan inputs
 * @param {object} input.manifest normalized validation manifest
 * @param {string} input.out validation output directory
 * @param {string[]} [input.selectedFrameworkIds] explicitly selected framework entries
 * @param {string|null} [input.requestedScenario] explicitly selected scenario
 * @param {boolean} [input.keepTempFiles] whether generated files should be retained
 * @param {boolean} [input.verbose] whether command progress should be printed
 * @returns {string} Markdown execution plan
 */
function formatExecutionPlan ({
  manifest,
  out,
  selectedFrameworkIds = [],
  requestedScenario,
  keepTempFiles = false,
  verbose = false,
}) {
  assertPlannedExecutablesAvailable(manifest, requestedScenario)
  const offlineFixtureNonce = crypto.randomBytes(16).toString('hex')
  const approvalDigest = getApprovalDigest({
    manifest,
    out,
    selectedFrameworkIds,
    requestedScenario,
    offlineFixtureNonce,
    keepTempFiles,
    verbose,
  })

  const lines = [
    '# Test Optimization Validation Execution Plan',
    '',
    `Repository: ${inlineCode(manifest.repository.root)}`,
    `Manifest: ${inlineCode(manifest.__path)}`,
    `Results: ${inlineCode(out)}`,
    '',
    '## Framework Coverage',
    '',
  ]

  for (const framework of manifest.frameworks) {
    lines.push(`- ${plainText(framework.id)}: ${formatFrameworkStatus(framework.status)}`)
    if (framework.status !== 'runnable') {
      for (const note of framework.notes || []) lines.push(`  - ${plainText(note)}`)
    }
  }

  lines.push(
    '',
    '## Commands and Temporary Files',
    '',
    'Command environment values are shown after secret-like values are replaced with `<redacted>`. ' +
      'Validator-controlled offline cache and noise-suppression settings are described collectively.',
    ''
  )
  for (const framework of manifest.frameworks.filter(entry => entry.status === 'runnable')) {
    appendFrameworkExecutions(
      lines,
      framework,
      requestedScenario,
      manifest.repository.root,
      out,
      offlineFixtureNonce
    )
  }

  lines.push(
    '',
    '## Start the Validation',
    '',
    '`validate-test-optimization.js` is the local validator included with the installed `dd-trace` package. ' +
      'After approval, it creates bounded filesystem cache fixtures, performs every check listed above, writes ' +
      'events to local artifacts, and removes temporary fixtures and tests afterward. It does not open a listener ' +
      'or use a network endpoint.',
    '',
    codeBlock(sanitizeString(serializeApprovalCommand({
      argv: getValidatorArgv({
        approvedPlanSha256: approvalDigest,
        offlineFixtureNonce,
        repositoryRoot: manifest.repository.root,
        manifestPath: manifest.__path,
        out,
        selectedFrameworkIds,
        requestedScenario,
        keepTempFiles,
        verbose,
      }),
      cwd: manifest.repository.root,
      usesShell: false,
    }))),
    '',
    `Working directory: ${inlineCode(manifest.repository.root)}`,
    '',
    'The validator supplies diagnostic Datadog settings from cache files only while these local checks run; those ' +
      'settings are not customer CI recommendations. dd-trace makes no network requests in this validation mode. ' +
      'A setup or test command may still use the network unless the execution sandbox blocks it.',
    '',
    'These checks run the project commands listed above. The validator does not require real Datadog ' +
    'credentials, inspect credential stores, or upload validation results. Project tests are arbitrary code and ' +
      'can forge diagnostic cache or event data, so this result is diagnostic evidence, not a security attestation. ' +
      'Review the exact commands before approving them for this environment.',
    '',
    'Live validation has not started. The exact command above requires one approval before execution.'
  )

  return lines.join('\n')
}

/**
 * Refuses to render an approvable plan with a command that cannot start before setup runs.
 *
 * @param {object} manifest normalized validation manifest
 * @param {string|null|undefined} requestedScenario selected scenario
 * @returns {void}
 */
function assertPlannedExecutablesAvailable (manifest, requestedScenario) {
  for (const framework of manifest.frameworks.filter(entry => entry.status === 'runnable')) {
    const plannedCommands = getPlannedCommands(framework, requestedScenario)
    const setupCommandCount = framework.setup?.commands?.length || 0
    for (const [index, plannedCommand] of plannedCommands.entries()) {
      const executable = getUnavailableExecutable(plannedCommand.command)
      if (!executable) continue
      if (setupCommandCount > 0 && index > 0) continue

      throw new Error(
        `Cannot render an approvable plan because ${plannedCommand.label} for ${framework.id} uses ` +
        `executable "${executable}", which is not available from ${plannedCommand.command.cwd}. ` +
        'Choose a locally available command or mark this check with its concrete setup blocker before asking ' +
        'for approval.'
      )
    }
    for (const plannedCommand of plannedCommands) {
      const suitabilityError = getCommandSuitabilityError({
        command: plannedCommand.command,
        framework,
        label: plannedCommand.label,
        repositoryRoot: manifest.repository.root,
      })
      if (!suitabilityError) continue
      throw new Error(
        `Cannot render an approvable plan because ${plannedCommand.label} for ${framework.id} ${suitabilityError}`
      )
    }
  }
}

/**
 * Collects structured commands selected by the current plan options.
 *
 * @param {object} framework manifest framework entry
 * @param {string|null|undefined} requestedScenario selected scenario
 * @returns {{label: string, command: object}[]} planned commands
 */
function getPlannedCommands (framework, requestedScenario) {
  const commands = []
  for (const command of framework.setup?.commands || []) {
    commands.push({ label: `project setup command ${command.id || command.description || ''}`.trim(), command })
  }

  commands.push({ label: 'the selected test command', command: getBasicReportingCommand(framework) })

  const ciWiringSelected = !requestedScenario || requestedScenario === 'ci-wiring'
  if (ciWiringSelected && framework.ciWiringCommand) {
    commands.push({ label: 'the CI test command', command: getCiWiringCommand(framework) })
  }

  const selectedGeneratedScenario = getSelectedGeneratedScenario(requestedScenario)
  const advancedSelected = !requestedScenario || selectedGeneratedScenario
  const strategy = framework.generatedTestStrategy
  if (advancedSelected && strategy && ['planned', 'verified'].includes(strategy.status)) {
    const scenarios = selectedGeneratedScenario
      ? (strategy.scenarios || []).filter(scenario => scenario.id === selectedGeneratedScenario)
      : strategy.scenarios || []
    for (const scenario of scenarios) {
      commands.push({
        label: `the ${scenario.id} advanced-feature command`,
        command: getLocalValidationCommand(framework, scenario.runCommand),
      })
    }
  }

  return commands
}

/**
 * Builds the exact validator command covered by the approval checkpoint.
 *
 * @param {object} input command options
 * @param {string} input.approvedPlanSha256 digest of the approved manifest and options
 * @param {string} input.offlineFixtureNonce random fixture-root nonce shown in the execution plan
 * @param {string} input.repositoryRoot repository root
 * @param {string} input.manifestPath manifest path
 * @param {string} input.out output directory
 * @param {string[]} input.selectedFrameworkIds selected framework ids
 * @param {string|null|undefined} input.requestedScenario selected scenario
 * @param {boolean} input.keepTempFiles whether to retain generated files
 * @param {boolean} input.verbose whether to print command progress
 * @returns {string[]} validator argv
 */
function getValidatorArgv ({
  approvedPlanSha256,
  offlineFixtureNonce,
  repositoryRoot,
  manifestPath,
  out,
  selectedFrameworkIds,
  requestedScenario,
  keepTempFiles,
  verbose,
}) {
  const validatorPath = getPreferredValidatorPath(repositoryRoot)
  const argv = [validatorPath === VALIDATOR_PATH ? process.execPath : 'node', validatorPath]
  if (path.resolve(manifestPath) !== path.join(repositoryRoot, DEFAULT_MANIFEST_FILENAME)) {
    argv.push('--manifest', manifestPath)
  }
  if (path.resolve(out) !== path.join(repositoryRoot, DEFAULT_RESULTS_DIRECTORY)) {
    argv.push('--out', out)
  }
  argv.push(
    '--offline-fixture-nonce', offlineFixtureNonce,
    '--approved-plan-sha256', approvedPlanSha256
  )
  for (const frameworkId of selectedFrameworkIds) argv.push('--framework', frameworkId)
  if (requestedScenario) argv.push('--scenario', requestedScenario)
  if (keepTempFiles) argv.push('--keep-temp-files')
  if (verbose) argv.push('--verbose')
  return argv
}

/**
 * Uses the stable package path when it resolves to this installed validator.
 *
 * @param {string} repositoryRoot repository root
 * @returns {string} relative package path or exact validator path
 */
function getPreferredValidatorPath (repositoryRoot) {
  const directPath = path.join(repositoryRoot, 'node_modules', 'dd-trace', 'ci', 'validate-test-optimization.js')
  try {
    if (fs.realpathSync(directPath) === fs.realpathSync(VALIDATOR_PATH)) {
      return path.relative(repositoryRoot, directPath).split(path.sep).join('/')
    }
  } catch {}
  return VALIDATOR_PATH
}

function appendFrameworkExecutions (
  lines,
  framework,
  requestedScenario,
  repositoryRoot,
  out,
  offlineFixtureNonce
) {
  const basicCommand = getBasicReportingCommand(framework)
  lines.push(`### ${plainText(framework.id)}`, '')

  for (const setupCommand of framework.setup?.commands || []) {
    appendExecutionSection(lines, {
      heading: `Project Setup: ${setupCommand.id || setupCommand.description || 'Project Setup'}`,
      description: 'Prepares the project for the selected test command.',
      command: setupCommand,
      executions: '1',
      environment: 'Manifest command environment',
      repositoryRoot,
    })
  }
  appendExecutionSection(lines, {
    heading: 'Test Execution Without Datadog',
    description: 'Runs the selected test command without Datadog to confirm that the tests can run normally.',
    command: basicCommand,
    executions: '1',
    environment: `Remove inherited NODE_OPTIONS and DD_*; ${formatCommandVariableContext(basicCommand)}`,
    repositoryRoot,
  })
  appendExecutionSection(lines, {
    heading: 'Test Execution With Datadog',
    description: 'Runs the same test command with Datadog initialized and checks that test data is reported.',
    command: basicCommand,
    executions: '1, plus 1 debug rerun only if test data is missing',
    environment: 'Add Datadog initialization and validator-provided offline Datadog responses',
    repositoryRoot,
  })

  const ciWiringSelected = !requestedScenario || requestedScenario === 'ci-wiring'
  if (ciWiringSelected && framework.ciWiringCommand) {
    const ciCommand = getCiWiringCommand(framework)
    appendExecutionSection(lines, {
      heading: 'CI Test Execution',
      description: 'Runs the test command with the environment recorded from the identified CI job and checks ' +
        'whether that CI configuration initializes Datadog in the final test process.',
      command: ciCommand,
      executions: '1, plus 1 short preload probe when needed',
      environment: `Use variables recorded from the CI job: ${formatEnvironmentNames(framework.ciWiringCommand)}`,
      repositoryRoot,
    })
  } else if (ciWiringSelected) {
    lines.push(
      '#### CI Test Execution',
      '',
      'Not run.',
      '',
      `- Reason: ${plainText(
        framework.ciWiring?.reason || framework.ciWiring?.diagnosis || 'No replayable CI test command was selected.'
      )}`,
      ''
    )
  }

  const strategy = framework.generatedTestStrategy
  const selectedGeneratedScenario = getSelectedGeneratedScenario(requestedScenario)
  const advancedSelected = !requestedScenario || selectedGeneratedScenario
  if (advancedSelected && strategy && ['planned', 'verified'].includes(strategy.status)) {
    const selectedScenarios = selectedGeneratedScenario
      ? (strategy.scenarios || []).filter(scenario => scenario.id === selectedGeneratedScenario)
      : strategy.scenarios || []
    for (const scenario of selectedScenarios) {
      const command = getLocalValidationCommand(framework, scenario.runCommand)
      const details = GENERATED_SCENARIO_DETAILS[scenario.id] || {
        heading: `Advanced Check: ${scenario.id}`,
        description: 'Runs a temporary test to verify this advanced feature.',
      }
      appendExecutionSection(lines, {
        heading: details.heading,
        description: details.description,
        command,
        executions: '3: verify the test alone, discover its identity, then validate the feature; ' +
          'plus 1 debug rerun only on failure',
        environment: 'Validator-controlled feature settings from an offline cache fixture',
        repositoryRoot,
      })
    }
  }

  appendOfflineArtifacts(lines, {
    offlineFixtureNonce,
    framework,
    out,
    repositoryRoot,
    requestedScenario,
  })

  if (advancedSelected && strategy && ['planned', 'verified'].includes(strategy.status)) {
    lines.push(
      '#### Temporary Tests Created for Advanced Checks',
      '',
      'The validator creates these tests temporarily and removes them after validation.',
      ''
    )
    for (const file of strategy.files || []) {
      lines.push(
        `##### ${inlineCode(getRepositoryRelativePath(repositoryRoot, file.path))}`,
        '',
        codeBlock(file.contentLines.join('\n')),
        ''
      )
    }
    lines.push(
      '#### Temporary Test Cleanup',
      '',
      'The validator removes these temporary test and state files after validation. Paths are relative to the ' +
        'repository root:',
      ''
    )
    for (const cleanupPath of strategy.cleanupPaths || []) {
      lines.push(`- ${inlineCode(getRepositoryRelativePath(repositoryRoot, cleanupPath))}`)
    }
    lines.push('', 'Directories created for these files are also removed when they are empty.', '')
  } else if (advancedSelected && strategy) {
    lines.push(
      '#### Advanced Feature Checks',
      '',
      'Not run.',
      '',
      `- Reason: ${plainText(strategy.reason || strategy.status)}`,
      ''
    )
  }
  lines.push('')
}

/**
 * Describes the offline Datadog responses and event outputs used by instrumented executions.
 *
 * @param {string[]} lines rendered plan lines
 * @param {object} input plan inputs
 * @param {string} input.offlineFixtureNonce random fixture-root nonce
 * @param {object} input.framework framework manifest entry
 * @param {string} input.out validation result directory
 * @param {string} input.repositoryRoot repository root
 * @param {string|null|undefined} input.requestedScenario selected scenario
 */
function appendOfflineArtifacts (lines, {
  offlineFixtureNonce,
  framework,
  out,
  repositoryRoot,
  requestedScenario,
}) {
  lines.push(
    '#### Offline Datadog Responses',
    '',
    'During normal operation, `dd-trace` downloads Test Optimization settings and test lists from Datadog. ' +
      'For this offline validation, the validator writes equivalent bounded responses to a private temporary ' +
      'directory and `dd-trace` reads them from the filesystem. No Datadog backend, Agent, or network endpoint ' +
      'is used.',
    ''
  )

  const scenarioNames = getOfflineScenarioNames(requestedScenario)
  const firstFixture = getOfflineFixturePaths({
    offlineFixtureNonce,
    framework,
    scenarioName: scenarioNames[0],
  })
  const frameworkFixtureRoot = path.dirname(firstFixture.root)
  lines.push(
    `Temporary response root: ${inlineCode(frameworkFixtureRoot)}`,
    '',
    'Each execution folder below contains these files for `dd-trace` to read:',
    '',
    '- `.testoptimization/manifest.txt`: identifies the local cache format.',
    '- `.testoptimization/cache/http/settings.json`: enables or disables the Test Optimization behavior being ' +
      'checked.',
    '- `.testoptimization/cache/http/known_tests.json`: describes tests Datadog already knows about for Early ' +
      'Flake Detection.',
    '- `.testoptimization/cache/http/skippable_tests.json`: provides test-skipping data when applicable.',
    '- `.testoptimization/cache/http/test_management.json`: provides quarantine and other Test Management data.',
    '',
    'Execution folders:',
    ''
  )
  for (const scenarioName of scenarioNames) {
    lines.push(`- ${plainText(formatOfflineScenarioName(scenarioName))}: ${inlineCode(`${scenarioName}/`)}`)
  }
  lines.push(
    '',
    'A debug rerun uses the same Datadog response data as its corresponding check and adds `DD_TRACE_DEBUG=1`. ' +
      'It has a separate folder so it cannot overwrite the primary execution and every possible execution stays ' +
      'bound to the approved plan.',
    '',
    'A baseline run discovers the generated test identity with the feature disabled. The feature run then uses ' +
      'that identity with the feature enabled.',
    '',
    `Captured event artifacts: ${inlineCode(getRepositoryRelativePath(
      repositoryRoot,
      path.join(out, 'runs', sanitizePathSegment(framework.id))
    ))}`,
    '',
    'Each execution writes a bounded `.offline-events.raw.ndjson` file. The raw file is removed after parsing, ' +
      'and a sanitized `events.ndjson` file remains for diagnosis. Exact fixture recipes and paths are included ' +
      'in the approval digest even though this plan summarizes their shared layout.',
    ''
  )
}

function sanitizePathSegment (value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

/**
 * Renders one customer-facing validation step with its exact command and execution context.
 *
 * @param {string[]} lines rendered plan lines
 * @param {object} input execution details
 * @param {string} input.heading customer-facing check name
 * @param {string} input.description reason for the execution
 * @param {object} input.command manifest command
 * @param {string} input.executions maximum execution count
 * @param {string} input.environment environment changes made for this check
 * @param {string} input.repositoryRoot repository root
 * @returns {void}
 */
function appendExecutionSection (lines, {
  heading,
  description,
  command,
  executions,
  environment,
  repositoryRoot,
}) {
  lines.push(
    `#### ${plainText(heading)}`,
    '',
    plainText(description),
    '',
    'Command:',
    '',
    codeBlock(sanitizeString(serializeApprovalCommand(command))),
    '',
    `- Working directory: ${inlineCode(getRepositoryRelativePath(repositoryRoot, command.cwd))}`,
    `- Runs: ${plainText(executions)}`,
    `- Environment changes: ${plainText(environment)}`,
    `- Timeout: ${command.timeoutMs || 300_000} ms`
  )
  if (command.usesShell) lines.push(`- Shell executable: ${inlineCode(command.shell || 'platform default shell')}`)
  const commandEnvironment = sanitizeEnv(command.env)
  if (commandEnvironment) {
    lines.push(`- Command environment: ${Object.entries(commandEnvironment).map(([name, value]) => {
      return inlineCode(`${name}=${value}`)
    }).join(', ')}`)
  }
  const outputPaths = getCommandOutputPaths(command)
  if (outputPaths.length > 0) {
    lines.push('- Command-created outputs: ' + outputPaths.map(outputPath => {
      return inlineCode(getRepositoryRelativePath(repositoryRoot, outputPath))
    }).join(', ') + ' (pre-existing paths are restored; newly created paths are removed)')
  }
  for (const adjustment of command.localAdjustments || []) {
    lines.push(`- Local adjustment: ${plainText(adjustment)}`)
  }
  lines.push('')
}

function formatOfflineScenarioName (scenarioName) {
  return {
    'basic-reporting': 'Test execution with Datadog',
    'basic-reporting-debug': 'Test execution with Datadog, diagnostic rerun if needed',
    'ci-wiring': 'CI test execution',
    'efd-baseline': 'Early Flake Detection baseline',
    efd: 'Early Flake Detection check',
    'efd-debug': 'Early Flake Detection diagnostic rerun if needed',
    'atr-baseline': 'Auto Test Retries baseline',
    atr: 'Auto Test Retries check',
    'atr-debug': 'Auto Test Retries diagnostic rerun if needed',
    'test-management-baseline': 'Test Management baseline',
    'test-management': 'Test Management check',
    'test-management-debug': 'Test Management diagnostic rerun if needed',
  }[scenarioName] || scenarioName
}

/**
 * Shortens a validated repository path for customer-facing plans.
 *
 * @param {string} repositoryRoot repository root shown at the start of the plan
 * @param {string} filename absolute validated path
 * @returns {string} repository-relative path when possible
 */
function getRepositoryRelativePath (repositoryRoot, filename) {
  const relative = path.relative(repositoryRoot, filename)
  if (!relative) return '.'
  if (relative.startsWith('..') || path.isAbsolute(relative)) return filename
  return relative.split(path.sep).join('/')
}

function getSelectedGeneratedScenario (requestedScenario) {
  return {
    efd: 'basic-pass',
    atr: 'atr-fail-once',
    'test-management': 'test-management-target',
  }[requestedScenario]
}

function formatEnvironmentNames (command) {
  const names = Object.keys(command.env || {})
  return names.length > 0 ? names.join(', ') : 'no command-specific variables'
}

/**
 * Describes command-specific variables without displaying their values.
 *
 * @param {object} command manifest command
 * @returns {string} variable context
 */
function formatCommandVariableContext (command) {
  const names = Object.keys(command.env || {})
  return names.length > 0
    ? `keep command variables: ${names.join(', ')}`
    : 'the command sets no other environment variables'
}

/**
 * Converts manifest framework statuses into customer-facing plan text.
 *
 * @param {string} status manifest framework status
 * @returns {string} customer-facing status
 */
function formatFrameworkStatus (status) {
  return {
    runnable: 'will be validated',
    detected_not_runnable: 'detected, but no runnable command was found',
    requires_external_service: 'requires an external service',
    requires_manual_setup: 'requires additional setup',
    unsupported_by_validator: 'not supported by this validator',
    unknown: 'could not be determined',
  }[status] || plainText(status)
}

function codeBlock (value) {
  return `\`\`\`text\n${visibleMultilineText(value).replaceAll('```', String.raw`\u0060\u0060\u0060`)}\n\`\`\``
}

function inlineCode (value) {
  return `\`${plainText(value).replaceAll('`', String.raw`\u0060`)}\``
}

function plainText (value) {
  return sanitizeString(String(value ?? '')).replaceAll(CONTROL_CHARACTERS_PATTERN, ' ').trim()
}

function visibleMultilineText (value) {
  return String(value ?? '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', String.raw`\r`)
    // eslint-disable-next-line prefer-regex-literals
    .replaceAll(new RegExp(String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`, 'g'), character => {
      return String.raw`\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    })
    .trim()
}

module.exports = { formatExecutionPlan }
