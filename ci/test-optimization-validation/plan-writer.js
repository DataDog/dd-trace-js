'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { getArtifactId } = require('./artifact-id')
const { writeApprovalArtifacts } = require('./approval-artifacts')
const { getCommandOutputPaths } = require('./command-output-policy')
const { getCommandSuitabilityError, getPackageScriptExpansion } = require('./command-suitability')
const { serializeApprovalCommand } = require('./command-runner')
const { getGeneratedTestContractError } = require('./generated-test-contract')
const {
  getApprovedExecutable,
  getUnavailableExecutable,
} = require('./executable')
const { getCiWiringCommand, getDatadogCleanCommand, getLocalValidationCommand } = require('./local-command')
const {
  getOfflineFixturePaths,
  getOfflineScenarioNames,
} = require('./offline-fixtures')
const { sanitizeEnv, sanitizeString } = require('./redaction')
const { getBasicReportingCommand } = require('./scenarios/basic-reporting')
const { writeFileSafely } = require('./safe-files')

const VALIDATOR_PATH = path.resolve(__dirname, '..', 'validate-test-optimization.js')
const APPROVAL_SUMMARY_FILENAME = 'approval-summary.md'
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
  const coveredFileVerification = process.platform === 'win32'
    ? []
    : [
        'Optional: verify every listed dd-trace package and command executable file against its recorded SHA-256:',
        '',
        codeBlock(sanitizeString(serializeApprovalCommand({
          argv: ['shasum', '-a', '256', '--quiet', '-c', approvalArtifacts.coveredFilesPath],
          cwd: manifest.repository.root,
          usesShell: false,
        }))),
        '',
      ]

  const lines = [
    '# Test Optimization Validation Execution Plan',
    '',
    `Repository: ${inlineCode(manifest.repository.root)}`,
    `Manifest: ${inlineCode(manifest.__path)}`,
    `Results: ${inlineCode(out)}`,
    '',
    '## What Will Be Validated',
    '',
    'The validator runs selected project tests without Datadog to confirm they work normally, then runs the same ' +
      'tests with Datadog initialized to check that test data is reported. When a CI test command can be replayed, ' +
      'it also checks whether the configuration from that CI job reaches the test process. Temporary tests are ' +
      'used for the advanced feature checks.',
    '',
  ]

  for (const framework of manifest.frameworks) {
    const label = formatFrameworkLabel(framework, manifest.repository.root)
    lines.push(`- **${plainText(label)}**: ${formatFrameworkStatus(framework.status)}`)
    if (framework.status !== 'runnable') {
      for (const note of framework.notes || []) lines.push(`  - ${plainText(note)}`)
    }
  }

  lines.push(
    '',
    '## Test Commands',
    '',
    'Environment values that affect a project command are shown inline after secret-like values are replaced with ' +
      '`<redacted>`. Repository files in a command are shown relative to its stated working directory. Datadog ' +
      'preloads are shown as package names; the validator resolves them from the installed `dd-trace` package.',
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
  appendCommandIntegrity(lines, manifest, requestedScenario)

  lines.push(
    '',
    '## Start the Validation',
    '',
    '`validate-test-optimization.js` is the local validator included with the installed `dd-trace` package. ' +
      'After approval, it creates bounded filesystem cache fixtures, performs every check listed above, writes ' +
      'events to local artifacts, and removes temporary fixtures and tests afterward. It does not open a listener ' +
      'or use a network endpoint.',
    '',
    'The validator wrote the exact approval material to these local files without running project code:',
    '',
    `- Approval details: ${inlineCode(getRepositoryRelativePath(
      manifest.repository.root,
      approvalArtifacts.approvalJsonPath
    ))}`,
    `- Covered file checksums: ${inlineCode(getRepositoryRelativePath(
      manifest.repository.root,
      approvalArtifacts.coveredFilesPath
    ))}`,
    '',
    'The JSON contains the sanitized command shapes, generated test source, selected options, file fingerprints, ' +
      'and executable identities covered by approval. It is an internal diagnostic artifact and may contain ' +
      'repository paths or CI metadata.',
    '',
    'Optional: independently hash the approval JSON with a standard system tool:',
    '',
    codeBlock(formatIndependentHashCommand(approvalArtifacts.approvalJsonPath)),
    '',
    `Expected SHA-256: ${inlineCode(approvalDigest)}`,
    '',
    ...coveredFileVerification,
    'Immediately before project code runs, the validator verifies the saved approval JSON against the SHA-256 in ' +
      'the command below, then reconstructs the approval material from the current manifest, validator package, ' +
      'generated tests, and executables. Both checks must match. This detects changes after review; it does not ' +
      'verify where the installed `dd-trace` package came from.',
    '',
    'Run the approved validation command:',
    '',
    codeBlock(sanitizeString(serializeApprovalCommand({
      argv: validatorArgv,
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
      'Review the exact commands before approving them for this environment.'
  )

  const plan = lines.join('\n')
  const approvalSummary = formatApprovalSummary({
    approvalArtifacts,
    approvalDigest,
    manifest,
    out,
    requestedScenario,
    validatorArgv,
  })
  writeFileSafely(out, getExecutionPlanPath(out), `${plan}\n`, 'validation execution plan')
  writeFileSafely(out, getApprovalSummaryPath(out), `${approvalSummary}\n`, 'validation approval summary')
  return plan
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
 * @returns {string} Markdown approval summary
 */
function formatApprovalSummary ({
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
    '# Test Optimization Validation Approval Summary',
    '',
    `Repository: ${inlineCode(repositoryRoot)}`,
    `Detailed execution plan: ${inlineCode(getRepositoryRelativePath(repositoryRoot, getExecutionPlanPath(out)))}`,
    '',
    'This summary shows every project command and the exact temporary test source. The detailed plan contains ' +
      'the offline-fixture, artifact, executable-integrity, and checksum details covered by the same approval hash.',
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
 * Appends one runnable framework to the bounded approval summary.
 *
 * @param {string[]} lines rendered summary lines
 * @param {object} framework manifest framework entry
 * @param {string|null|undefined} requestedScenario selected scenario
 * @param {string} repositoryRoot repository root
 * @returns {void}
 */
function appendApprovalSummaryFramework (lines, framework, requestedScenario, repositoryRoot) {
  const basicCommand = getBasicReportingCommand(framework)
  const directInitialization = getDirectInitialization(framework)
  const maxTestCount = framework.preflight?.maxTestCount ?? 50
  lines.push(`### ${plainText(formatFrameworkLabel(framework, repositoryRoot))}`, '')

  for (const setupCommand of framework.setup?.commands || []) {
    appendApprovalSummaryCommand(lines, {
      command: setupCommand,
      deferOutputCleanup: true,
      label: `Project setup: ${setupCommand.id || setupCommand.description || 'setup'}`,
      repositoryRoot,
      runs: '1',
    })
  }
  appendApprovalSummaryCommand(lines, {
    command: getDatadogCleanCommand(basicCommand),
    label: 'Test execution without Datadog',
    note: 'Inherited NODE_OPTIONS and DD_* variables are removed. The command must report between 1 and ' +
      `${maxTestCount} tests.`,
    repositoryRoot,
    runs: '1, plus 1 clean confirmation only if the Datadog run exits differently',
  })
  appendApprovalSummaryCommand(lines, {
    command: basicCommand,
    environmentOverrides: { NODE_OPTIONS: directInitialization },
    label: 'Test execution with Datadog',
    note: 'A second Datadog debug run occurs only when diagnosis needs debug output.',
    repositoryRoot,
    runs: '1, plus at most 1 Datadog debug run when needed',
  })

  const ciWiringSelected = !requestedScenario || requestedScenario === 'ci-wiring'
  if (ciWiringSelected && framework.ciWiringCommand) {
    appendApprovalSummaryCommand(lines, {
      command: getCiWiringCommand(framework),
      label: 'CI test execution',
      note: 'A short preload probe may run when initialization reachability needs confirmation.',
      repositoryRoot,
      runs: '1, plus at most 1 preload probe',
    })
  } else if (ciWiringSelected) {
    lines.push(
      '**CI test execution:** not run.',
      '',
      `Reason: ${plainText(
        framework.ciWiring?.reason || framework.ciWiring?.diagnosis || 'No replayable CI test command was selected.'
      )}`,
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
    for (const scenario of scenarios) {
      appendApprovalSummaryCommand(lines, {
        command: getLocalValidationCommand(framework, scenario.runCommand),
        environmentOverrides: { NODE_OPTIONS: directInitialization },
        label: GENERATED_SCENARIO_DETAILS[scenario.id]?.heading || `Advanced check: ${scenario.id}`,
        note: 'Runs verification, identity discovery, and feature validation; a debug run occurs only on failure.',
        repositoryRoot,
        runs: '3, or 4 when the debug run is needed',
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
 * Appends one exact command and its execution-relevant context to the approval summary.
 *
 * @param {string[]} lines rendered summary lines
 * @param {object} input command summary
 * @param {object} input.command structured command
 * @param {boolean} [input.deferOutputCleanup] whether outputs remain available through validation
 * @param {Record<string, string>} [input.environmentOverrides] validator-provided readable environment
 * @param {string} input.label customer-facing command label
 * @param {string} [input.note] additional execution behavior
 * @param {string} input.repositoryRoot repository root
 * @param {string} input.runs maximum execution count
 * @returns {void}
 */
function appendApprovalSummaryCommand (lines, {
  command,
  deferOutputCleanup = false,
  environmentOverrides = {},
  label,
  note,
  repositoryRoot,
  runs,
}) {
  lines.push(
    `**${plainText(label)}**`,
    '',
    codeBlock(formatCommandForPlan(command, repositoryRoot, environmentOverrides)),
    '',
    `- Working directory: ${inlineCode(getRepositoryRelativePath(repositoryRoot, command.cwd))}`,
    `- Runs: ${plainText(runs)}`,
    `- Timeout: ${command.timeoutMs || 300_000} ms`
  )
  if (command.usesShell) lines.push(`- Shell executable: ${inlineCode(command.shell || 'platform default shell')}`)
  const packageScriptExpansion = getPackageScriptExpansion(command, repositoryRoot)
  if (packageScriptExpansion) {
    lines.push(`- Effective package script: ${inlineCode(sanitizeString(packageScriptExpansion.effectiveCommand))}`)
  }
  const outputPaths = getCommandOutputPaths(command)
  if (outputPaths.length > 0) {
    const cleanupTiming = deferOutputCleanup
      ? 'remain available to later checks and are removed after validation'
      : 'are removed after this command'
    lines.push(`- Command-created outputs ${cleanupTiming}: ` + outputPaths.map(outputPath => {
      return inlineCode(getRepositoryRelativePath(repositoryRoot, outputPath))
    }).join(', '))
  }
  for (const adjustment of command.localAdjustments || []) {
    lines.push(`- Local adjustment: ${plainText(adjustment)}`)
  }
  if (note) lines.push(`- ${plainText(note)}`)
  lines.push('')
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
 * Returns the bounded approval summary path written by --print-plan.
 *
 * @param {string} out validation output directory
 * @returns {string} absolute approval summary path
 */
function getApprovalSummaryPath (out) {
  return path.join(out, APPROVAL_SUMMARY_FILENAME)
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
    const generatedTestContractError = getGeneratedTestContractError(framework)
    if (generatedTestContractError) {
      throw new Error(
        `Cannot render an approvable plan because generated tests for ${framework.id} ` +
        generatedTestContractError
      )
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

function appendFrameworkExecutions (
  lines,
  framework,
  requestedScenario,
  repositoryRoot,
  out,
  offlineFixtureNonce
) {
  const basicCommand = getBasicReportingCommand(framework)
  const frameworkLabel = formatFrameworkLabel(framework, repositoryRoot)
  const directInitialization = getDirectInitialization(framework)
  const maxTestCount = framework.preflight?.maxTestCount ?? 50
  lines.push(`### ${plainText(frameworkLabel)}`, '')

  for (const setupCommand of framework.setup?.commands || []) {
    appendExecutionSection(lines, {
      heading: `Project Setup: ${setupCommand.id || setupCommand.description || 'Project Setup'}`,
      description: 'Prepares the project for the selected test command.',
      command: setupCommand,
      executions: '1',
      environment: 'Use the command-specific variables shown inline. No Datadog variables are added.',
      repositoryRoot,
    })
  }
  const cleanCommand = getDatadogCleanCommand(basicCommand)
  appendExecutionSection(lines, {
    heading: 'Test Execution Without Datadog',
    description: 'Runs the selected test command without Datadog to confirm that the tests can run normally and ' +
      `that it reports between 1 and ${maxTestCount} tests.`,
    command: cleanCommand,
    executions: '1, plus 1 clean confirmation only if the Datadog run exits differently',
    environment: `Remove inherited NODE_OPTIONS and DD_*; ${formatCommandVariableContext(cleanCommand)}`,
    repositoryRoot,
  })
  appendExecutionSection(lines, {
    heading: 'Test Execution With Datadog',
    description: 'Runs the same test command with Datadog initialized and checks that test data is reported.',
    command: basicCommand,
    executions: '1, plus at most 1 debug rerun when needed',
    environment: 'Datadog initialization is shown inline. The validator also supplies private offline response ' +
      'paths and noise-suppression settings only while this check runs.',
    environmentOverrides: { NODE_OPTIONS: directInitialization },
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
      environment: formatCiEnvironmentSummary(ciCommand),
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
        description: `${details.description} The framework runner is invoked directly so only this temporary test ` +
          'runs instead of the broader project test suite.',
        command,
        executions: '3: verify the test alone, discover its identity, then validate the feature; ' +
          'plus 1 debug rerun only on failure',
        environment: 'Datadog initialization is shown inline. The validator supplies the feature setting from a ' +
          'private offline response only while this check runs.',
        environmentOverrides: { NODE_OPTIONS: directInitialization },
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
    `Private response directory: ${inlineCode(frameworkFixtureRoot)}`,
    '',
    'Each check gets an isolated subdirectory containing bounded Test Optimization settings and test lists that ' +
      '`dd-trace` normally receives from Datadog. Isolation prevents a baseline, feature check, or conditional ' +
      'debug rerun from overwriting another check. A debug rerun uses the same response data and adds ' +
      '`DD_TRACE_DEBUG=1`.',
    '',
    `Captured event artifacts: ${inlineCode(getRepositoryRelativePath(
      repositoryRoot,
      path.join(out, 'runs', getArtifactId(framework.id))
    ))}`,
    '',
    'Each execution writes bounded temporary JSON payload files under `.offline-payloads/payloads/tests/`, using ' +
      'the Test Optimization payload-file layout. The temporary payload directory is removed after parsing, and a ' +
      'sanitized `events.ndjson` file remains for diagnosis. Exact fixture recipes and paths are included in the ' +
      'approval digest even though this plan summarizes their shared layout.',
    ''
  )
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
 * @param {Record<string, string>} [input.environmentOverrides] readable validator-provided environment values
 * @param {string} input.repositoryRoot repository root
 * @returns {void}
 */
function appendExecutionSection (lines, {
  heading,
  description,
  command,
  executions,
  environment,
  environmentOverrides = {},
  repositoryRoot,
}) {
  lines.push(
    `#### ${plainText(heading)}`,
    '',
    plainText(description),
    '',
    'Command:',
    '',
    codeBlock(formatCommandForPlan(command, repositoryRoot, environmentOverrides)),
    '',
    `- Working directory: ${inlineCode(getRepositoryRelativePath(repositoryRoot, command.cwd))}`,
    `- Runs: ${plainText(executions)}`,
    `- Environment changes: ${plainText(environment)}`,
    `- Timeout: ${command.timeoutMs || 300_000} ms`
  )
  if (command.usesShell) lines.push(`- Shell executable: ${inlineCode(command.shell || 'platform default shell')}`)
  const outputPaths = getCommandOutputPaths(command)
  if (outputPaths.length > 0) {
    lines.push('- Command-created outputs: ' + outputPaths.map(outputPath => {
      return inlineCode(getRepositoryRelativePath(repositoryRoot, outputPath))
    }).join(', ') + ' (must not exist before validation; newly created paths are removed)')
  }
  for (const adjustment of command.localAdjustments || []) {
    lines.push(`- Local adjustment: ${plainText(adjustment)}`)
  }
  lines.push('')
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
 * Describes the variables captured from the selected CI job.
 *
 * @param {object} command CI test command
 * @returns {string} customer-facing environment summary
 */
function formatCiEnvironmentSummary (command) {
  const names = Object.keys(command.env || {})
  const datadogNames = names.filter(name => name.startsWith('DD_') || name === 'NODE_OPTIONS')
  if (datadogNames.length === 0) {
    return 'The selected CI job supplies no Datadog variables. Other recorded CI variables, if any, are shown ' +
      'inline.'
  }
  return 'Variables recorded from the selected CI job are shown inline. Secret-like values are redacted.'
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
 * Lists each executable identity once instead of repeating it under every command.
 *
 * @param {string[]} lines rendered plan lines
 * @param {object} manifest normalized validation manifest
 * @param {string|null|undefined} requestedScenario selected scenario
 * @returns {void}
 */
function appendCommandIntegrity (lines, manifest, requestedScenario) {
  const executables = new Map()
  for (const framework of manifest.frameworks.filter(entry => entry.status === 'runnable')) {
    for (const { command } of getPlannedCommands(framework, requestedScenario)) {
      const executable = getApprovedExecutable(command)
      if (executable) {
        for (const identity of [executable, ...(executable.delegated || [])]) {
          const key = `${identity.invocationPath}:${identity.path}:${identity.sha256}`
          const entry = executables.get(key) || { executable: identity, labels: new Set() }
          entry.labels.add(getExecutableLabel(command, identity.invocationPath))
          executables.set(key, entry)
        }
      }
    }
  }
  if (executables.size === 0) return

  lines.push(
    '## Executables Used',
    '',
    'These programs start the commands shown above. The validator records their fingerprints internally and ' +
      'stops if an executable or PATH selection changes after approval. This confirms that the approved programs ' +
      'did not change; it does not establish that project scripts, packages, or subprocesses are safe.',
    ''
  )
  for (const { executable, labels } of executables.values()) {
    const canonicalTarget = executable.invocationPath === executable.path
      ? ''
      : ` (verified target: ${inlineCode(executable.path)})`
    lines.push(`- ${[...labels].sort().join(', ')}: ${inlineCode(executable.invocationPath)}${canonicalTarget}`)
  }
  lines.push('')
}

function getExecutableLabel (command, invocationPath) {
  const name = path.basename(invocationPath).replace(/\.(?:bat|cmd|exe)$/i, '').toLowerCase()
  if (command.usesShell) {
    return {
      bash: 'Bash shell',
      sh: 'POSIX shell',
      zsh: 'Zsh shell',
    }[name] || `${name} shell`
  }
  return {
    bash: 'Bash shell',
    node: 'Node.js',
    npm: 'npm',
    npx: 'npx',
    pnpm: 'pnpm',
    sh: 'POSIX shell',
    yarn: 'Yarn',
    zsh: 'Zsh shell',
  }[name] || name
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

module.exports = { formatExecutionPlan, getApprovalSummaryPath, getExecutionPlanPath }
