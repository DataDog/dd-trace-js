'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { getApprovalDigest } = require('./approval')
const { getCommandOutputPaths } = require('./command-output-policy')
const { getCommandSuitabilityError } = require('./command-suitability')
const { serializeApprovalCommand } = require('./command-runner')
const { getUnavailableExecutable } = require('./executable')
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
  assertPlannedExecutablesAvailable(manifest, requestedScenario)

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
    appendFrameworkExecutions(lines, framework, requestedScenario, manifest.repository.root)
  }

  lines.push(
    '',
    '## Start the Validation',
    '',
    '`validate-test-optimization.js` is the local validator included with the installed `dd-trace` package. ' +
      'After approval, it starts a mock intake on `127.0.0.1`, performs every check listed above, writes the ' +
      'local validation report, and removes the temporary test files afterward.',
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

function appendFrameworkExecutions (lines, framework, requestedScenario, repositoryRoot) {
  const basicCommand = getBasicReportingCommand(framework)
  const commands = createCommandCatalog()
  const checks = []

  for (const setupCommand of framework.setup?.commands || []) {
    checks.push({
      check: `Project setup: ${setupCommand.id || setupCommand.description || 'project setup'}`,
      commandId: commands.add(setupCommand),
      executions: '1',
      environment: 'Manifest command environment',
    })
  }
  const basicCommandId = commands.add(basicCommand)
  checks.push(
    {
      check: 'Confirm tests run without Datadog',
      commandId: basicCommandId,
      executions: '1',
      environment: `Remove inherited NODE_OPTIONS and DD_*; ${formatCommandVariableContext(basicCommand)}`,
    },
    {
      check: 'Confirm tests report when Datadog is initialized',
      commandId: basicCommandId,
      executions: '1, plus 1 debug rerun only if events are missing',
      environment: 'Add dd-trace initialization and the localhost mock intake',
    }
  )

  const ciWiringSelected = !requestedScenario || requestedScenario === 'ci-wiring'
  if (ciWiringSelected && framework.ciWiringCommand) {
    const ciCommand = getCiWiringCommand(framework)
    checks.push({
      check: 'Check the real CI configuration',
      commandId: commands.add(ciCommand),
      executions: '1, plus 1 short preload probe when needed',
      environment: `Copy CI variables: ${formatEnvironmentNames(framework.ciWiringCommand)}`,
    })
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
      checks.push({
        check: details.heading,
        commandId: commands.add(command),
        executions: '3: isolate, discover identity, validate feature; plus 1 debug rerun only on failure',
        environment: 'Validator-controlled feature settings and localhost mock intake',
      })
    }
  }

  lines.push(`### ${plainText(framework.id)}`, '', '#### Checks', '')
  appendCheckTable(lines, checks)
  if (ciWiringSelected && !framework.ciWiringCommand) {
    lines.push(
      '',
      `CI configuration check not run: ${plainText(
        framework.ciWiring?.reason || framework.ciWiring?.diagnosis || 'No replayable CI test command was selected.'
      )}`
    )
  }
  lines.push('', '#### Commands', '')
  for (const entry of commands.entries) appendCommandDefinition(lines, entry, repositoryRoot)

  if (advancedSelected && strategy && ['planned', 'verified'].includes(strategy.status)) {
    lines.push(
      '#### Temporary Tests Created for Advanced Checks',
      '',
      'The validator creates these tests temporarily and removes them after validation.',
      ''
    )
    for (const file of strategy.files || []) {
      lines.push(
        `<details><summary>${inlineCode(getRepositoryRelativePath(repositoryRoot, file.path))}</summary>`,
        '',
        codeBlock(file.contentLines.join('\n')),
        '',
        '</details>',
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

function createCommandCatalog () {
  const entries = []
  const identifiers = new Map()
  return {
    entries,
    add (command) {
      const key = serializeApprovalCommand(command)
      let identifier = identifiers.get(key)
      if (identifier) return identifier
      identifier = `C${entries.length + 1}`
      identifiers.set(key, identifier)
      entries.push({ command, identifier })
      return identifier
    },
  }
}

function appendCheckTable (lines, checks) {
  lines.push('| Check | Command | Runs | Environment |', '|---|---:|---:|---|')
  for (const check of checks) {
    lines.push(`| ${tableText(check.check)} | ${check.commandId} | ${tableText(check.executions)} | ` +
      `${tableText(check.environment)} |`)
  }
}

function appendCommandDefinition (lines, entry, repositoryRoot) {
  const { command, identifier } = entry
  lines.push(
    `##### ${identifier}`,
    '',
    codeBlock(sanitizeString(serializeApprovalCommand(command))),
    '',
    `- Working directory: ${inlineCode(getRepositoryRelativePath(repositoryRoot, command.cwd))}`,
    `- Timeout: ${command.timeoutMs || 300_000} ms`
  )
  if (command.usesShell) lines.push(`- Shell executable: ${inlineCode(command.shell || 'platform default shell')}`)
  const environment = sanitizeEnv(command.env)
  if (environment) {
    lines.push(`- Command environment: ${Object.entries(environment).map(([name, value]) => {
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

function tableText (value) {
  return plainText(value).replaceAll('|', String.raw`\|`)
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
  return relative
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
