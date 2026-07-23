'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { writeApprovalArtifacts } = require('./approval-artifacts')
const { getCommandOutputPaths } = require('./command-output-policy')
const { getCommandSuitabilityError, getPackageScriptExpansion } = require('./command-suitability')
const { serializeApprovalCommand } = require('./command-runner')
const { getGeneratedTestContractError } = require('./generated-test-contract')
const {
  getUnavailableExecutable,
} = require('./executable')
const { getDatadogCleanCommand, getLocalValidationCommand } = require('./local-command')
const { sanitizeEnv, sanitizeString } = require('./redaction')
const { writeFileSafely } = require('./safe-files')

const VALIDATOR_PATH = path.resolve(__dirname, '..', 'validate-test-optimization.js')
const EXECUTION_PLAN_FILENAME = 'execution-plan.md'
const GENERATED_SCENARIO_DETAILS = {
  'basic-pass': {
    heading: 'Advanced Check: Early Flake Detection',
    description: 'Creates a temporary passing test, records it with Early Flake Detection disabled, then enables ' +
      'the feature and checks that Datadog recognizes the test as new and retries it.',
  },
  'atr-fail-once': {
    heading: 'Advanced Check: Auto Test Retries',
    description: 'Creates a temporary test that fails on its first attempt, then checks that Datadog retries it ' +
      'and observes the passing attempt.',
  },
  'test-management-target': {
    heading: 'Advanced Check: Test Management',
    description: 'Creates a temporary target test, supplies a quarantine setting for that test, then checks that ' +
      'Datadog applies the setting.',
  },
}
const FRAMEWORK_NAMES = {
  jest: 'Jest',
  karma: 'Karma',
  mocha: 'Mocha',
  'node:test': 'Node.js test runner',
  playwright: 'Playwright',
  vitest: 'Vitest',
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
function formatExecutionPlan (input) {
  return formatExecutionPlanArtifacts(input).plan
}

/**
 * Writes and returns the approval plan without running project code.
 *
 * @param {object} input plan inputs
 * @param {object} input.manifest normalized validation manifest
 * @param {string} input.out validation output directory
 * @param {string[]} [input.selectedFrameworkIds] explicitly selected framework entries
 * @param {string|null} [input.requestedScenario] explicitly selected scenario
 * @param {boolean} [input.keepTempFiles] whether generated files should be retained
 * @param {boolean} [input.verbose] whether command progress should be printed
 * @returns {{plan: string}} written approval-plan content
 */
function formatExecutionPlanArtifacts ({
  manifest,
  out,
  selectedFrameworkIds = [],
  requestedScenario,
  keepTempFiles = false,
  verbose = false,
}) {
  assertPlannedExecutablesAvailable(manifest, requestedScenario)
  const offlineFixtureNonce = crypto.randomBytes(16).toString('hex')
  const approvalArtifacts = writeApprovalArtifacts({
    manifest,
    out,
    selectedFrameworkIds,
    requestedScenario,
    offlineFixtureNonce,
    keepTempFiles,
    verbose,
  })
  const approvalDigest = approvalArtifacts.digest
  const validatorArgv = getValidatorArgv({
    approvedPlanSha256: approvalDigest,
    approvalJsonPath: approvalArtifacts.approvalJsonPath,
    repositoryRoot: manifest.repository.root,
  })
  const plan = formatApprovalPlan({
    approvalArtifacts,
    approvalDigest,
    manifest,
    out,
    requestedScenario,
    validatorArgv,
  })
  writeFileSafely(out, getExecutionPlanPath(out), `${plan}\n`, 'validation execution plan')
  return { plan }
}

/**
 * Returns the bounded customer-facing summary an agent presents before approval.
 *
 * @param {object} input summary inputs
 * @param {object} input.approvalArtifacts written approval artifact paths
 * @param {string} input.approvalDigest approval material digest
 * @param {object} input.manifest normalized validation manifest
 * @param {string} input.out validation output directory
 * @param {string|null|undefined} input.requestedScenario selected scenario
 * @param {string[]} input.validatorArgv approved validator command
 * @returns {string} Markdown approval plan
 */
function formatApprovalPlan ({
  approvalArtifacts,
  approvalDigest,
  manifest,
  out,
  requestedScenario,
  validatorArgv,
}) {
  const repositoryRoot = manifest.repository.root
  const coveredFileVerification = process.platform === 'win32'
    ? []
    : [
        'Optional: verify every covered manifest, validator, and executable file:',
        '',
        codeBlock(sanitizeString(serializeApprovalCommand({
          argv: ['shasum', '-a', '256', '--quiet', '-c', approvalArtifacts.coveredFilesPath],
          cwd: repositoryRoot,
          usesShell: false,
        }))),
        '',
      ]
  const lines = [
    '# Test Optimization Validation Execution Plan',
    '',
    `Repository: ${inlineCode(repositoryRoot)}`,
    `Manifest: ${inlineCode(getRepositoryRelativePath(repositoryRoot, manifest.__path))}`,
    `Results: ${inlineCode(getRepositoryRelativePath(repositoryRoot, out))}`,
    '',
    'This plan shows every project command and the exact temporary test source. The validator also creates bounded ' +
      'private filesystem responses for Test Optimization settings and writes local event artifacts; it opens no ' +
      'listener and contacts no Datadog endpoint.',
    '',
    '## Scope',
    '',
  ]

  for (const framework of manifest.frameworks) {
    const label = formatFrameworkLabel(framework, repositoryRoot)
    lines.push(`- **${plainText(label)}**: ${formatFrameworkStatus(framework.status)}`)
    if (framework.localSocketRequired) {
      lines.push('  - Every safe representative test found appears to require a project localhost listener. ' +
        'Validation may be blocked if the current execution environment denies those sockets.')
    }
    if (framework.status !== 'runnable' && framework.notes?.[0]) {
      lines.push(`  - ${plainText(framework.notes[0])}`)
    }
  }

  lines.push('', '## Commands', '')
  for (const framework of manifest.frameworks.filter(entry => entry.status === 'runnable')) {
    appendApprovalSummaryFramework(lines, framework, requestedScenario, repositoryRoot)
  }

  lines.push(
    '## Safety and Outputs',
    '',
    `- Local results: ${inlineCode(getRepositoryRelativePath(repositoryRoot, out))}`,
    '- The validator creates private offline Datadog response files outside the repository and removes them ' +
      'afterward.',
    '- The dd-trace validation path opens no listener, contacts no Datadog endpoint, requires no real Datadog ' +
      'credentials, and uploads nothing.',
    '- Project commands are repository code and may use the network or access local resources unless the ' +
      'execution environment prevents it.',
    '',
    '## Approval Command',
    '',
    `Approval details: ${inlineCode(getRepositoryRelativePath(
      repositoryRoot,
      approvalArtifacts.approvalJsonPath
    ))}`,
    '',
    'Optional: independently reproduce the approval hash without running project code:',
    '',
    codeBlock(formatIndependentHashCommand(approvalArtifacts.approvalJsonPath)),
    '',
    `Expected SHA-256: ${inlineCode(approvalDigest)}`,
    '',
    ...coveredFileVerification,
    'These checks confirm that the reviewed inputs have not changed since plan generation. They do not verify ' +
      'where the installed `dd-trace` package came from; establish package origin separately through trusted ' +
      'lockfile/integrity metadata or a verified package tarball.',
    '',
    'Run the approved validation command:',
    '',
    codeBlock(sanitizeString(serializeApprovalCommand({
      argv: validatorArgv,
      cwd: repositoryRoot,
      usesShell: false,
    }))),
    '',
    `Working directory: ${inlineCode(repositoryRoot)}`
  )
  return lines.join('\n')
}

/**
 * Appends one runnable framework to the bounded approval plan.
 *
 * @param {string[]} lines rendered summary lines
 * @param {object} framework manifest framework entry
 * @param {string|null|undefined} requestedScenario selected scenario
 * @param {string} repositoryRoot repository root
 * @returns {void}
 */
function appendApprovalSummaryFramework (lines, framework, requestedScenario, repositoryRoot) {
  const directInitialization = getDirectInitialization(framework)
  const candidates = getLocalTestCandidates(framework)
  lines.push(`### ${plainText(formatFrameworkLabel(framework, repositoryRoot))}`, '')

  for (const [index, candidate] of candidates.entries()) {
    appendApprovalSummaryCandidate(lines, {
      candidate,
      directInitialization,
      framework,
      index,
      repositoryRoot,
    })
  }

  const ciWiringSelected = !requestedScenario || requestedScenario === 'ci-wiring'
  if (ciWiringSelected) {
    lines.push(
      '**CI configuration audit:** inspect the recorded workflow, job, step, environment, and wrapper evidence ' +
        'without running a project command.',
      '',
      `- Identified CI location: ${plainText(formatCiAuditLocation(framework.ciWiring))}`,
      `- Recorded initialization: ${plainText(framework.ciWiring?.initialization?.status || 'unknown')}`,
      ''
    )
  }

  const selectedGeneratedScenario = getSelectedGeneratedScenario(requestedScenario)
  const advancedSelected = !requestedScenario || selectedGeneratedScenario
  const strategy = framework.generatedTestStrategy
  if (advancedSelected && strategy && ['planned', 'verified'].includes(strategy.status)) {
    const scenarios = selectedGeneratedScenario
      ? (strategy.scenarios || []).filter(scenario => scenario.id === selectedGeneratedScenario)
      : strategy.scenarios || []
    lines.push(
      '**Advanced feature checks:** each command runs verification, identity discovery, and feature validation ' +
        '(3 runs, or 4 when a debug run is needed).',
      ''
    )
    for (const scenario of scenarios) {
      appendApprovalSummaryAdvancedCommand(lines, {
        command: getLocalValidationCommand(framework, scenario.runCommand),
        directInitialization,
        label: GENERATED_SCENARIO_DETAILS[scenario.id]?.heading || `Advanced check: ${scenario.id}`,
        repositoryRoot,
      })
    }

    lines.push('**Temporary test source:**', '')
    for (const file of strategy.files || []) {
      lines.push(
        `${inlineCode(getRepositoryRelativePath(repositoryRoot, file.path))}`,
        '',
        codeBlock(file.contentLines.join('\n')),
        ''
      )
    }
    lines.push('**Files removed after validation:**', '')
    for (const cleanupPath of strategy.cleanupPaths || []) {
      lines.push(`- ${inlineCode(getRepositoryRelativePath(repositoryRoot, cleanupPath))}`)
    }
    lines.push('')
  } else if (advancedSelected && strategy) {
    lines.push(`**Advanced feature checks:** not run. ${plainText(strategy.reason || strategy.status)}`, '')
  }
}

/**
 * Appends the clean and Datadog executions for one disclosed fallback candidate.
 *
 * @param {string[]} lines rendered summary lines
 * @param {object} input candidate summary
 * @param {{command: object, maxTestCount: number}} input.candidate local candidate
 * @param {string} input.directInitialization Datadog preload value
 * @param {object} input.framework manifest framework entry
 * @param {number} input.index zero-based candidate index
 * @param {string} input.repositoryRoot repository root
 * @returns {void}
 */
function appendApprovalSummaryCandidate (lines, {
  candidate,
  directInitialization,
  framework,
  index,
  repositoryRoot,
}) {
  const command = getLocalValidationCommand(framework, candidate.command)
  const cleanCommand = getDatadogCleanCommand(command)
  lines.push(
    `**Test candidate ${index + 1}**`,
    '',
    'Without Datadog (confirms the selected test file runs normally):',
    '',
    codeBlock(formatCommandForPlan(cleanCommand, repositoryRoot)),
    '',
    'With Datadog, only if this is the first candidate that passes: run the same command with ' +
      `${inlineCode(`NODE_OPTIONS=${directInitialization}`)}.`,
    `- Working directory: ${inlineCode(getRepositoryRelativePath(repositoryRoot, command.cwd))}`,
    `- Test bound: 1 to ${candidate.maxTestCount}; timeout: ${command.timeoutMs || 300_000} ms`,
    '- Each command runs at most once; the Datadog execution may have one additional debug rerun.',
    '- Inherited `NODE_OPTIONS` and `DD_*` variables are removed from the clean execution.'
  )
  appendApprovalSummaryCommandContext(lines, command, repositoryRoot)
  lines.push('')
}

/**
 * Appends one compact advanced-feature command.
 *
 * @param {string[]} lines rendered summary lines
 * @param {object} input command summary
 * @param {object} input.command structured command
 * @param {string} input.directInitialization Datadog preload value
 * @param {string} input.label customer-facing label
 * @param {string} input.repositoryRoot repository root
 * @returns {void}
 */
function appendApprovalSummaryAdvancedCommand (lines, {
  command,
  directInitialization,
  label,
  repositoryRoot,
}) {
  lines.push(
    `- **${plainText(label)}**`,
    '',
    codeBlock(formatCommandForPlan(command, repositoryRoot, { NODE_OPTIONS: directInitialization })),
    '',
    `  Working directory: ${inlineCode(getRepositoryRelativePath(repositoryRoot, command.cwd))}; ` +
      `timeout: ${command.timeoutMs || 300_000} ms`
  )
  appendApprovalSummaryCommandContext(lines, command, repositoryRoot, '  ')
  lines.push('')
}

/**
 * Appends command details that differ from the rendered command itself.
 *
 * @param {string[]} lines rendered summary lines
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @param {string} [prefix] line prefix
 * @returns {void}
 */
function appendApprovalSummaryCommandContext (lines, command, repositoryRoot, prefix = '- ') {
  if (command.usesShell) {
    lines.push(`${prefix}Shell executable: ${inlineCode(command.shell || 'platform default shell')}`)
  }
  const packageScriptExpansion = getPackageScriptExpansion(command, repositoryRoot)
  if (packageScriptExpansion) {
    lines.push(`${prefix}Effective package script: ` +
      inlineCode(sanitizeString(packageScriptExpansion.effectiveCommand)))
  }
  for (const adjustment of command.localAdjustments || []) {
    lines.push(`${prefix}Local adjustment: ${plainText(adjustment)}`)
  }
  const outputPaths = getCommandOutputPaths(command)
  if (outputPaths.length > 0) {
    lines.push(`${prefix}Command-created outputs removed after execution: ` + outputPaths.map(outputPath => {
      return inlineCode(getRepositoryRelativePath(repositoryRoot, outputPath))
    }).join(', '))
  }
}

/**
 * Returns the durable customer-facing plan path written by --print-plan.
 *
 * @param {string} out validation output directory
 * @returns {string} absolute execution plan path
 */
function getExecutionPlanPath (out) {
  return path.join(out, EXECUTION_PLAN_FILENAME)
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
    const selectedGeneratedScenario = getSelectedGeneratedScenario(requestedScenario)
    if (!requestedScenario || selectedGeneratedScenario) {
      const generatedTestContractError = getGeneratedTestContractError(framework)
      if (generatedTestContractError) {
        throw new Error(
          `Cannot render an approvable plan because generated tests for ${framework.id} ` +
          generatedTestContractError
        )
      }
    }
    const plannedCommands = getPlannedCommands(framework, requestedScenario)
    for (const plannedCommand of plannedCommands) {
      const executable = getUnavailableExecutable(plannedCommand.command)
      if (!executable) continue

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
  for (const [index, candidate] of getLocalTestCandidates(framework).entries()) {
    commands.push({
      label: `local test candidate ${index + 1}`,
      command: getLocalValidationCommand(framework, candidate.command),
    })
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
 * @param {string} input.approvalJsonPath reviewed approval JSON path
 * @param {string} input.repositoryRoot repository root
 * @returns {string[]} validator argv
 */
function getValidatorArgv ({
  approvedPlanSha256,
  approvalJsonPath,
  repositoryRoot,
}) {
  const validatorPath = getPreferredValidatorPath(repositoryRoot)
  return [
    validatorPath === VALIDATOR_PATH ? process.execPath : 'node',
    validatorPath,
    '--run-approved-plan', getRepositoryRelativePath(repositoryRoot, approvalJsonPath),
    '--sha256', approvedPlanSha256,
  ]
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

/**
 * Returns a platform-standard command for hashing the saved approval JSON independently of the validator.
 *
 * @param {string} approvalJsonPath absolute approval JSON path
 * @returns {string} printable checksum command
 */
function formatIndependentHashCommand (approvalJsonPath) {
  const command = process.platform === 'win32'
    ? { argv: ['certutil', '-hashfile', approvalJsonPath, 'SHA256'], cwd: path.dirname(approvalJsonPath) }
    : { argv: ['shasum', '-a', '256', approvalJsonPath], cwd: path.dirname(approvalJsonPath) }
  return sanitizeString(serializeApprovalCommand({ ...command, usesShell: false }))
}

/**
 * Formats the CI configuration location recorded for a framework.
 *
 * @param {object|undefined} ciWiring CI configuration evidence
 * @returns {string} readable location
 */
function formatCiAuditLocation (ciWiring) {
  if (!ciWiring) return 'not identified'
  const parts = [ciWiring.provider, ciWiring.workflow, ciWiring.job, ciWiring.step].filter(Boolean)
  if (ciWiring.configFile) parts.push(ciWiring.configFile)
  return parts.length > 0 ? parts.join(' / ') : 'not identified'
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

/**
 * Renders the command and its command-specific environment in one readable block.
 *
 * @param {object} command manifest command
 * @param {string} repositoryRoot absolute repository root
 * @param {Record<string, string>} environmentOverrides readable validator-provided values
 * @returns {string} readable command
 */
function formatCommandForPlan (command, repositoryRoot, environmentOverrides) {
  const displayCommand = command.usesShell
    ? command
    : {
        ...command,
        argv: command.argv.map((argument, index) => {
          return formatCommandArgument(argument, index, command, repositoryRoot)
        }),
      }
  const environment = { ...command.env, ...environmentOverrides }
  if (command.env?.NODE_OPTIONS && environmentOverrides.NODE_OPTIONS) {
    environment.NODE_OPTIONS = `${environmentOverrides.NODE_OPTIONS} ${command.env.NODE_OPTIONS}`
  }
  const sanitizedEnvironment = sanitizeEnv(environment) || {}
  const prefix = Object.entries(sanitizedEnvironment).map(([name, value]) => {
    return `${name}=${formatEnvironmentValue(value)}`
  }).join(' ')
  const serialized = sanitizeString(serializeApprovalCommand(displayCommand))
  return prefix ? `${prefix} ${serialized}` : serialized
}

/**
 * Shortens repository-contained command paths without changing their meaning from the stated working directory.
 *
 * @param {string} argument command argument
 * @param {number} index argument index
 * @param {object} command manifest command
 * @param {string} repositoryRoot absolute repository root
 * @returns {string} readable argument
 */
function formatCommandArgument (argument, index, command, repositoryRoot) {
  if (index === 0 && path.resolve(argument) === path.resolve(process.execPath)) return 'node'
  if (!path.isAbsolute(argument) || !isPathInside(repositoryRoot, argument)) return argument
  return path.relative(command.cwd, argument) || '.'
}

/**
 * Quotes one environment value only when its characters require it.
 *
 * @param {string} value environment value
 * @returns {string} readable assignment value
 */
function formatEnvironmentValue (value) {
  return serializeApprovalCommand({ argv: [String(value)], usesShell: false })
}

/**
 * Checks whether a path remains within a parent directory.
 *
 * @param {string} parent parent directory
 * @param {string} child candidate child path
 * @returns {boolean} whether child is within parent
 */
function isPathInside (parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Returns the customer-facing Datadog preload required by one framework.
 *
 * @param {object} framework manifest framework entry
 * @returns {string} NODE_OPTIONS value
 */
function getDirectInitialization (framework) {
  return framework.framework === 'vitest'
    ? '--import dd-trace/register.js -r dd-trace/ci/init'
    : '-r dd-trace/ci/init'
}

/**
 * Names a framework using the package or project that contributors recognize.
 *
 * @param {object} framework manifest framework entry
 * @param {string} repositoryRoot absolute repository root
 * @returns {string} customer-facing framework label
 */
function formatFrameworkLabel (framework, repositoryRoot) {
  const frameworkName = FRAMEWORK_NAMES[framework.framework] || framework.framework || 'Test'
  const projectName = framework.project?.name
  if (projectName && projectName !== 'root') return `${frameworkName} tests for ${projectName}`
  const projectRoot = framework.project?.root
  const relativeRoot = projectRoot && getRepositoryRelativePath(repositoryRoot, projectRoot)
  return relativeRoot && relativeRoot !== '.'
    ? `${frameworkName} tests in ${relativeRoot}`
    : `${frameworkName} tests`
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

/**
 * Returns the bounded local commands that approval permits the preflight to try in order.
 *
 * @param {object} framework manifest framework entry
 * @returns {Array<{command: object, maxTestCount: number}>} local test candidates
 */
function getLocalTestCandidates (framework) {
  if (Array.isArray(framework.localTestCandidates) && framework.localTestCandidates.length > 0) {
    return framework.localTestCandidates
  }
  return [{
    command: framework.existingTestCommand,
    maxTestCount: framework.preflight?.maxTestCount ?? 50,
  }]
}

module.exports = {
  formatExecutionPlan,
  formatExecutionPlanArtifacts,
  getExecutionPlanPath,
}
