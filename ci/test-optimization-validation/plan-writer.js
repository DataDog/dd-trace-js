'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

const { VERSION } = require('../../version')
const { getRequiredCapabilities } = require('./approval')
const { writeApprovalArtifacts } = require('./approval-artifacts')
const { serializeApprovalCommand } = require('./command-runner')
const { getUnavailableExecutable } = require('./executable')
const { sanitizeString } = require('./redaction')
const {
  getBasicCommand,
  getGeneratedCommand,
} = require('./runner-command')
const { writeFileSafely } = require('./safe-files')

const VALIDATOR_PATH = path.resolve(__dirname, '..', 'validate-test-optimization.js')
const EXECUTION_PLAN_FILENAME = 'execution-plan.md'
const SCENARIO_TO_GENERATED_ID = {
  atr: 'atr-fail-once',
  efd: 'basic-pass',
  'test-management': 'test-management-target',
}

/**
 * Produces the deterministic execution plan shown before live validation.
 *
 * @param {object} input plan inputs
 * @returns {string} Markdown execution plan
 */
function formatExecutionPlan (input) {
  return formatExecutionPlanArtifacts(input).plan
}

/**
 * Writes approval artifacts and the customer-visible plan without running project code.
 *
 * @param {object} input plan inputs
 * @param {object} input.manifest normalized manifest
 * @param {string} input.out output directory
 * @param {string[]} [input.selectedFrameworkIds] selected framework ids
 * @param {string|null} [input.requestedScenario] selected scenario
 * @param {boolean} [input.keepTempFiles] retain temporary files
 * @param {object} [input.packageCheck] installed package-load result
 * @param {Map<string, object>} [input.ciPreflightResults] static CI results by framework
 * @param {Array<{path: string, sha256: string}>} [input.expectedProjectFiles] preflight project snapshot
 * @param {boolean} [input.verbose] print progress
 * @returns {{plan: string}} written plan
 */
function formatExecutionPlanArtifacts ({
  manifest,
  out,
  selectedFrameworkIds = [],
  requestedScenario = null,
  keepTempFiles = false,
  packageCheck,
  ciPreflightResults = new Map(),
  expectedProjectFiles,
  verbose = false,
}) {
  const offlineFixtureNonce = crypto.randomBytes(16).toString('hex')
  const approvalArtifacts = writeApprovalArtifacts({
    manifest,
    out,
    selectedFrameworkIds,
    requestedScenario,
    offlineFixtureNonce,
    keepTempFiles,
    verbose,
    expectedProjectFiles,
  })
  const validatorArgv = [
    process.execPath,
    VALIDATOR_PATH,
    '--run-approved-plan',
    approvalArtifacts.approvalJsonPath,
    '--sha256',
    approvalArtifacts.digest,
  ]
  const plan = formatApprovalPlan({
    approvalArtifacts,
    ciPreflightResults,
    manifest,
    out,
    keepTempFiles,
    packageCheck,
    requestedScenario,
    validatorArgv,
  })
  writeFileSafely(out, getExecutionPlanPath(out), `${plan}\n`, 'validation execution plan')
  return { plan }
}

/**
 * Formats the complete bounded approval plan.
 *
 * @param {object} input formatting inputs
 * @param {object} input.approvalArtifacts approval artifact paths and digest
 * @param {Map<string, object>} input.ciPreflightResults static CI results by framework
 * @param {object} input.manifest normalized manifest
 * @param {string} input.out output directory
 * @param {boolean} input.keepTempFiles retain temporary files
 * @param {object|undefined} input.packageCheck installed package-load result
 * @param {string|null} input.requestedScenario selected scenario
 * @param {string[]} input.validatorArgv exact validator command
 * @returns {string} Markdown plan
 */
function formatApprovalPlan ({
  approvalArtifacts,
  ciPreflightResults,
  manifest,
  out,
  keepTempFiles,
  packageCheck,
  requestedScenario,
  validatorArgv,
}) {
  const root = manifest.repository.root
  const runnableFrameworks = manifest.frameworks.filter(framework => framework.status === 'runnable')
  const requiredCapabilities = getRequiredCapabilities({
    manifest,
    requestedScenario,
  })
  const buildPrerequisites = runnableFrameworks.filter(framework => {
    return framework.buildArtifactRequired === true ||
      (framework.validation?.fallbackTests || []).some(fallback => fallback.buildArtifactRequired === true)
  }).length
  const lines = [
    '# Test Optimization Validation Plan',
    '',
    `Repository: ${inline(root)}`,
    `Validator: ${inline(`dd-trace ${VERSION}`)}`,
    `Results: ${inline(relative(root, out))}`,
    ...(packageCheck?.ok
      ? [`Installed package check: ${plain(packageCheck.diagnosis)}`]
      : []),
    '',
    '## Approval Summary',
    '',
    requestedScenario === 'ci-wiring'
      ? 'Local execution: none; this plan performs static CI analysis only.'
      : `Local execution: ${runnableFrameworks.length} framework target${
          runnableFrameworks.length === 1 ? '' : 's'
        } eligible; ${manifest.frameworks.length - runnableFrameworks.length} setup or static-only.`,
    `Required host capabilities: ${
      requiredCapabilities.length > 0 ? requiredCapabilities.map(formatCapability).join(', ') : 'none declared'
    }.`,
    `Build prerequisites: ${
      buildPrerequisites > 0
        ? `${buildPrerequisites} eligible framework target${
            buildPrerequisites === 1 ? '' : 's'
          } may require the project's normal build`
        : 'none detected statically'
    }.`,
    `Mutable paths: ${inline(relative(root, out))} and the temporary files disclosed below; temporary files ${
      keepTempFiles ? 'will be retained by request' : 'will be removed after validation'
    }.`,
    'CI replay: none. CI configuration is inspected statically and CI commands are never executed.',
    'Approval: one checksum-bound validator command, shown once at the end of this plan.',
    '',
    'The validator will run only the displayed `node <repository-contained-runner> <one-test-file>` commands. The ' +
      'runner may be an exact repository-owned Node test wrapper. The validator itself will not directly invoke ' +
      'package managers, shells, setup commands, or CI commands; approved repository code may start subprocesses.',
    '',
    '## Checks',
    '',
  ]

  for (const framework of manifest.frameworks) {
    lines.push(`### ${plain(getFrameworkLabel(framework, root))}`, '')
    if (framework.status !== 'runnable') {
      lines.push(
        `Status: ${plain(formatStatus(framework.status))}.`,
        ...(framework.blockerCategory
          ? [`Blocker: ${plain(framework.blockerCategory.replaceAll('_', ' '))}.`]
          : [])
      )
      if (framework.notes) {
        for (const note of framework.notes) lines.push(`- ${plain(note)}`)
      }
      lines.push('')
      continue
    }

    if (requestedScenario === 'ci-wiring') {
      lines.push('Status: static CI audit only; no project test command is selected.', '')
    } else {
      const basic = getBasicCommand(framework)
      const fallbackTests = framework.validation.fallbackTests || []
      const unavailable = getUnavailableExecutable(basic)
      const status = unavailable
        ? `local validation will be incomplete because ${inline(unavailable)} is unavailable`
        : 'eligible for approved clean preflight; runtime prerequisites are unverified'
      lines.push(
        `Status: ${status}.`,
        `Representative test: ${inline(relative(root, framework.validation.testFile))}${formatCandidateRequirements({
          buildArtifactRequired: framework.buildArtifactRequired,
          localSocketRequired: framework.localSocketRequired,
        })}`,
        ...(fallbackTests.length > 0
          ? [
              'Fallback tests, tried in order only if the representative does not pass cleanly:',
              ...fallbackTests.map(fallback => {
                return `- ${inline(relative(root, fallback.testFile))}${formatCandidateRequirements(fallback)}`
              }),
            ]
          : []),
        `Working directory: ${inline(relative(root, basic.cwd))}`,
        `Timeout: ${basic.timeoutMs} ms`,
        ...(Object.keys(basic.env || {}).length > 0
          ? [`Runner environment: ${inline(JSON.stringify(basic.env))}`]
          : []),
        ...formatOmittedRunnerOptions(framework.validation.omittedRunnerOptions),
        '',
        ...(framework.browserRequired
          ? [
              'Browser permission: this approved validation command launches the project browser through its ' +
                'selected test runner. If the agent platform blocks browser processes, request its narrow permission ' +
                'for the exact checksum-bound validator command below; do not change or broaden the command. ' +
                'Complete ' +
                'the project\'s normal browser installation, application startup, and build first when the selected ' +
                'test depends on them.',
              '',
            ]
          : []),
        ...(framework.localSocketRequired
          ? [
              `Localhost prerequisite: ${
                framework.allCandidatesRequireLocalSocket
                  ? 'every approved candidate appears'
                  : 'the selected test appears'
              } to open or contact a local listener. A restricted execution environment may require narrow ` +
                'permission for the exact validator command.',
              '',
            ]
          : []),
        ...(framework.buildArtifactRequired
          ? [
              'Build prerequisite: the selected test appears to load a build or dist artifact. Complete the ' +
                'project\'s normal build before validation if that artifact is not already present.',
              '',
            ]
          : []),
        'Basic Reporting command:',
        '',
        codeBlock(serializeApprovalCommand(basic)),
        '',
        'The command runs once without Datadog and once with validator-owned offline initialization. A debug rerun ' +
          'and one clean confirmation may run only when needed to diagnose a mismatch.',
        ...(fallbackTests.length > 0
          ? [
              'If this test does not pass cleanly, the validator may try the disclosed fallback tests in order. It ' +
                'will initialize only the first candidate that passes, and will stop early when the failure is a ' +
                'confirmed shared runtime prerequisite rather than a candidate-specific test failure.',
            ]
          : []),
        ''
      )

      for (const [index, fallback] of fallbackTests.entries()) {
        const fallbackCommand = getBasicCommand(framework, fallback.testFile)
        lines.push(
          `Fallback Basic Reporting command ${index + 1}:`,
          '',
          codeBlock(serializeApprovalCommand(fallbackCommand)),
          ''
        )
      }

      const selectedScenarios = getSelectedGeneratedScenarios(framework, requestedScenario)
      if (selectedScenarios.length > 0) {
        lines.push(
          `Advanced checks use working directory: ${inline(relative(
            root,
            getGeneratedCommand(framework, selectedScenarios[0]).cwd
          ))}`,
          ''
        )
      }
      for (const scenario of selectedScenarios) {
        const command = getGeneratedCommand(framework, scenario)
        const source = getGeneratedSource(framework, scenario)
        lines.push(
          `Advanced check ${inline(scenario.id)}:`,
          '',
          codeBlock(serializeApprovalCommand(command)),
          '',
          `Temporary file: ${inline(relative(root, scenario.testIdentities[0].file))}`,
          '',
          codeBlock(source),
          ''
        )
      }
      for (const file of getSelectedSupportFiles(framework, selectedScenarios)) {
        lines.push(
          'Advanced check support file:',
          '',
          `Temporary file: ${inline(relative(root, file.path))}`,
          '',
          codeBlock(file.contentLines.join('\n')),
          ''
        )
      }
      if (selectedScenarios.length > 0) {
        lines.push(
          'Advanced execution policy: each generated scenario has one clean verification, one instrumented ' +
            'identity-discovery run, and one feature-validation run. One debug rerun may run only after a failure.',
          ''
        )
      }
    }

    const ci = framework.ciWiring
    const ciPreflight = ciPreflightResults.get(framework.id)
    lines.push(
      'CI audit: static only; no CI or package command will execute.',
      `CI review: ${plain(ci?.reviewComplete ? 'complete' : 'incomplete')}.`,
      ...(ciPreflight
        ? [`CI pre-approval result: ${plain(formatCiPreflightResult(ciPreflight))}`]
        : []),
      ...(ci?.configFile ? [`CI file: ${inline(relative(root, ci.configFile))}`] : []),
      ''
    )
  }

  lines.push(
    '## Writes and Cleanup',
    '',
    `- Validation artifacts: ${inline(relative(root, out))}`,
    '- Single-flight lock: the approved validator creates one fixed lock in the result directory while it runs. An ' +
      'existing lock blocks execution and is never reclaimed automatically.',
    ...(requestedScenario === 'ci-wiring'
      ? []
      : [
          '- Temporary generated tests shown above are created only for advanced checks and removed afterward.',
          '- Declared framework output is refused if it already exists and removed after each command.',
          '- Private offline fixtures are created outside the repository and removed after each check.',
        ]),
    '',
    '## Security Boundary',
    '',
    '- The validation transport opens no listener, contacts no Datadog endpoint, and uses no real Datadog ' +
      'credentials.',
    ...(requestedScenario === 'ci-wiring'
      ? ['- This CI-only plan executes no project test command.']
      : [
          '- Project runners and tests are arbitrary repository code. Approval means trusting the listed files, ' +
            'their imported code, and any subprocesses they start.',
        ]),
    '- The approval digest binds the manifest, validator package, Node.js binary, runner, selected test, config ' +
      'files, CI evidence file, generated source, options, and output directory.',
    '- Missing dependencies, unsupported launchers, arbitrary wrapper chains, dynamic CI, and ambiguous evidence ' +
      'produce an incomplete result.',
    '',
    'Approval details:',
    '',
    `- JSON: ${inline(relative(root, approvalArtifacts.approvalJsonPath))}`,
    `- Checksums: ${inline(relative(root, approvalArtifacts.coveredFilesPath))}`,
    `- SHA-256: ${inline(approvalArtifacts.digest)}`,
    '',
    'Run exactly this command after approval:',
    '',
    codeBlock(serializeApprovalCommand({
      argv: validatorArgv,
      cwd: root,
      usesShell: false,
    })),
    '',
    `Working directory: ${inline(root)}`,
    '',
    'If an agent platform hard-denies the exact command, do not alter it or broaden permissions. Run this same ' +
      'command in a normal project terminal and ask the agent to interpret the generated report.'
  )
  return lines.join('\n')
}

function formatCapability (capability) {
  const labels = {
    browser_process: 'browser process',
    localhost_socket: 'localhost socket',
  }
  return labels[capability] || capability
}

function formatCandidateRequirements (candidate) {
  const requirements = [
    ...(candidate.localSocketRequired ? ['localhost'] : []),
    ...(candidate.buildArtifactRequired ? ['build output'] : []),
  ]
  return requirements.length > 0 ? ` (${requirements.join(', ')} required)` : ''
}

function formatCiPreflightResult (result) {
  const status = result.status === 'fail'
    ? 'confirmed actionable problem'
    : result.status === 'pass'
      ? 'no confirmed problem'
      : 'incomplete'
  return `${status}: ${result.diagnosis}`
}

function formatOmittedRunnerOptions (options = []) {
  const descriptions = {
    '-R': 'Omitted runner option: `-R` selects only Mocha report presentation; the validator uses its bounded ' +
      'reporter.',
    '--reporter': 'Omitted runner option: `--reporter` selects only Mocha report presentation; the validator uses ' +
      'its bounded reporter.',
    '--run': 'Normalized runner option: `--run` is omitted because the validator supplies Vitest `run` itself.',
    '--typecheck': 'Omitted runner option: `--typecheck` is excluded because validation executes runtime tests only.',
  }
  return options.map(option => descriptions[option])
}

/**
 * Selects generated scenarios covered by a plan.
 *
 * @param {object} framework framework entry
 * @param {string|null} requestedScenario selected scenario
 * @returns {object[]} selected generated scenarios
 */
function getSelectedGeneratedScenarios (framework, requestedScenario) {
  if (requestedScenario === 'basic-reporting' || requestedScenario === 'ci-wiring') return []
  const scenarios = framework.generatedTestStrategy?.scenarios || []
  if (!requestedScenario) return scenarios
  const id = SCENARIO_TO_GENERATED_ID[requestedScenario]
  return id ? scenarios.filter(scenario => scenario.id === id) : []
}

/**
 * Returns adapter support files required by selected generated scenarios.
 *
 * @param {object} framework framework entry
 * @param {object[]} selectedScenarios selected generated scenarios
 * @returns {object[]} support files
 */
function getSelectedSupportFiles (framework, selectedScenarios) {
  if (selectedScenarios.length === 0) return []
  const scenarioPaths = new Set((framework.generatedTestStrategy?.scenarios || []).map(scenario => {
    return path.resolve(scenario.testIdentities[0].file)
  }))
  return (framework.generatedTestStrategy?.files || []).filter(file => {
    return !scenarioPaths.has(path.resolve(file.path))
  })
}

/**
 * Returns canonical generated source for a scenario.
 *
 * @param {object} framework framework entry
 * @param {object} scenario generated scenario
 * @returns {string} source
 */
function getGeneratedSource (framework, scenario) {
  const filename = path.resolve(scenario.testIdentities[0].file)
  const file = framework.generatedTestStrategy.files.find(candidate => path.resolve(candidate.path) === filename)
  return file?.contentLines?.join('\n') || '<generated source unavailable>'
}

/**
 * Returns the execution plan path.
 *
 * @param {string} out output directory
 * @returns {string} plan path
 */
function getExecutionPlanPath (out) {
  return path.join(out, EXECUTION_PLAN_FILENAME)
}

/**
 * Formats a framework label.
 *
 * @param {object} framework framework entry
 * @param {string} root repository root
 * @returns {string} label
 */
function getFrameworkLabel (framework, root) {
  const project = framework.project?.name || relative(root, framework.project?.root || root)
  return `${framework.framework} in ${project || 'root project'}`
}

/**
 * Formats a framework status.
 *
 * @param {string} status status id
 * @returns {string} status text
 */
function formatStatus (status) {
  return {
    detected_not_runnable: 'detected but no direct target was selected',
    requires_manual_setup: 'requires normal project setup',
    unsupported_by_validator: 'unsupported by this validator',
  }[status] || status
}

/**
 * Formats a repository-relative path.
 *
 * @param {string} root repository root
 * @param {string} filename absolute path
 * @returns {string} relative display path
 */
function relative (root, filename) {
  const value = path.relative(root, filename)
  return value || '.'
}

/**
 * Formats a safe Markdown code block.
 *
 * @param {string} value text
 * @returns {string} code block
 */
function codeBlock (value) {
  return `\`\`\`text\n${plainMultiline(value).replaceAll('```', String.raw`\u0060\u0060\u0060`)}\n\`\`\``
}

/**
 * Formats safe inline code.
 *
 * @param {string} value text
 * @returns {string} inline code
 */
function inline (value) {
  return `\`${plain(value).replaceAll('`', String.raw`\u0060`)}\``
}

/**
 * Sanitizes one line of plan text.
 *
 * @param {unknown} value text
 * @returns {string} safe text
 */
function plain (value) {
  return sanitizeString(String(value ?? '')).replaceAll(/\p{Cc}+/gu, ' ').trim()
}

/**
 * Sanitizes multiline plan text.
 *
 * @param {unknown} value text
 * @returns {string} safe text
 */
function plainMultiline (value) {
  return sanitizeString(String(value ?? '')).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
}

module.exports = {
  formatExecutionPlan,
  formatExecutionPlanArtifacts,
  getExecutionPlanPath,
}
