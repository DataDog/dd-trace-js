'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { serializeDisplayCommand } = require('./command-runner')
const { getLocalValidationCommand } = require('./local-command')
const { sanitizeString } = require('./redaction')
const { getBasicReportingCommand } = require('./scenarios/basic-reporting')

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
    'Environment variable values are not displayed. Only non-secret variable names are shown.',
    ''
  )
  for (const framework of manifest.frameworks.filter(entry => entry.status === 'runnable')) {
    appendFrameworkExecutions(lines, framework)
  }

  lines.push(
    '',
    '## Start the Validation',
    '',
    'After approval, the agent runs this one command. It starts the validator included with the installed ' +
      '`dd-trace` package, performs every check listed above against a local mock intake, writes the validation ' +
      'report, and removes the temporary test files afterward.',
    '',
    codeBlock(sanitizeString(serializeDisplayCommand({
      argv: getValidatorArgv({
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

function appendFrameworkExecutions (lines, framework) {
  const basicCommand = getBasicReportingCommand(framework)
  lines.push(`### ${plainText(framework.id)}`, '')
  for (const setupCommand of framework.setup?.commands || []) {
    appendCommandSection(
      lines,
      `Project Setup: ${setupCommand.id || setupCommand.description || 'project setup'}`,
      setupCommand,
      { description: 'Prepares the project for the test executions below.' }
    )
  }
  appendCommandSection(lines, 'Test Execution Without Datadog', basicCommand, {
    description: 'Checks that the selected tests can run before Datadog is initialized.',
    environmentLabel: 'Environment changes',
    environment: `remove inherited NODE_OPTIONS and DD_* variables; ${formatCommandVariableContext(basicCommand)}`,
  })
  appendCommandSection(lines, 'Test Execution With Datadog', basicCommand, {
    description: 'Checks that the tests report to the local mock intake when Datadog is initialized correctly.',
    environmentLabel: 'Environment changes',
    environment: `supply Datadog initialization and the local mock intake; ${
      formatCommandVariableContext(basicCommand)
    }`,
  })

  if (framework.ciWiringCommand) {
    appendCommandSection(lines, 'Test Execution With CI Configuration', framework.ciWiringCommand, {
      description: 'Checks whether the configuration supplied by the CI job initializes Datadog in the final ' +
        'test process.',
      environmentLabel: 'CI environment variables copied for this test (values hidden)',
      environment: formatEnvironmentNames(framework.ciWiringCommand),
    })
  } else {
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
  if (strategy && ['planned', 'verified'].includes(strategy.status)) {
    lines.push(
      '#### Temporary Tests Created for Advanced Checks',
      '',
      'The validator creates these tests temporarily and removes them after validation.',
      ''
    )
    for (const file of strategy.files || []) lines.push(`- ${inlineCode(file.path)}`)
    lines.push('')
    for (const scenario of strategy.scenarios || []) {
      const command = getLocalValidationCommand(framework, scenario.runCommand)
      const details = GENERATED_SCENARIO_DETAILS[scenario.id] || {
        heading: `Advanced Check: ${scenario.id}`,
        description: 'Runs a temporary test to verify this advanced feature.',
      }
      appendCommandSection(lines, details.heading, command, { description: details.description })
    }
    lines.push(
      '#### Files Removed After Validation',
      '',
      'The validator deletes these temporary files after all checks finish:',
      ''
    )
    for (const cleanupPath of strategy.cleanupPaths || []) lines.push(`- ${inlineCode(cleanupPath)}`)
    lines.push('', 'Directories created for these files are also removed when they are empty.', '')
  } else if (strategy) {
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
 * Adds one execution phase to the customer-facing plan.
 *
 * @param {string[]} lines rendered plan lines
 * @param {string} heading execution phase heading
 * @param {object} command manifest command
 * @param {object} [options] display options
 * @param {string} [options.description] purpose of the execution phase
 * @param {string} [options.environmentLabel] environment detail label
 * @param {string} [options.environment] environment detail
 * @returns {void}
 */
function appendCommandSection (lines, heading, command, options = {}) {
  const environment = options.environment || (Object.keys(command.env || {}).length > 0
    ? formatEnvironmentNames(command)
    : undefined)
  lines.push(`#### ${plainText(heading)}`, '')
  if (options.description) lines.push(plainText(options.description), '')
  lines.push(
    codeBlock(sanitizeString(serializeDisplayCommand(command))),
    '',
    `- Working directory: ${inlineCode(command.cwd)}`
  )
  if (environment) {
    lines.push(`- ${plainText(options.environmentLabel || 'Environment variable names')}: ${
      plainText(environment)
    }`)
  }
  for (const adjustment of command.localAdjustments || []) {
    lines.push(`- Local adjustment: ${plainText(adjustment)}`)
  }
  lines.push('')
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
  return `\`\`\`text\n${plainText(value).replaceAll('```', String.raw`\u0060\u0060\u0060`)}\n\`\`\``
}

function inlineCode (value) {
  return `\`${plainText(value).replaceAll('`', String.raw`\u0060`)}\``
}

function plainText (value) {
  return String(value ?? '').replaceAll(CONTROL_CHARACTERS_PATTERN, ' ').trim()
}

module.exports = { formatExecutionPlan }
