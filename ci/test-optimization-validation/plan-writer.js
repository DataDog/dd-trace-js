'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { getApprovalDigest } = require('./approval')
const { serializeApprovalCommand } = require('./command-runner')
const { getLocalValidationCommand } = require('./local-command')
const { sanitizeEnv, sanitizeString } = require('./redaction')
const { getBasicReportingCommand } = require('./scenarios/basic-reporting')
const { getCiWiringCommand } = require('./scenarios/ci-wiring')

const VALIDATOR_PATH = path.resolve(__dirname, '..', 'validate-test-optimization.js')
const DEFAULT_MANIFEST_FILENAME = 'dd-test-optimization-validation-manifest.json'
const DEFAULT_RESULTS_DIRECTORY = 'dd-test-optimization-validation-results'
const GENERATED_SCENARIO_DETAILS = {
  'basic-pass': {
    heading: 'Advanced Check: Early Flake Detection',
    description: 'Runs a temporary passing test to verify Early Flake Detection.',
  },
  'atr-fail-once': {
    heading: 'Advanced Check: Auto Test Retries',
    description: 'Runs a temporary fail-once test to verify Auto Test Retries.',
  },
  'test-management-target': {
    heading: 'Advanced Check: Test Management',
    description: 'Runs a temporary target test to verify Test Management.',
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
      'Validator-controlled fake-intake and noise-suppression settings are described collectively.',
    ''
  )
  for (const framework of manifest.frameworks.filter(entry => entry.status === 'runnable')) {
    appendFrameworkExecutions(lines, framework, requestedScenario)
  }

  lines.push(
    '',
    '## Start the Validation',
    '',
    'After approval, the agent runs this one command. It starts the validator included with the installed ' +
      '`dd-trace` package, performs every check listed above against a local mock intake, writes the validation ' +
      'report, and removes the temporary test files afterward.',
    '',
    codeBlock(sanitizeString(serializeApprovalCommand({
      argv: getValidatorArgv({
        approvedPlanSha256: getApprovalDigest({
          manifest,
          out,
          selectedFrameworkIds,
          requestedScenario,
          keepTempFiles,
          verbose,
        }),
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
    'The validator requires localhost listen/connect access for the mock intake. It supplies diagnostic ' +
      'Datadog settings only while these local checks run; those settings are not customer CI recommendations. ' +
      'It does not require outbound networking unless a setup or test command listed above requires it.',
    '',
    'These checks run the project commands listed above. The validator does not require real Datadog ' +
      'credentials, inspect credential stores, or upload validation results. Review the exact commands before ' +
      'approving them for this environment.',
    '',
    'Approve executing exactly the plan above?'
  )

  return lines.join('\n')
}

/**
 * Builds the exact validator command covered by the approval checkpoint.
 *
 * @param {object} input command options
 * @param {string} input.approvedPlanSha256 digest of the approved manifest and options
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
  argv.push('--approved-plan-sha256', approvedPlanSha256)
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
      return path.relative(repositoryRoot, directPath)
    }
  } catch {}
  return VALIDATOR_PATH
}

function appendFrameworkExecutions (lines, framework, requestedScenario) {
  const basicCommand = getBasicReportingCommand(framework)
  lines.push(`### ${plainText(framework.id)}`, '')
  for (const setupCommand of framework.setup?.commands || []) {
    appendCommandSection(
      lines,
      `Project Setup: ${setupCommand.id || setupCommand.description || 'project setup'}`,
      setupCommand,
      {
        description: 'Prepares the project for the test executions below.',
        executions: 'once',
      }
    )
  }
  appendCommandSection(lines, 'Test Execution Without Datadog', basicCommand, {
    description: 'Checks that the selected tests can run before Datadog is initialized.',
    executions: 'once',
    environmentLabel: 'Environment changes',
    environment: `remove inherited NODE_OPTIONS and DD_* variables; ${formatCommandVariableContext(basicCommand)}`,
  })
  appendCommandSection(lines, 'Test Execution With Datadog', basicCommand, {
    description: 'Checks that the tests report to the local mock intake when Datadog is initialized correctly.',
    executions: 'once, plus at most one diagnostic rerun with debug logging if expected events are missing',
    environmentLabel: 'Environment changes',
    environment: `supply Datadog initialization and the local mock intake; ${
      formatCommandVariableContext(basicCommand)
    }`,
  })

  const ciWiringSelected = !requestedScenario || requestedScenario === 'ci-wiring'
  if (ciWiringSelected && framework.ciWiringCommand) {
    appendCommandSection(lines, 'Test Execution With CI Configuration', getCiWiringCommand(framework), {
      description: 'Checks whether the configuration supplied by the CI job initializes Datadog in the final ' +
        'test process.',
      executions: 'once, plus at most one initialization-reachability probe reusing the displayed CI argv or ' +
        'shell source if expected events are missing; the probe removes Datadog preloads from CI NODE_OPTIONS ' +
        'and adds its own local preload',
      environmentLabel: 'CI environment variables copied for this test',
      environment: formatEnvironmentNames(framework.ciWiringCommand),
    })
  } else if (ciWiringSelected) {
    lines.push(
      '#### Test Execution With CI Configuration',
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
    lines.push(
      '#### Temporary Tests Created for Advanced Checks',
      '',
      'The validator creates these tests temporarily and removes them after validation.',
      ''
    )
    for (const file of strategy.files || []) {
      lines.push(
        `- Path: ${inlineCode(file.path)}`,
        '',
        '  Exact temporary test content:',
        '',
        codeBlock(file.contentLines.join('\n')),
        ''
      )
    }
    lines.push('')
    const selectedScenarios = selectedGeneratedScenario
      ? (strategy.scenarios || []).filter(scenario => scenario.id === selectedGeneratedScenario)
      : strategy.scenarios || []
    for (const scenario of selectedScenarios) {
      const command = getLocalValidationCommand(framework, scenario.runCommand)
      const details = GENERATED_SCENARIO_DETAILS[scenario.id] || {
        heading: `Advanced Check: ${scenario.id}`,
        description: 'Runs a temporary test to verify this advanced feature.',
      }
      appendCommandSection(lines, details.heading, command, {
        description: details.description,
        executions: 'three times: once without Datadog to verify test isolation, once to discover the reported ' +
          'test identity, and once with the feature enabled; on failure, at most one additional debug rerun',
      })
    }
    lines.push(
      '#### Files Removed After Validation',
      '',
      'The validator deletes these temporary files after all checks finish:',
      ''
    )
    for (const cleanupPath of strategy.cleanupPaths || []) lines.push(`- ${inlineCode(cleanupPath)}`)
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

function getSelectedGeneratedScenario (requestedScenario) {
  return {
    efd: 'basic-pass',
    atr: 'atr-fail-once',
    'test-management': 'test-management-target',
  }[requestedScenario]
}

/**
 * Adds one execution phase to the customer-facing plan.
 *
 * @param {string[]} lines rendered plan lines
 * @param {string} heading execution phase heading
 * @param {object} command manifest command
 * @param {object} [options] display options
 * @param {string} [options.description] purpose of the execution phase
 * @param {string} [options.executions] number and purpose of command executions
 * @param {string} [options.environmentLabel] environment detail label
 * @param {string} [options.environment] environment detail
 * @returns {void}
 */
function appendCommandSection (lines, heading, command, options = {}) {
  const environment = options.environment
  lines.push(`#### ${plainText(heading)}`, '')
  if (options.description) lines.push(plainText(options.description), '')
  lines.push(
    codeBlock(sanitizeString(serializeApprovalCommand(command))),
    '',
    `- Working directory: ${inlineCode(command.cwd)}`
  )
  if (options.executions) lines.push(`- Executions: ${plainText(options.executions)}`)
  if (command.usesShell) {
    lines.push(`- Shell executable: ${inlineCode(command.shell || 'platform default shell')}`)
  }
  lines.push(`- Timeout: ${command.timeoutMs || 300_000} ms`)
  if (environment) {
    lines.push(`- ${plainText(options.environmentLabel || 'Environment variable names')}: ${
      plainText(environment)
    }`)
  }
  appendCommandEnvironment(lines, command)
  for (const adjustment of command.localAdjustments || []) {
    lines.push(`- Local adjustment: ${plainText(adjustment)}`)
  }
  lines.push('')
}

function appendCommandEnvironment (lines, command) {
  const environment = sanitizeEnv(command.env)
  if (!environment) {
    lines.push('- Command-specific environment: none')
    return
  }

  lines.push('- Command-specific environment:')
  for (const [name, value] of Object.entries(environment)) {
    lines.push(`  - ${inlineCode(`${name}=${value}`)}`)
  }
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
