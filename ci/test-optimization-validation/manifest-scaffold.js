'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')

const { runDiagnosis } = require('../diagnose')
const cucumberAdapter = require('./framework-adapters/cucumber')
const cypressAdapter = require('./framework-adapters/cypress')
const playwrightAdapter = require('./framework-adapters/playwright')
const {
  GENERATED_SCENARIOS,
  getGeneratedRetryStatePath,
  getGeneratedTestContent,
} = require('./generated-test-contract')
const { getCommandSuitabilityError } = require('./command-suitability')
const { validateManifest } = require('./manifest-schema')
const { maskJavaScriptComments, maskJavaScriptNonCode } = require('./source-text')

const SUPPORTED_SCAFFOLD_FRAMEWORKS = new Set(['cucumber', 'cypress', 'jest', 'mocha', 'playwright', 'vitest'])
const MAX_LOCAL_TEST_CANDIDATES = 3
const MAX_DISCOVERY_ENTRIES = 5000
const MAX_DIRECTORY_ENTRIES = 1024
const MAX_CI_FILE_BYTES = 512 * 1024
const MAX_JSON_FILE_BYTES = 512 * 1024
const MAX_CI_DIRECTORY_ENTRIES = 256
const MAX_CI_REVIEW_TARGETS = 3
const LOCAL_SOCKET_API_PATTERN =
  /(?:\bsupertest\b|\bcreateServer\s*\(|\.listen\s*\(|(?:from\s+|require\s*\(\s*)['"]node:(?:http|https|net)['"])/
const LOCAL_SOCKET_REQUEST_PATTERN =
  /\bcy\.(?:visit|request)\s*\(\s*['"](?:\/|https?:\/\/(?:localhost|127\.0\.0\.1))/
const JEST_VALUE_OPTIONS = new Set([
  '-c', '-t', '-w', '--config', '--env', '--ignoreProjects', '--maxWorkers', '--outputFile', '--runner',
  '--selectProjects', '--shard', '--testEnvironment', '--testNamePattern', '--testPathPattern', '--testPathPatterns',
  '--testTimeout',
])
const JEST_RUNNER_CONFIG_EXTENSION_PATTERN = /\.[cm]?[jt]s$/
const JEST_RUNNER_CONFIG_SUFFIX_PATTERN = /^[A-Za-z0-9_.-]+$/
const PLAYWRIGHT_FIXTURE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']
const PLAYWRIGHT_LOCAL_ESM_TEST_IMPORT_PATTERN =
  /\bimport\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"\r\n]+)\2/g
const PLAYWRIGHT_LOCAL_CJS_TEST_IMPORT_PATTERN =
  /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])(\.{1,2}\/[^'"\r\n]+)\2\s*\)/g
const PLAYWRIGHT_NAMED_EXPORT_PATTERN = /\bexport\s*\{([^}]*)\}/g
const PLAYWRIGHT_COMMONJS_EXPORT_PATTERN = /\bmodule\.exports\s*=\s*\{([^}]*)\}/g
const PLAYWRIGHT_DIRECT_IMPORT_PATTERN = /(?:from\s+|require\s*\(\s*)['"]@playwright\/test['"]/
const ISOLATION_CONFIGURATION_OPTIONS = {
  cucumber: new Set([
    '-p', '--config', '--import', '--language', '--loader', '--profile', '--require', '--require-module',
    '--world-parameters',
  ]),
  cypress: new Set(['--browser', '--component', '--config-file', '--e2e', '--headed', '--headless']),
  jest: new Set(['--config', '--detectLeaks', '--env', '--runner', '--testEnvironment']),
  mocha: new Set([
    '-r', '-t', '-u', '--check-leaks', '--config', '--enable-source-maps', '--extension', '--loader', '--require',
    '--timeout', '--ui',
  ]),
  playwright: new Set(['-c', '--config', '--project']),
  vitest: new Set(['--browser', '--config', '--environment', '--project', '--root']),
}
const ISOLATION_CONFIGURATION_VALUE_OPTIONS = {
  cucumber: new Set([
    '-p', '--config', '--import', '--language', '--loader', '--profile', '--require', '--require-module',
    '--world-parameters',
  ]),
  cypress: new Set(['--browser', '--config-file']),
  jest: new Set(['--config', '--env', '--runner', '--testEnvironment']),
  mocha: new Set(['-r', '-t', '-u', '--config', '--extension', '--loader', '--require', '--timeout', '--ui']),
  playwright: new Set(['-c', '--config', '--project']),
  vitest: new Set(['--browser', '--config', '--environment', '--project', '--root']),
}
const ISOLATION_PRESENTATION_OPTIONS = {
  cucumber: new Set(['--format', '--format-options', '--no-publish', '--publish']),
  cypress: new Set(['--quiet']),
  jest: new Set(['--colors', '--noStackTrace', '--silent', '--verbose']),
  mocha: new Set(['-R', '--color', '--no-color', '--recursive', '--reporter']),
  playwright: new Set(['--quiet', '--reporter']),
  vitest: new Set(['--color', '--no-color', '--reporter', '--silent']),
}
const ISOLATION_PRESENTATION_VALUE_OPTIONS = {
  cucumber: new Set(['--format', '--format-options']),
  cypress: new Set(),
  jest: new Set(),
  mocha: new Set(['-R', '--reporter']),
  playwright: new Set(['--reporter']),
  vitest: new Set(['--reporter']),
}
const RUNNER_ENVIRONMENT_VARIABLES = new Set([
  'BABEL_ENV',
  'CI',
  'CUCUMBER_PUBLISH_ENABLED',
  'NODE_ENV',
  'TS_NODE_PROJECT',
  'TZ',
])
const CI_PATHS = [
  '.github/workflows',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  '.buildkite/pipeline.yml',
  'bitbucket-pipelines.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
]

/**
 * Creates a schema-valid starting manifest without executing project code.
 *
 * @param {object} input scaffold inputs
 * @param {string} input.root repository root
 * @param {Set<string>} [input.frameworks] selected framework ids or kinds
 * @returns {object} validation manifest scaffold
 */
function createManifestScaffold ({ root, frameworks = new Set() }) {
  const repositoryRoot = path.resolve(root)
  const diagnosis = runDiagnosis({ root: repositoryRoot, env: {} })
  const ciDiscovery = discoverCiFiles(repositoryRoot)
  const selected = diagnosis.eligibleFrameworks.filter(framework => {
    return frameworks.size === 0 || frameworks.has(framework.id) || frameworks.has(framework.id.split(':')[0])
  })
  const unsupported = diagnosis.unsupportedFrameworks.filter(framework => {
    return frameworks.size === 0 || frameworks.has(framework.id) || frameworks.has(framework.id.split(':')[0])
  })
  const selectedKinds = new Set(selected.map(framework => framework.id))
  const detectedNotRunnable = diagnosis.supportedFrameworks.filter(framework => {
    return !selectedKinds.has(framework.id) &&
      (frameworks.size === 0 || frameworks.has(framework.id) || frameworks.has(framework.id.split(':')[0]))
  })
  if (selected.length === 0 && unsupported.length === 0 && detectedNotRunnable.length === 0) {
    throw new Error('No test framework was detected for manifest scaffolding.')
  }
  const artifactNamespaces = getArtifactNamespaces(repositoryRoot, selected)

  const manifest = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    repository: {
      root: repositoryRoot,
      gitRemote: null,
      gitSha: null,
      packageManager: detectPackageManager(repositoryRoot),
      workspaceManager: detectWorkspaceManager(repositoryRoot),
    },
    environment: {
      os: getManifestOs(process.platform),
      shell: process.env.SHELL || null,
      nodeVersion: process.version,
      requiredEnvVars: [],
      safeEnv: {},
    },
    ciDiscovery,
    frameworks: [
      ...selected.map(framework => buildFrameworkScaffold(
        repositoryRoot,
        framework,
        ciDiscovery,
        artifactNamespaces.get(framework)
      )),
      ...detectedNotRunnable.map(framework => {
        return buildDetectedNotRunnableFrameworkScaffold(repositoryRoot, framework, ciDiscovery)
      }),
      ...unsupported.map(framework => buildUnsupportedFrameworkScaffold(repositoryRoot, framework, ciDiscovery)),
    ],
    omitted: [],
  }

  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    throw new Error(`Generated manifest scaffold is invalid:\n- ${errors.join('\n- ')}`)
  }
  return manifest
}

/**
 * Builds a non-runnable scaffold for a detected framework without an eligible live command.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} detection framework detection
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} manifest framework entry
 */
function buildDetectedNotRunnableFrameworkScaffold (repositoryRoot, detection, ciDiscovery) {
  const locations = detection.locations || []
  const packageJsonPath = getDetectionPackageJson(repositoryRoot, locations)
  const projectRoot = path.dirname(packageJsonPath)
  const packageJson = readJson(packageJsonPath) || {}
  const version = detection.versionDetections?.[0]?.version || detection.versionDetections?.[0]?.rawVersion || null
  const reason = detection.supportedVersion
    ? `A supported ${detection.name} version was detected, but no eligible test command was found.`
    : `${detection.name} ${version || 'with an undetermined version'} was detected, but this dd-trace version ` +
      `supports ${detection.supportedRange}.`

  return {
    id: `${detection.id}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
    framework: detection.id,
    frameworkVersion: version,
    language: 'unknown',
    status: 'detected_not_runnable',
    supportLevel: 'detected_only',
    project: getProject({
      packageJson,
      packageJsonPath,
      projectRoot,
      repositoryRoot,
      framework: detection.id,
    }),
    ciWiring: buildCiWiringScaffold(ciDiscovery),
    notes: [reason],
  }
}

/**
 * Builds a diagnostic-only entry for a detected runner the validator cannot execute.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} detection static framework detection
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} non-runnable framework manifest entry
 */
function buildUnsupportedFrameworkScaffold (repositoryRoot, detection, ciDiscovery) {
  const packageJsonPath = getDetectionPackageJson(repositoryRoot, detection.locations)
  const projectRoot = path.dirname(packageJsonPath)
  const packageJson = readJson(packageJsonPath) || {}
  const framework = detection.id === 'node-test' ? 'node:test' : detection.id

  return {
    id: `${detection.id}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
    framework,
    frameworkVersion: getInstalledFrameworkVersion(detection.id, projectRoot, packageJson),
    language: 'unknown',
    status: 'unsupported_by_validator',
    supportLevel: 'detected_only',
    project: getProject({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }),
    ciWiring: buildCiWiringScaffold(ciDiscovery),
    notes: [
      `${detection.name} was detected at ${detection.locations.join(', ') || 'an unknown location'}, but is not ` +
        'supported by this Test Optimization validator.',
    ],
  }
}

function buildFrameworkScaffold (repositoryRoot, detection, ciDiscovery, artifactNamespace) {
  const packageJsonPath = path.resolve(repositoryRoot, detection.commandLocation || 'package.json')
  const projectRoot = path.dirname(packageJsonPath)
  const packageJson = readJson(packageJsonPath) || {}
  const framework = detection.id

  if (!SUPPORTED_SCAFFOLD_FRAMEWORKS.has(framework)) {
    return {
      id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
      framework,
      frameworkVersion: detection.version,
      status: 'detected_not_runnable',
      supportLevel: 'dd_trace_supported_but_validator_missing_adapter',
      project: getProject({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }),
      ciWiring: buildCiWiringScaffold(ciDiscovery),
      notes: [
        `${detection.name} was detected and is supported by dd-trace, but this local validator has no live ` +
          `${detection.name} adapter. Live validation currently supports Cucumber, Cypress, Jest, Mocha, ` +
          'Playwright, and Vitest.',
      ],
    }
  }

  const runner = tryResolveRunner(framework, projectRoot, repositoryRoot)
  if (!runner) {
    const packageName = getRunnerPackageName(framework)
    const declaredVersion = packageJson.dependencies?.[packageName] || packageJson.devDependencies?.[packageName]
    const setupDetail = declaredVersion
      ? ` ${detection.name} is declared as ${JSON.stringify(declaredVersion)} in this package, but its executable ` +
        'is not installed or resolvable there. Complete this package-local dependency setup before live validation.'
      : ''
    return {
      id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
      framework,
      frameworkVersion: detection.version,
      status: 'requires_manual_setup',
      project: getProject({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }),
      ciWiring: buildCiWiringScaffold(ciDiscovery),
      notes: [
        `${detection.name} was detected, but its executable package could not be resolved from ` +
          `${path.relative(repositoryRoot, projectRoot) || 'the repository root'}.${setupDetail}`,
      ],
    }
  }
  const scriptName = getPackageScriptName(packageJson, detection.command)
  const preserveProjectWrapper = Boolean(scriptName)
  const baseCommand = buildExistingCommand({
    framework,
    detectedCommand: detection.command,
    projectRoot,
    repositoryRoot,
    runner,
    scriptName,
    preserveProjectWrapper,
  })
  const directRunnerSelection = scriptName
    ? getIsolationRunnerSelection(framework, detection.command)
    : undefined
  const directBaseCommand = directRunnerSelection
    ? buildDirectRunnerBaseCommand({
      framework,
      projectRoot,
      runner,
      selection: directRunnerSelection,
    })
    : undefined
  const representativeRoot = findPreferredRepresentativeRoot(projectRoot, repositoryRoot)
  const representativePackage = readJson(path.join(representativeRoot, 'package.json')) || packageJson
  const representativeSearchRoots = getRepresentativeSearchRoots(
    representativeRoot,
    framework,
    detection.command,
    representativePackage
  )
  const representativeSelection = findRepresentativeTestFiles(
    representativeRoot,
    framework,
    representativePackage.name,
    representativeSearchRoots
  )
  const project = getProject({
    detectedCommand: detection.command,
    framework,
    packageJson,
    packageJsonPath,
    projectRoot,
    repositoryRoot,
  })
  const candidateSelections = []
  for (const { file } of representativeSelection.candidates) {
    const projectCommand = buildFocusedCommand(
      baseCommand,
      framework,
      file,
      Boolean(scriptName),
      preserveProjectWrapper
    )
    const projectError = getCommandSuitabilityError({
      command: projectCommand,
      framework: { framework },
      label: `${framework} Basic Reporting candidate`,
      repositoryRoot,
    })
    const useDirectRunner = Boolean(directBaseCommand) &&
      (directRunnerSelection.hasSourceSelectors || projectError)
    if (projectError && !useDirectRunner) {
      representativeSelection.rejected.push(`${path.relative(projectRoot, file)} (${projectError})`)
      continue
    }
    const selectedBaseCommand = useDirectRunner ? directBaseCommand : baseCommand
    candidateSelections.push({
      baseCommand: selectedBaseCommand,
      candidate: {
        command: buildFocusedCommand(
          selectedBaseCommand,
          framework,
          file,
          !useDirectRunner && Boolean(scriptName),
          !useDirectRunner && preserveProjectWrapper
        ),
        origin: useDirectRunner ? 'validator-direct' : 'project',
        selection: useDirectRunner || directRunnerSelection ? 'exact' : 'best_effort',
        sourceFile: file,
      },
    })
  }
  const localTestCandidates = candidateSelections.map(selection => selection.candidate)
  const isolationTestCandidates = []
  for (const [primaryCandidateIndex, candidate] of localTestCandidates.entries()) {
    if (candidate.origin !== 'project') continue
    const isolationTestCandidate = buildIsolationTestCandidate({
      detectedCommand: detection.command,
      framework,
      primaryCandidateIndex,
      projectRoot,
      representative: candidate.sourceFile,
      runner,
      scriptName,
    })
    if (isolationTestCandidate) isolationTestCandidates.push(isolationTestCandidate)
  }
  const representative = localTestCandidates[0]?.sourceFile
  if (!representative) {
    const reason = representativeSelection.rejected.length > 0
      ? `Candidate test files could not be selected safely: ${representativeSelection.rejected.slice(0, 3).join(', ')}.`
      : 'No suitable representative test file could be selected from the detected project.'
    return {
      id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
      framework,
      frameworkVersion: detection.version,
      language: 'unknown',
      status: 'requires_manual_setup',
      supportLevel: 'validator_supported',
      project,
      ciWiring: buildCiWiringScaffold(ciDiscovery),
      notes: [`${reason} Select a real ${detection.name} test before live validation.`],
    }
  }
  const command = localTestCandidates[0].command
  const isolationTestCandidate = isolationTestCandidates.find(candidate => candidate.primaryCandidateIndex === 0)

  const generatedTestStrategy = buildGeneratedTestStrategy({
    baseCommand: candidateSelections[0]?.baseCommand,
    framework,
    packageJson,
    projectRoot,
    representative,
    runner,
    runnerEnvironment: getRunnerEnvironment(detection.command, framework),
    artifactNamespace,
    runnerConfigurationArgs: getRunnerConfigurationArgs(framework, detection.command),
  })
  const ciWiring = buildCiWiringScaffold(ciDiscovery)
  const runnerMode = getRunnerMode(framework, detection.command)

  return {
    id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
    framework,
    frameworkVersion: detection.version,
    language: /\.tsx?$/.test(generatedTestStrategy.fileExtension) ? 'typescript' : 'javascript',
    status: 'runnable',
    supportLevel: 'validator_supported',
    browserRequired: framework === 'cypress' || framework === 'playwright' ||
      (framework === 'vitest' && runnerMode === 'browser'),
    localSocketRequired: representativeSelection.candidates.every(candidate => candidate.requiresLocalSocket),
    project,
    existingTestCommand: command,
    localTestCandidates,
    ...(isolationTestCandidate ? { isolationTestCandidate } : {}),
    ...(isolationTestCandidates.length > 0 ? { isolationTestCandidates } : {}),
    preflight: { status: 'pending' },
    ciWiring,
    generatedTestStrategy,
    notes: [
      representative
        ? `Generated by --init-manifest with up to ${MAX_LOCAL_TEST_CANDIDATES} whole-file candidates, ` +
          `starting with ${path.relative(repositoryRoot, representative)}.`
        : 'Generated by --init-manifest. Select an existing test file if no candidate passes preflight.',
      ...(representativeSearchRoots.length === 1 && representativeSearchRoots[0] !== representativeRoot
        ? ['Candidate discovery was restricted to the statically selected test root ' +
            `${path.relative(repositoryRoot, representativeSearchRoots[0])}.`]
        : []),
      localTestCandidates[0]?.origin === 'project'
        ? `Basic Reporting preserves package script ${scriptName} and its project-owned runner semantics.`
        : `Basic Reporting invokes the detected installed ${framework} runner directly with the selected file and ` +
          'statically retained project configuration.',
      ...(isolationTestCandidate
        ? ['If the project command passes cleanly but does not produce complete initialized events, the validator ' +
            'may run the disclosed equivalent direct-runner command to isolate wrapper propagation from tracer ' +
            'or adapter behavior.']
        : []),
      ...(representativeSelection.candidates.every(candidate => candidate.requiresLocalSocket)
        ? ['Every safe representative test found appears to open a local listener. The approved test command may ' +
            'be blocked in an execution environment that denies project localhost sockets. If so, retry the same ' +
            'approved plan in a suitable project-test environment without requesting broader permissions ' +
            'automatically.']
        : []),
      'CI command selection still requires repository-specific evidence.',
    ],
  }
}

/**
 * Builds bounded static CI evidence for a runnable framework.
 *
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} static CI wiring evidence
 */
function buildCiWiringScaffold (ciDiscovery) {
  const initialization = {
    status: ciDiscovery.initialization.status,
    evidence: [...ciDiscovery.initialization.evidence],
  }
  return {
    configFile: null,
    job: null,
    step: null,
    command: null,
    workingDirectory: null,
    shell: null,
    wrapperChain: [],
    terminalTestCommand: null,
    diagnosis: 'Inspect the first matching CI review target and record the selected test job, exact command, ' +
      'environment, wrapper chain, and unresolved configuration before drawing a CI initialization conclusion.',
    initialization,
    transport: {
      mode: 'unknown',
      evidence: [],
    },
    unresolved: [
      'The CI test job, exact command, inherited configuration, and wrapper chain have not been resolved.',
    ],
  }
}

function getProject ({ detectedCommand, packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }) {
  return {
    name: packageJson.name || getProjectIdentifier(packageJson, projectRoot, repositoryRoot),
    root: projectRoot,
    packageJson: packageJsonPath,
    configFiles: findConfigFiles(projectRoot, framework, detectedCommand),
    evidence: [`Detected ${framework} from ${path.relative(repositoryRoot, packageJsonPath) || 'package.json'}.`],
  }
}

function buildExistingCommand ({
  detectedCommand,
  framework,
  projectRoot,
  repositoryRoot,
  runner,
  scriptName,
  preserveProjectWrapper,
}) {
  const packageManager = preserveProjectWrapper ? detectPackageManager(repositoryRoot) : undefined
  const argv = preserveProjectWrapper
    ? getPackageScriptArgv(packageManager, scriptName, repositoryRoot)
    : getDirectRunnerArgv(framework, runner, getRunnerConfigurationArgs(framework, detectedCommand))
  return {
    description: preserveProjectWrapper
      ? `Detected project package script ${scriptName}`
      : `Detected installed ${framework} runner`,
    cwd: projectRoot,
    argv,
    env: preserveProjectWrapper ? {} : getRunnerEnvironment(detectedCommand, framework),
    requiredEnvVars: [],
    timeoutMs: 300_000,
    usesShell: false,
  }
}

/**
 * Builds an optional direct-runner command that keeps the selected file and statically recoverable runner mode.
 *
 * @param {object} input isolation inputs
 * @param {string} input.detectedCommand detected package script
 * @param {string} input.framework framework name
 * @param {number} input.primaryCandidateIndex matching project candidate index
 * @param {string} input.projectRoot project root
 * @param {string} input.representative selected existing test file
 * @param {string} input.runner resolved runner entrypoint
 * @param {string|undefined} input.scriptName selected package script name
 * @returns {object|undefined} isolation candidate
 */
function buildIsolationTestCandidate ({
  detectedCommand,
  framework,
  primaryCandidateIndex,
  projectRoot,
  representative,
  runner,
  scriptName,
}) {
  if (!scriptName) return
  const isolationSelection = getIsolationRunnerSelection(framework, detectedCommand)
  if (!isolationSelection) return

  const baseCommand = buildDirectRunnerBaseCommand({
    description: `Direct installed ${framework} runner used only to isolate project-wrapper propagation`,
    framework,
    projectRoot,
    runner,
    selection: isolationSelection,
  })
  return {
    command: buildFocusedCommand(baseCommand, framework, representative, false, false),
    equivalence: {
      configurationArgs: isolationSelection.configurationArgs,
      framework,
      mode: isolationSelection.mode,
      sourceFile: representative,
    },
    origin: 'validator-direct',
    primaryCandidateIndex,
    sourceFile: representative,
  }
}

/**
 * Builds a direct installed-runner command with statically retained project semantics.
 *
 * @param {object} input direct command inputs
 * @param {string} [input.description] command description
 * @param {string} input.framework framework name
 * @param {string} input.projectRoot project root
 * @param {string} input.runner resolved runner entrypoint
 * @param {object} input.selection retained runner selection
 * @returns {object} direct runner command
 */
function buildDirectRunnerBaseCommand ({
  description,
  framework,
  projectRoot,
  runner,
  selection,
}) {
  return {
    description: description || `Detected installed ${framework} runner with project configuration`,
    cwd: projectRoot,
    argv: getDirectRunnerArgv(framework, runner, selection.configurationArgs),
    env: selection.environment,
    requiredEnvVars: [],
    timeoutMs: 300_000,
    usesShell: false,
  }
}

/**
 * Describes the statically retained runner mode for isolation reporting.
 *
 * @param {string} framework framework name
 * @param {string} command detected command
 * @returns {string} runner mode
 */
function getRunnerMode (framework, command) {
  if (framework === 'cypress') return /(?:^|\s)--component(?:\s|$)/.test(command) ? 'component' : 'e2e'
  if (framework === 'playwright') return 'test'
  if (framework === 'vitest') return /(?:^|\s)--browser(?:[=\s]|$)/.test(command) ? 'browser' : 'node'
  return 'test'
}

function buildGeneratedTestStrategy ({
  artifactNamespace,
  baseCommand,
  framework,
  packageJson,
  projectRoot,
  representative,
  runner,
  runnerEnvironment,
  runnerConfigurationArgs,
}) {
  const convention = getGeneratedTestConvention(representative, projectRoot)
  const packageType = getNearestPackageType(convention.testDirectory, projectRoot, packageJson.type)
  const moduleSystem = getGeneratedModuleSystem(framework, convention.fileExtension, packageType)
  const definitions = getGeneratedDefinitions({ artifactNamespace, framework, convention, moduleSystem })
  const cucumberStepsFile = framework === 'cucumber'
    ? cucumberAdapter.getGeneratedStepsPath(convention.testDirectory)
    : undefined
  const generatedConfig = framework === 'playwright'
    ? {
        content: playwrightAdapter.getGeneratedConfigContent(),
        path: playwrightAdapter.getGeneratedConfigPath(convention.testDirectory),
      }
    : undefined

  return {
    status: 'planned',
    reason: 'Standard isolated scenarios generated by the validator manifest scaffold.',
    adapter: framework,
    testDirectory: convention.testDirectory,
    moduleSystem,
    fileExtension: convention.fileExtension,
    supportsFocusedSingleFileRun: true,
    usesMultipleFiles: true,
    files: [
      ...definitions.map(definition => ({
        path: definition.file,
        role: framework === 'cucumber' ? 'feature' : 'test',
        contentLines: definition.content.split('\n'),
      })),
      ...(cucumberStepsFile
        ? [{
            path: cucumberStepsFile,
            role: 'steps',
            contentLines: cucumberAdapter.getGeneratedStepsContent().split('\n'),
          }]
        : []),
      ...(generatedConfig
        ? [{
            path: generatedConfig.path,
            role: 'config',
            contentLines: generatedConfig.content.split('\n'),
          }]
        : []),
    ],
    scenarios: definitions.map(definition => ({
      id: definition.id,
      purpose: definition.purpose,
      runCommand: baseCommand && !['cucumber', 'playwright'].includes(framework)
        ? buildGeneratedProjectCommand(
          baseCommand,
          framework,
          definition.file,
          moduleSystem
        )
        : buildGeneratedRunCommand(
          framework,
          projectRoot,
          definition.file,
          runner,
          moduleSystem,
          runnerConfigurationArgs,
          runnerEnvironment,
          generatedConfig?.path,
          cucumberStepsFile
        ),
      expectedWithoutDatadog: {
        exitCode: definition.id === 'atr-fail-once' ? 1 : 0,
        observedTestCount: 1,
      },
      testIdentities: [{
        suite: null,
        name: definition.testName,
        file: definition.file,
        parameters: null,
      }],
    })),
    cleanupPaths: [
      ...definitions.map(definition => definition.file),
      ...(cucumberStepsFile ? [cucumberStepsFile] : []),
      ...(generatedConfig ? [generatedConfig.path] : []),
      ...(['cucumber', 'cypress', 'playwright'].includes(framework)
        ? []
        : [getGeneratedRetryStatePath(
            framework,
            definitions.find(definition => definition.id === 'atr-fail-once').file
          )]),
    ],
  }
}

/**
 * Focuses a project-owned wrapper on one generated scenario while retaining generated-test controls.
 *
 * @param {object} baseCommand selected project or direct-runner command
 * @param {string} framework selected framework
 * @param {string} filename generated test file
 * @param {string} moduleSystem generated test module system
 * @returns {object} generated scenario command
 */
function buildGeneratedProjectCommand (baseCommand, framework, filename, moduleSystem) {
  if (framework !== 'cypress') {
    const command = buildFocusedCommand(baseCommand, framework, filename, true, true, moduleSystem)
    if (framework === 'jest') {
      command.argv = command.argv.filter(argument => argument.split('=', 1)[0] !== '--detectLeaks')
      command.argv.push('--detectLeaks=false')
    }
    return command
  }

  const argv = [...baseCommand.argv]
  if (path.basename(argv[0]).toLowerCase() === 'npm') argv.push('--')
  argv.push(...cypressAdapter.getGeneratedTestArgs(filename, []).slice(1))
  return {
    ...baseCommand,
    description: `${baseCommand.description} targeting ${path.basename(filename)}`,
    argv,
  }
}

function getGeneratedModuleSystem (framework, fileExtension, packageType) {
  if (framework === 'cucumber') return 'commonjs'
  if (/\.(?:cjs|cts)$/.test(fileExtension)) return 'commonjs'
  if (framework === 'vitest' || /\.(?:mjs|mts)$/.test(fileExtension)) return 'esm'
  return packageType === 'module' ? 'esm' : 'commonjs'
}

/**
 * Returns the package module type that applies to a generated test directory.
 *
 * @param {string} testDirectory generated test directory
 * @param {string} projectRoot detected project root
 * @param {string|undefined} fallbackType detected project package type
 * @returns {string|undefined} nearest package module type
 */
function getNearestPackageType (testDirectory, projectRoot, fallbackType) {
  const root = path.resolve(projectRoot)
  let directory = path.resolve(testDirectory)

  while (directory === root || isPathInside(root, directory)) {
    const packageJson = readJson(path.join(directory, 'package.json'))
    if (typeof packageJson?.type === 'string') return packageJson.type
    if (directory === root) break
    directory = path.dirname(directory)
  }

  return fallbackType
}

function getGeneratedTestConvention (representative, projectRoot) {
  if (!representative) {
    return {
      exactFilename: undefined,
      fileExtension: '.test.js',
      testDirectory: path.join(projectRoot, 'test'),
    }
  }

  const basename = path.basename(representative)
  if (/^test\.[cm]?[jt]s$/.test(basename)) {
    const representativeDirectory = path.dirname(representative)
    return {
      exactFilename: basename,
      fileExtension: path.extname(basename),
      testDirectory: representativeDirectory === projectRoot
        ? projectRoot
        : path.dirname(representativeDirectory),
    }
  }

  return {
    exactFilename: undefined,
    fileExtension: getTestExtension(representative),
    testDirectory: path.dirname(representative),
  }
}

function getGeneratedDefinitions ({ artifactNamespace, framework, convention, moduleSystem }) {
  return Object.entries(GENERATED_SCENARIOS).map(([id, definition]) => {
    const namespace = artifactNamespace ? `${artifactNamespace}-` : ''
    const prefix = `dd-test-optimization-validation-${namespace}${id}`
    const filename = convention.exactFilename
      ? path.join(prefix, convention.exactFilename)
      : `${prefix}${convention.fileExtension}`
    const generatedFile = path.join(convention.testDirectory, filename)
    return {
      id,
      ...definition,
      file: generatedFile,
      content: getGeneratedTestContent({
        framework,
        moduleSystem,
        scenarioId: id,
        stateFile: ['cucumber', 'cypress', 'playwright'].includes(framework)
          ? undefined
          : getGeneratedRetryStatePath(framework, generatedFile),
      }),
    }
  })
}

/**
 * Namespaces validator-owned artifacts when multiple runnable frameworks share a project root.
 *
 * @param {string} repositoryRoot repository root
 * @param {object[]} detections selected runnable framework detections
 * @returns {Map<object, string>} namespace by detection
 */
function getArtifactNamespaces (repositoryRoot, detections) {
  const detectionsByRoot = new Map()
  for (const detection of detections) {
    const packageJsonPath = path.resolve(repositoryRoot, detection.commandLocation || 'package.json')
    const projectRoot = path.dirname(packageJsonPath)
    const entries = detectionsByRoot.get(projectRoot) || []
    entries.push(detection)
    detectionsByRoot.set(projectRoot, entries)
  }

  const namespaces = new Map()
  for (const entries of detectionsByRoot.values()) {
    if (entries.length < 2) continue
    const frameworkCounts = new Map()
    for (const detection of entries) {
      const count = (frameworkCounts.get(detection.id) || 0) + 1
      frameworkCounts.set(detection.id, count)
      namespaces.set(detection, count === 1 ? detection.id : `${detection.id}-${count}`)
    }
  }
  return namespaces
}

function buildGeneratedRunCommand (
  framework,
  projectRoot,
  filename,
  runner,
  moduleSystem,
  runnerConfigurationArgs = [],
  runnerEnvironment = {},
  generatedConfigFile,
  cucumberStepsFile
) {
  const args = {
    cucumber: cucumberAdapter.getGeneratedTestArgs(filename, cucumberStepsFile),
    cypress: cypressAdapter.getGeneratedTestArgs(filename, runnerConfigurationArgs),
    jest: ['--runTestsByPath', filename, '--runInBand', '--silent', '--no-watchman'],
    mocha: ['--reporter', 'spec', filename],
    playwright: playwrightAdapter.getGeneratedTestArgs(filename, generatedConfigFile),
    vitest: ['run', filename, ...(moduleSystem === 'commonjs' ? ['--globals'] : [])],
  }[framework]
  return {
    cwd: framework === 'cucumber' ? path.dirname(filename) : projectRoot,
    argv: [
      process.execPath,
      runner,
      ...(['cucumber', 'cypress', 'playwright'].includes(framework) ? [] : runnerConfigurationArgs),
      ...args,
    ],
    env: runnerEnvironment,
    outputPaths: framework === 'playwright' ? [playwrightAdapter.getOutputPath(filename)] : [],
    requiredEnvVars: [],
    timeoutMs: 300_000,
    usesShell: false,
  }
}

/**
 * Adds a single test file selection to a detected project command.
 *
 * @param {object} baseCommand detected project command
 * @param {string} framework detected test framework
 * @param {string} filename selected test file
 * @param {boolean} packageScript whether the command invokes a package script
 * @param {boolean} preserveDefaultReporter whether a repository wrapper owns reporter selection
 * @param {string} [moduleSystem] generated test module system
 * @returns {object} focused project command
 */
function buildFocusedCommand (
  baseCommand,
  framework,
  filename,
  packageScript,
  preserveDefaultReporter,
  moduleSystem
) {
  const argv = [...baseCommand.argv]
  if (packageScript && path.basename(argv[0]).toLowerCase() === 'npm') argv.push('--')
  argv.push(...getFocusedTestArgs(framework, filename, preserveDefaultReporter, moduleSystem))

  return {
    ...baseCommand,
    description: `${baseCommand.description} targeting ${path.basename(filename)}`,
    argv,
    ...(framework === 'playwright'
      ? { outputPaths: [...new Set([...(baseCommand.outputPaths || []), playwrightAdapter.getOutputPath(filename)])] }
      : {}),
  }
}

/**
 * Returns framework arguments that select exactly one test file.
 *
 * @param {string} framework detected test framework
 * @param {string} filename selected test file
 * @param {boolean} preserveDefaultReporter whether a repository wrapper owns reporter selection
 * @param {string} [moduleSystem] generated test module system
 * @returns {string[]} focused test arguments
 */
function getFocusedTestArgs (framework, filename, preserveDefaultReporter, moduleSystem) {
  if (framework === 'cucumber') return cucumberAdapter.getFocusedTestArgs(filename)
  if (framework === 'cypress') return cypressAdapter.getFocusedTestArgs(filename)
  if (framework === 'playwright') return playwrightAdapter.getFocusedTestArgs(filename)
  if (framework === 'jest') {
    return [
      '--runTestsByPath',
      filename,
      '--runInBand',
      ...(preserveDefaultReporter ? [] : ['--silent']),
      '--no-watchman',
    ]
  }
  return [
    filename,
    ...(framework === 'vitest' && moduleSystem === 'commonjs' ? ['--globals'] : []),
  ]
}

/**
 * Resolves an installed framework executable without making the whole scaffold fail when a nested package only
 * declares the dependency.
 *
 * @param {string} framework detected framework
 * @param {string} projectRoot detected project root
 * @returns {string|undefined} resolved executable path
 */
function tryResolveRunner (framework, projectRoot, repositoryRoot) {
  try {
    return resolveRunner(framework, projectRoot, repositoryRoot)
  } catch {}
}

function resolveRunner (framework, projectRoot, repositoryRoot) {
  const packageName = getRunnerPackageName(framework)
  const root = path.resolve(repositoryRoot)
  const projectPackageJsonPath = path.join(projectRoot, 'package.json')
  const projectPackageJson = readJson(projectPackageJsonPath)
  if (projectPackageJson?.name === packageName) {
    const binName = getRunnerExecutableName(framework)
    const bin = typeof projectPackageJson.bin === 'string'
      ? projectPackageJson.bin
      : projectPackageJson.bin?.[binName]
    if (typeof bin === 'string') {
      const runner = fs.realpathSync(path.resolve(projectRoot, bin))
      if (!isPathInside(fs.realpathSync(root), runner)) {
        throw new Error('runner executable resolves outside repository')
      }
      return runner
    }
  }
  let directory = path.resolve(projectRoot)
  while (directory === root || isPathInside(root, directory)) {
    const packageJsonPath = path.join(directory, 'node_modules', ...packageName.split('/'), 'package.json')
    try {
      const stat = fs.lstatSync(packageJsonPath)
      const physicalPackageJson = fs.realpathSync(packageJsonPath)
      if (!stat.isFile() || stat.isSymbolicLink() || !isPathInside(fs.realpathSync(root), physicalPackageJson)) {
        throw new Error('runner package metadata is not a regular repository-contained file')
      }
      const packageJson = readJson(physicalPackageJson)
      const binName = getRunnerExecutableName(framework)
      const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName]
      if (typeof bin !== 'string') throw new Error('runner package has no executable')
      const runner = fs.realpathSync(path.resolve(path.dirname(physicalPackageJson), bin))
      if (!isPathInside(fs.realpathSync(root), runner)) throw new Error('runner executable resolves outside repository')
      return runner
    } catch (error) {
      if (fs.existsSync(packageJsonPath)) throw error
    }
    if (directory === root) break
    directory = path.dirname(directory)
  }
  throw new Error(`${packageName} is not installed inside the repository`)
}

/**
 * Returns the npm package that provides a framework runner.
 *
 * @param {string} framework framework name
 * @returns {string} runner package name
 */
function getRunnerPackageName (framework) {
  return {
    cucumber: '@cucumber/cucumber',
    cypress: 'cypress',
    jest: 'jest',
    playwright: '@playwright/test',
  }[framework] || framework
}

/**
 * Returns the executable name exported by a framework package.
 *
 * @param {string} framework framework name
 * @returns {string} runner executable name
 */
function getRunnerExecutableName (framework) {
  if (framework === 'cucumber') return 'cucumber-js'
  return framework === 'playwright' ? 'playwright' : framework
}

function getPackageScriptArgv (packageManager, scriptName, repositoryRoot) {
  if (packageManager === 'yarn') {
    const release = findYarnRelease(repositoryRoot)
    return release ? [process.execPath, release, 'run', scriptName] : ['yarn', 'run', scriptName]
  }
  return [packageManager, 'run', scriptName]
}

/**
 * Resolves a package script that directly invokes a repository-owned Node.js runner.
 *
 * @param {string} command package script command
 * @param {string} projectRoot detected project root
 * @returns {string|undefined} absolute runner path
 */
function getProjectOwnedNodeRunner (command, projectRoot) {
  const match = /^node\s+([^\s"'`;&|]+)$/.exec(String(command || '').trim())
  if (!match) return

  const filename = path.resolve(projectRoot, match[1])
  if (!isPathInside(projectRoot, filename)) return
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    return filename
  } catch {}
}

/**
 * Finds the package script whose value produced the detected framework command.
 *
 * @param {object} packageJson project package metadata
 * @param {string} command detected framework command
 * @returns {string|undefined} package script name
 */
function getPackageScriptName (packageJson, command) {
  return Object.entries(packageJson.scripts || {}).find(([, value]) => value === command)?.[0]
}

/**
 * Builds a direct local runner invocation while retaining bounded configuration flags.
 *
 * @param {string} framework framework name
 * @param {string} runner resolved runner entrypoint
 * @param {string[]} configurationArgs approved runner configuration arguments
 * @returns {string[]} command arguments
 */
function getDirectRunnerArgv (framework, runner, configurationArgs = []) {
  return [
    process.execPath,
    runner,
    ...(['cypress', 'vitest'].includes(framework) ? ['run'] : framework === 'playwright' ? ['test'] : []),
    ...configurationArgs,
  ]
}

/**
 * Extracts framework configuration arguments that are safe to preserve in focused commands.
 *
 * @param {string} framework framework name
 * @param {string} command detected package command
 * @returns {string[]} configuration arguments
 */
function getRunnerConfigurationArgs (framework, command) {
  const allowed = ISOLATION_CONFIGURATION_OPTIONS[framework]
  if (!allowed) return []
  const valueOptions = ISOLATION_CONFIGURATION_VALUE_OPTIONS[framework]

  const invocation = getFrameworkInvocation(command, framework)
  if (!invocation) return []
  const tokens = invocation.tokens.slice(invocation.runnerIndex + 1)
  const args = []
  for (let index = 0; index < tokens.length; index++) {
    const inlineName = tokens[index].split('=', 1)[0]
    if (!allowed.has(inlineName)) continue
    args.push(tokens[index])
    if (valueOptions.has(inlineName) && !tokens[index].includes('=') &&
      tokens[index + 1] && !tokens[index + 1].startsWith('-')) {
      args.push(tokens[++index])
    }
  }
  return args
}

/**
 * Returns the complete runner semantics that can be preserved in a direct isolation command.
 *
 * Any unclassified runner option makes isolation unavailable instead of silently changing execution mode.
 *
 * @param {string} framework framework name
 * @param {string} command detected package command
 * @returns {{
 *   configurationArgs: string[],
 *   environment: Record<string, string>,
 *   hasSourceSelectors: boolean,
 *   mode: string
 * }|undefined}
 * equivalent runner selection
 */
function getIsolationRunnerSelection (framework, command) {
  if (/[<>]/.test(String(command || ''))) return
  const invocation = getFrameworkInvocation(command, framework)
  if (!invocation) return

  const configurationOptions = ISOLATION_CONFIGURATION_OPTIONS[framework]
  const configurationValueOptions = ISOLATION_CONFIGURATION_VALUE_OPTIONS[framework]
  const presentationOptions = ISOLATION_PRESENTATION_OPTIONS[framework]
  const presentationValueOptions = ISOLATION_PRESENTATION_VALUE_OPTIONS[framework]
  if (!configurationOptions || !configurationValueOptions || !presentationOptions || !presentationValueOptions) return
  const environment = getRunnerEnvironment(command, framework)
  for (const token of invocation.tokens.slice(0, invocation.runnerIndex)) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)
    if (assignment && !Object.hasOwn(environment, assignment[1])) return
  }

  const tokens = invocation.tokens.slice(invocation.runnerIndex + 1)
  const expectedSubcommand = {
    cypress: 'run',
    playwright: 'test',
    vitest: 'run',
  }[framework]
  if (tokens[0] === expectedSubcommand) tokens.shift()

  const configurationArgs = []
  let hasSourceSelectors = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) {
      hasSourceSelectors = true
      continue
    }
    const optionName = token.split('=', 1)[0]
    if (framework === 'vitest' && optionName === '--run') continue
    if (isFocusedSourceOption(framework, optionName)) {
      if (!token.includes('=') && tokens[index + 1] && !tokens[index + 1].startsWith('-')) index++
      continue
    }
    if (configurationOptions.has(optionName)) {
      configurationArgs.push(token)
      if (configurationValueOptions.has(optionName) && !token.includes('=')) {
        const value = tokens[index + 1]
        if (!value || value.startsWith('-')) return
        configurationArgs.push(value)
        index++
      }
      continue
    }
    if (presentationOptions.has(optionName)) {
      if (presentationValueOptions.has(optionName) && !token.includes('=')) {
        const value = tokens[index + 1]
        if (!value || value.startsWith('-')) return
        index++
      }
      continue
    }
    return
  }

  return {
    configurationArgs,
    environment,
    hasSourceSelectors,
    mode: getRunnerMode(framework, command),
  }
}

/**
 * Identifies runner arguments that select source files rather than changing runner semantics.
 *
 * @param {string} framework framework name
 * @param {string} optionName runner option
 * @returns {boolean} whether the option selects a source file
 */
function isFocusedSourceOption (framework, optionName) {
  return (framework === 'cypress' && optionName === '--spec') ||
    (framework === 'jest' && optionName === '--runTestsByPath')
}

/**
 * Returns simple test-configuration assignments from a direct framework invocation.
 *
 * @param {string} command detected package command
 * @param {string} framework framework name
 * @returns {Record<string, string>} safe runner environment
 */
function getRunnerEnvironment (command, framework) {
  const invocation = getFrameworkInvocation(command, framework)
  const env = framework === 'cucumber' ? { CUCUMBER_PUBLISH_ENABLED: 'false' } : {}
  if (!invocation) return env
  for (const token of invocation.tokens.slice(0, invocation.runnerIndex)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token)
    if (match && RUNNER_ENVIRONMENT_VARIABLES.has(match[1])) env[match[1]] = match[2]
  }
  return env
}

/**
 * Finds a direct framework executable behind bounded, semantics-free launch wrappers.
 *
 * @param {string} command detected package command
 * @param {string} framework framework name
 * @returns {{runnerIndex: number, tokens: string[]}|undefined} direct invocation
 */
function getFrameworkInvocation (command, framework) {
  if (/[\r\n;&|`]|\$\(/.test(String(command || ''))) return
  const tokens = tokenizeCommand(command)
  const executableName = getRunnerExecutableName(framework)
  const runnerIndex = tokens.findIndex(token => {
    const basename = path.basename(token).replace(/\.cmd$/i, '').toLowerCase()
    return basename === executableName ||
      (framework === 'cucumber' && ['cucumber', 'cucumber.js', 'cucumber-js.js'].includes(basename))
  })
  if (runnerIndex === -1) return

  const prefix = tokens.slice(0, runnerIndex)
  const firstCommand = prefix.find(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  const wrapper = path.basename(firstCommand || '').toLowerCase()
  if (['c8', 'cross-env', 'env', 'npx', 'nyc'].includes(wrapper)) {
    return { runnerIndex, tokens }
  }
  for (const token of prefix) {
    if (['c8', 'cross-env', 'env', 'npx'].includes(path.basename(token).toLowerCase())) continue
    if (path.basename(token).toLowerCase() === 'node') continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=[^;&|`]*$/.test(token)) continue
    return
  }
  return { runnerIndex, tokens }
}

/**
 * Tokenizes the bounded package scripts recognized for direct runner extraction.
 *
 * @param {string} command package script source
 * @returns {string[]} shell-like tokens without surrounding quotes
 */
function tokenizeCommand (command) {
  const tokens = []
  for (const match of String(command || '').matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

/**
 * Narrows a repository-level command to the conventional package that matches the repository identity.
 *
 * @param {string} projectRoot detected command owner
 * @param {string} repositoryRoot repository root
 * @returns {string} representative search root
 */
function findPreferredRepresentativeRoot (projectRoot, repositoryRoot) {
  if (path.resolve(projectRoot) !== path.resolve(repositoryRoot)) return projectRoot

  const repositoryName = normalizeProjectIdentity(path.basename(repositoryRoot))
  for (const containerName of ['packages', 'pkgs', 'modules']) {
    const container = path.join(repositoryRoot, containerName)
    let entries
    try {
      entries = readDirectoryEntries(container, 256)
        .filter(entry => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = path.join(container, entry.name)
      const packageJson = readJson(path.join(candidate, 'package.json'))
      if (normalizeProjectIdentity(packageJson?.name || entry.name) === repositoryName) return candidate
    }
  }
  return projectRoot
}

/**
 * Normalizes a repository or package name for exact identity comparison.
 *
 * @param {string} value repository or package name
 * @returns {string} normalized identity
 */
function normalizeProjectIdentity (value) {
  const unscoped = String(value || '').toLowerCase().replaceAll(/^@[^/]+\//g, '')
  return unscoped.replaceAll(/[^a-z0-9]+/g, '').replaceAll(/js$/g, '')
}

/**
 * Finds a bounded representative test owned by the selected framework.
 *
 * @param {string} root project root
 * @param {string} framework selected framework
 * @param {string} [packageName] selected package name
 * @param {string[]} [searchRoots] statically selected search roots
 * @returns {{candidates: Array<{file: string, requiresLocalSocket: boolean}>, rejected: string[]}}
 * representative selection
 */
function findRepresentativeTestFiles (root, framework, packageName, searchRoots = [root]) {
  const stack = [...searchRoots]
  const candidates = []
  const rejected = []
  const packageRanks = new Map()
  const sourceRanks = new Map()
  let visited = 0
  while (stack.length > 0 && visited < MAX_DISCOVERY_ENTRIES) {
    const directory = stack.pop()
    let entries
    try {
      entries = readDirectoryEntries(directory, MAX_DISCOVERY_ENTRIES - visited)
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      continue
    }
    for (const entry of entries) {
      visited++
      if (['.git', 'node_modules', 'coverage', 'dist', 'build'].includes(entry.name)) continue
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(filename)
        continue
      }
      const testDirectories = path.relative(root, directory).split(path.sep)
      const inTestsDirectory = testDirectories.some(name => ['__tests__', 'test', 'tests'].includes(name))
      const matchesFrameworkConvention = framework === 'cucumber'
        ? cucumberAdapter.isTestFile(entry.name)
        : framework === 'cypress'
          ? cypressAdapter.isTestFile(entry.name, directory, root)
          : framework === 'playwright'
            ? playwrightAdapter.isTestFile(entry.name, directory, root)
            : /^(?:test\.(?:[cm]?[jt]s|[jt]sx)|.+[._-](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx))$/.test(entry.name) ||
              (inTestsDirectory && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name))
      if (matchesFrameworkConvention) {
        const ownershipConflict = getRunnerOwnershipConflict(filename, root, framework)
        if (ownershipConflict) {
          rejected.push(`${path.relative(root, filename)} (${ownershipConflict})`)
        } else {
          const sourceRank = getTestSourceRank(filename, framework, packageName, sourceRanks)
          if (sourceRank.testCount === 0) {
            rejected.push(`${path.relative(root, filename)} (no static test declaration)`)
          } else {
            candidates.push(filename)
          }
        }
      }
    }
  }

  candidates.sort((left, right) => {
    return getTestDirectoryRank(left, root) - getTestDirectoryRank(right, root) ||
      getTestAreaRank(left, root) - getTestAreaRank(right, root) ||
      getExternalRuntimeRank(left, root, framework) - getExternalRuntimeRank(right, root, framework) ||
      getLocalListenerRank(left, root) - getLocalListenerRank(right, root) ||
      getTestSourceRank(left, framework, packageName, sourceRanks).selfPackageImport -
        getTestSourceRank(right, framework, packageName, sourceRanks).selfPackageImport ||
      getTestSourceRank(left, framework, packageName, sourceRanks).testCount -
        getTestSourceRank(right, framework, packageName, sourceRanks).testCount ||
      getIndependentTestProjectRank(left, root, packageRanks) -
        getIndependentTestProjectRank(right, root, packageRanks) ||
      left.localeCompare(right)
  })
  return {
    candidates: candidates.slice(0, MAX_LOCAL_TEST_CANDIDATES).map(file => ({
      file,
      requiresLocalSocket: getLocalListenerRank(file, root) > 0,
    })),
    rejected,
  }
}

/**
 * Restricts Jest candidate discovery to literal roots selected by the package script or static package metadata.
 * Dynamic JavaScript configuration remains subject to the clean preflight instead of being executed during discovery.
 *
 * @param {string} root representative project root
 * @param {string} framework selected framework
 * @param {string} command detected package command
 * @param {object} packageJson representative package metadata
 * @returns {string[]} bounded test search roots
 */
function getRepresentativeSearchRoots (root, framework, command, packageJson) {
  const commandRoots = framework === 'jest'
    ? getJestCommandRoots(root, command)
    : getRunnerCommandRoots(root, framework, command)
  if (commandRoots.length > 0) return commandRoots
  if (framework !== 'jest') return [root]

  const configuredRoots = []
  for (const configuredRoot of Array.isArray(packageJson.jest?.roots) ? packageJson.jest.roots : []) {
    if (typeof configuredRoot !== 'string') continue
    const expanded = configuredRoot.replaceAll('<rootDir>', root)
    const resolved = getContainedDirectory(root, expanded)
    if (resolved) configuredRoots.push(resolved)
    if (configuredRoots.length === MAX_LOCAL_TEST_CANDIDATES) break
  }
  return configuredRoots.length > 0 ? configuredRoots : [root]
}

/**
 * Extracts literal test roots selected by supported runner positional arguments.
 *
 * @param {string} root representative project root
 * @param {string} framework selected framework
 * @param {string} command detected package command
 * @returns {string[]} existing contained test roots
 */
function getRunnerCommandRoots (root, framework, command) {
  const invocation = getFrameworkInvocation(command, framework)
  if (!invocation) return []
  const tokens = invocation.tokens.slice(invocation.runnerIndex + 1)
  const expectedSubcommand = {
    cypress: 'run',
    playwright: 'test',
    vitest: 'run',
  }[framework]
  if (tokens[0] === expectedSubcommand) tokens.shift()

  const valueOptions = new Set([
    ...(ISOLATION_CONFIGURATION_VALUE_OPTIONS[framework] || []),
    ...(ISOLATION_PRESENTATION_VALUE_OPTIONS[framework] || []),
  ])
  const roots = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.startsWith('-')) {
      const optionName = token.split('=', 1)[0]
      if (valueOptions.has(optionName) && !token.includes('=')) index++
      continue
    }
    const resolved = getContainedDirectory(root, token) ||
      getContainedDirectory(root, getStaticSelectorRoot(token))
    if (resolved) roots.push(resolved)
    if (roots.length === MAX_LOCAL_TEST_CANDIDATES) break
  }
  return [...new Set(roots)]
}

/**
 * Returns the static directory prefix selected by a literal file, directory, or glob argument.
 *
 * @param {string} selector runner positional selector
 * @returns {string|undefined} selector directory
 */
function getStaticSelectorRoot (selector) {
  if (typeof selector !== 'string' || /[$`]/.test(selector)) return
  const wildcardIndex = selector.search(/[*?[\]{}]/)
  const literal = wildcardIndex === -1 ? selector : selector.slice(0, wildcardIndex)
  if (!literal) return
  return literal.endsWith('/') || literal.endsWith(path.sep) ? literal : path.dirname(literal)
}

/**
 * Extracts existing literal Jest test roots from a direct runner invocation.
 *
 * @param {string} root representative project root
 * @param {string} command detected package command
 * @returns {string[]} bounded literal test roots
 */
function getJestCommandRoots (root, command) {
  const invocation = getFrameworkInvocation(command, 'jest')
  if (!invocation) return []

  const roots = []
  const tokens = invocation.tokens.slice(invocation.runnerIndex + 1)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const optionName = token.split('=', 1)[0]
    if (optionName === '--roots') {
      if (!token.includes('=')) index++
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[index]
      const resolved = getContainedDirectory(root, value)
      if (resolved) roots.push(resolved)
      continue
    }
    if (JEST_VALUE_OPTIONS.has(optionName)) {
      if (!token.includes('=')) index++
      continue
    }
    if (token.startsWith('-')) continue
    const resolved = getContainedDirectory(root, token)
    if (resolved) roots.push(resolved)
    if (roots.length === MAX_LOCAL_TEST_CANDIDATES) break
  }
  return [...new Set(roots)]
}

/**
 * Resolves one regular directory without following it outside the selected project.
 *
 * @param {string} root selected project root
 * @param {string|undefined} candidate literal path
 * @returns {string|undefined} contained physical directory
 */
function getContainedDirectory (root, candidate) {
  if (typeof candidate !== 'string' || !candidate || /[*?[\]{}$`]/.test(candidate)) return
  const filename = path.resolve(root, candidate)
  try {
    const stat = fs.lstatSync(filename)
    const physicalRoot = fs.realpathSync(root)
    const physicalFilename = fs.realpathSync(filename)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathInside(physicalRoot, physicalFilename)) return
    return filename
  } catch {}
}

/**
 * Returns bounded source signals used to prefer small source-local tests.
 *
 * @param {string} filename test file
 * @param {string} framework selected framework
 * @param {string} [packageName] selected package name
 * @param {Map<string, {selfPackageImport: number, testCount: number}>} cache source signal cache
 * @returns {{selfPackageImport: number, testCount: number}} source signals
 */
function getTestSourceRank (filename, framework, packageName, cache) {
  if (cache.has(filename)) return cache.get(filename)

  const fallback = { selfPackageImport: 1, testCount: 0 }
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return fallback
    const source = fs.readFileSync(filename, 'utf8')
    const code = framework === 'cucumber' ? source : maskJavaScriptNonCode(source)
    const testCount = framework === 'cucumber'
      ? cucumberAdapter.getScenarioCount(source)
      : [...code.matchAll(/\b(?:it|test)(?:\.(?:concurrent|each|only|skip|todo))*\s*\(/g)].length
    const selfPackagePattern = packageName
      ? new RegExp(String.raw`(?:from\s+|require\s*\(\s*)['"]${escapeRegex(packageName)}(?:/[^'"]*)?['"]`)
      : undefined
    const rank = {
      selfPackageImport: selfPackagePattern?.test(maskJavaScriptComments(source)) ? 1 : 0,
      testCount,
    }
    cache.set(filename, rank)
    return rank
  } catch {
    cache.set(filename, fallback)
    return fallback
  }
}

/**
 * Escapes a string for use in a regular expression.
 *
 * @param {string} value literal value
 * @returns {string} escaped value
 */
function escapeRegex (value) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`)
}

/**
 * Identifies when a test candidate imports a different runner API.
 *
 * @param {string} filename candidate test file
 * @param {string} root project root
 * @param {string} framework selected framework
 * @returns {string|undefined} conflict reason
 */
function getRunnerOwnershipConflict (filename, root, framework) {
  let stat
  let physicalFilename
  try {
    stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return 'unsafe or oversized candidate'
    physicalFilename = fs.realpathSync(filename)
    if (!isPathInside(fs.realpathSync(root), physicalFilename)) return 'candidate resolves outside the project'
  } catch {
    return 'candidate could not be read safely'
  }

  let source
  try {
    source = fs.readFileSync(physicalFilename, 'utf8')
  } catch {
    return 'candidate could not be read safely'
  }
  const code = maskJavaScriptNonCode(source)
  source = maskJavaScriptComments(source)
  if (framework === 'playwright' && !hasPlaywrightOwnership(physicalFilename, root, source, code)) {
    return 'does not import @playwright/test directly or through one local fixture'
  }
  const conflicts = {
    jest: [
      [/(?:from\s+|require\s*\(\s*)['"]vitest['"]/, 'imports Vitest'],
      [/(?:from\s+|require\s*\(\s*)['"]node:test['"]/, 'imports node:test'],
      [/(?:from\s+|require\s*\(\s*)['"]@cucumber\/cucumber['"]/, 'imports Cucumber'],
    ],
    mocha: [
      [/(?:from\s+|require\s*\(\s*)['"](?:vitest|@jest\/globals|@cucumber\/cucumber|node:test)['"]/,
        'imports another runner'],
    ],
    vitest: [
      [/(?:from\s+|require\s*\(\s*)['"](?:@jest\/globals|@cucumber\/cucumber|node:test)['"]/,
        'imports another runner'],
    ],
  }[framework] || []
  return conflicts.find(([pattern]) => hasJavaScriptCodeMatch(source, code, pattern))?.[1]
}

/**
 * Checks direct Playwright ownership or one bounded local fixture module.
 *
 * @param {string} filename physical candidate test path
 * @param {string} root project root
 * @param {string} source candidate source with comments masked
 * @param {string} code candidate source with comments and strings masked
 * @returns {boolean} whether the candidate is owned by Playwright Test
 */
function hasPlaywrightOwnership (filename, root, source, code) {
  if (hasJavaScriptCodeMatch(source, code, PLAYWRIGHT_DIRECT_IMPORT_PATTERN)) return true

  const fixtureSpecifiers = getPlaywrightFixtureSpecifiers(source, code)
  for (const specifier of fixtureSpecifiers) {
    const fixture = resolvePlaywrightFixture(filename, root, specifier)
    if (fixture && isPlaywrightFixtureModule(fixture)) return true
  }
  return false
}

/**
 * Finds relative modules from which the candidate statically imports a binding named test.
 *
 * @param {string} source candidate source with comments masked
 * @param {string} code candidate source with comments and strings masked
 * @returns {string[]} bounded relative module specifiers
 */
function getPlaywrightFixtureSpecifiers (source, code) {
  const specifiers = []
  for (const [pattern, commonjs] of [
    [PLAYWRIGHT_LOCAL_ESM_TEST_IMPORT_PATTERN, false],
    [PLAYWRIGHT_LOCAL_CJS_TEST_IMPORT_PATTERN, true],
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (code[match.index] === ' ' || !importsNamedTest(match[1], commonjs)) continue
      if (!specifiers.includes(match[3])) specifiers.push(match[3])
      if (specifiers.length === 8) return specifiers
    }
  }
  return specifiers
}

/**
 * Checks whether a static named-import list imports a binding named test.
 *
 * @param {string} bindings named import or destructuring source
 * @param {boolean} commonjs whether the bindings use object-destructuring syntax
 * @returns {boolean} whether test is imported
 */
function importsNamedTest (bindings, commonjs) {
  for (const binding of bindings.split(',')) {
    const normalized = binding.trim().replace(/^type\s+/, '')
    const imported = commonjs ? normalized.split(':', 1)[0] : normalized.split(/\s+as\s+/, 1)[0]
    if (imported.trim() === 'test') return true
  }
  return false
}

/**
 * Resolves one regular, repository-contained JavaScript or TypeScript fixture module.
 *
 * @param {string} importer physical importing test path
 * @param {string} root project root
 * @param {string} specifier relative module specifier
 * @returns {string|undefined} physical fixture path
 */
function resolvePlaywrightFixture (importer, root, specifier) {
  if (/[*?[\]{}$`#]/.test(specifier)) return
  const base = path.resolve(path.dirname(importer), specifier)
  const extension = path.extname(base)
  const candidates = extension
    ? (PLAYWRIGHT_FIXTURE_EXTENSIONS.includes(extension) ? [base] : [])
    : [
        ...PLAYWRIGHT_FIXTURE_EXTENSIONS.map(candidateExtension => `${base}${candidateExtension}`),
        ...PLAYWRIGHT_FIXTURE_EXTENSIONS.map(candidateExtension => path.join(base, `index${candidateExtension}`)),
      ]

  let physicalRoot
  try {
    physicalRoot = fs.realpathSync(root)
  } catch {
    return
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate)
      const physicalCandidate = fs.realpathSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
        !isPathInside(physicalRoot, physicalCandidate)) {
        continue
      }
      return physicalCandidate
    } catch {}
  }
}

/**
 * Checks that a one-hop fixture both imports Playwright Test and exports a binding named test.
 *
 * @param {string} filename physical fixture path
 * @returns {boolean} whether the fixture exposes a Playwright-owned test binding
 */
function isPlaywrightFixtureModule (filename) {
  let source
  try {
    source = fs.readFileSync(filename, 'utf8')
  } catch {
    return false
  }
  const code = maskJavaScriptNonCode(source)
  source = maskJavaScriptComments(source)
  if (!hasJavaScriptCodeMatch(source, code, PLAYWRIGHT_DIRECT_IMPORT_PATTERN)) return false
  if (hasJavaScriptCodeMatch(
    source,
    code,
    /\bexport\s+(?:const|let|var|function|class)\s+test\b|\b(?:module\.)?exports\.test\s*=/
  )) {
    return true
  }
  for (const match of source.matchAll(PLAYWRIGHT_NAMED_EXPORT_PATTERN)) {
    if (code[match.index] !== ' ' && exportsNamedTest(match[1], false)) return true
  }
  for (const match of source.matchAll(PLAYWRIGHT_COMMONJS_EXPORT_PATTERN)) {
    if (code[match.index] !== ' ' && exportsNamedTest(match[1], true)) return true
  }
  return false
}

/**
 * Checks whether an export list exposes a binding with the public name test.
 *
 * @param {string} bindings named export or object-literal source
 * @param {boolean} commonjs whether the bindings use object-literal syntax
 * @returns {boolean} whether test is exported
 */
function exportsNamedTest (bindings, commonjs) {
  for (const binding of bindings.split(',')) {
    const normalized = binding.trim()
    const exported = commonjs
      ? normalized.split(':', 1)[0]
      : (normalized.split(/\s+as\s+/)[1] || normalized.split(/\s+as\s+/)[0])
    if (exported.trim() === 'test') return true
  }
  return false
}

/**
 * Checks whether a source pattern starts in executable code rather than a comment or string.
 *
 * @param {string} source source with comments masked
 * @param {string} code source with comments and strings masked
 * @param {RegExp} pattern candidate source pattern
 * @returns {boolean} whether the pattern starts in executable code
 */
function hasJavaScriptCodeMatch (source, code, pattern) {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (const match of source.matchAll(globalPattern)) {
    if (code[match.index] !== ' ') return true
  }
  return false
}
/**
 * Ranks established test directories ahead of source-adjacent test-looking files.
 *
 * @param {string} filename candidate test file
 * @param {string} root detected project root
 * @returns {number} directory preference rank
 */
function getTestDirectoryRank (filename, root) {
  const directories = path.relative(root, path.dirname(filename)).split(path.sep)
  if (directories.includes('__tests__')) return 0
  if (directories.some(directory => directory === 'test' || directory === 'tests')) return 1
  return 2
}

/**
 * Ranks conventional project areas ahead of auxiliary repository trees.
 *
 * @param {string} filename candidate test file
 * @param {string} root detected project root
 * @returns {number} project area preference rank
 */
function getTestAreaRank (filename, root) {
  const [topLevelDirectory] = path.relative(root, filename).split(path.sep)
  return ['packages', 'src', 'test', 'tests'].includes(topLevelDirectory) ? 0 : 1
}

/**
 * Ranks tests that visibly open a local listener behind process-local unit tests.
 *
 * @param {string} filename candidate test file
 * @param {string} root detected project root
 * @returns {number} local-listener preference rank
 */
function getLocalListenerRank (filename, root) {
  let stat
  let physicalFilename
  try {
    stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return 1
    physicalFilename = fs.realpathSync(filename)
    if (!isPathInside(fs.realpathSync(root), physicalFilename)) return 1
  } catch {
    return 1
  }

  try {
    const source = fs.readFileSync(physicalFilename, 'utf8')
    return LOCAL_SOCKET_API_PATTERN.test(source) || LOCAL_SOCKET_REQUEST_PATTERN.test(source) ? 1 : 0
  } catch {
    return 1
  }
}

/**
 * Ranks Cypress specs that visibly depend on an application or network service behind isolated specs.
 *
 * @param {string} filename candidate test file
 * @param {string} root detected project root
 * @param {string} framework selected framework
 * @returns {number} external runtime requirement rank
 */
function getExternalRuntimeRank (filename, root, framework) {
  if (!['cypress', 'playwright'].includes(framework)) return 0

  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return 1
    const physicalFilename = fs.realpathSync(filename)
    if (!isPathInside(fs.realpathSync(root), physicalFilename)) return 1
    const source = maskJavaScriptNonCode(fs.readFileSync(physicalFilename, 'utf8'))
    const pattern = framework === 'cypress'
      ? /\bcy\.(?:visit|request|intercept)\s*\(/
      : /\b(?:browser|browserName|context|page|request)\b/
    return pattern.test(source) ? 1 : 0
  } catch {
    return 1
  }
}

/**
 * Ranks independently tested nested packages behind tests owned by the detected root command.
 *
 * @param {string} filename candidate test file
 * @param {string} root detected project root
 * @param {Map<string, number>} cache package-directory rank cache
 * @returns {number} independent test project rank
 */
function getIndependentTestProjectRank (filename, root, cache) {
  let directory = path.dirname(filename)
  while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
    if (cache.has(directory)) return cache.get(directory)

    const packageJson = readJson(path.join(directory, 'package.json'))
    if (packageJson) {
      const rank = typeof packageJson.scripts?.test === 'string' ? 1 : 0
      cache.set(directory, rank)
      return rank
    }
    directory = path.dirname(directory)
  }
  return 0
}

function getTestExtension (filename) {
  if (filename.endsWith('.feature')) return '.feature'
  if (/\.cy\.[cm]?[jt]sx?$/.test(filename)) return cypressAdapter.getTestExtension(filename)
  if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(filename)) return playwrightAdapter.getTestExtension(filename)
  const match = /((?:[.-](?:test|spec))\.(?:[cm]?[jt]s|[jt]sx))$/.exec(filename)
  return match?.[1] || '.test.js'
}

function findConfigFiles (root, framework, detectedCommand) {
  const patterns = {
    cucumber: cucumberAdapter.CONFIG_PATTERN,
    cypress: cypressAdapter.CONFIG_PATTERN,
    jest: /^jest\.config\./,
    mocha: /^\.mocharc\./,
    playwright: playwrightAdapter.CONFIG_PATTERN,
    vitest: /^(?:vite|vitest)\.config\./,
  }[framework]
  if (!patterns) return []
  let configFiles = []
  try {
    configFiles = readDirectoryEntries(root, MAX_DIRECTORY_ENTRIES).map(entry => entry.name)
      .filter(filename => patterns.test(filename))
      .map(filename => path.join(root, filename))
  } catch {}

  if (framework !== 'jest') return configFiles
  const runner = getProjectOwnedNodeRunner(detectedCommand, root)
  if (!runner) return configFiles

  try {
    const runnerConfigs = readDirectoryEntries(path.dirname(runner), MAX_DIRECTORY_ENTRIES).map(entry => entry.name)
      .filter(isJestRunnerConfigFile)
      .sort((left, right) => {
        return Number(!/^config\.base\./.test(left)) - Number(!/^config\.base\./.test(right)) ||
          left.localeCompare(right)
      })
      .slice(0, 16)
      .map(filename => path.join(path.dirname(runner), filename))
    configFiles.push(...runnerConfigs)
  } catch {}
  return [...new Set(configFiles)]
}

/**
 * Reports whether a project-owned Jest runner file follows its config naming convention.
 *
 * @param {string} filename candidate filename
 * @returns {boolean} whether the filename is a runner config
 */
function isJestRunnerConfigFile (filename) {
  const extension = JEST_RUNNER_CONFIG_EXTENSION_PATTERN.exec(filename)?.[0]
  if (!extension) return false

  const basename = filename.slice(0, -extension.length)
  if (basename === 'config') return true
  if (!basename.startsWith('config')) return false

  const suffix = basename.slice('config'.length)
  if (suffix.length < 2 || !['.', '-'].includes(suffix[0])) return false
  return JEST_RUNNER_CONFIG_SUFFIX_PATTERN.test(suffix) && !suffix.includes('..') && !suffix.endsWith('.')
}

/**
 * Resolves the package.json associated with a framework detection.
 *
 * @param {string} repositoryRoot repository root
 * @param {string[]} locations detected evidence paths
 * @returns {string} absolute package.json path
 */
function getDetectionPackageJson (repositoryRoot, locations = []) {
  const location = locations.find(value => path.basename(value) === 'package.json')
  return path.resolve(repositoryRoot, location || 'package.json')
}

/**
 * Resolves a detected runner version without executing repository code.
 *
 * @param {string} framework detected framework package name
 * @param {string} projectRoot detected project root
 * @param {object} packageJson detected project package.json
 * @returns {string|null} installed or declared framework version
 */
function getInstalledFrameworkVersion (framework, projectRoot, packageJson) {
  if (framework === 'node-test') return process.version
  try {
    const filename = require.resolve(`${framework}/package.json`, { paths: [projectRoot] })
    return readJson(filename)?.version || null
  } catch {}

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (typeof packageJson[field]?.[framework] === 'string') return packageJson[field][framework]
  }
  return null
}

function discoverCiFiles (root) {
  const found = []
  for (const relativePath of CI_PATHS) {
    const filename = path.join(root, relativePath)
    if (!fs.existsSync(filename)) continue
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      const entries = readDirectoryEntries(filename, MAX_CI_DIRECTORY_ENTRIES)
        .map(entry => entry.name)
        .sort()
      for (const entry of entries) {
        if (/\.ya?ml$/.test(entry)) found.push(path.posix.join(relativePath, entry))
      }
    } else {
      found.push(relativePath)
    }
  }
  const readableFiles = found.map(relativePath => ({
    content: readCiFile(root, relativePath),
    relativePath,
  })).filter(file => file.content !== undefined)
  const reviewTargets = rankCiReviewTargets(readableFiles)
  const hasInitialization = readableFiles.some(file => /dd-trace[\\/]ci[\\/]init/.test(file.content))
  const initialization = {
    status: 'unknown',
    evidence: readableFiles.length === 0
      ? []
      : [hasInitialization
          ? 'The bounded scan found a dd-trace/ci/init reference, but it did not resolve a specific test job or ' +
            'wrapper chain.'
          : `The bounded scan found no direct dd-trace/ci/init reference in ${readableFiles.length} discovered CI ` +
            'configuration file(s). Reusable workflows, includes, inherited configuration, and wrappers remain ' +
            'unresolved.'],
  }
  return {
    searched: [...CI_PATHS],
    found,
    reviewTargets,
    reviewRequired: readableFiles.length > 0,
    initialization,
    method: 'deterministic-known-ci-paths',
    warnings: [],
    notes: [
      'Generated by --init-manifest; inspect CI review targets in order and stop after recording the first matching ' +
        'test step for each runnable framework. A literal scan alone cannot confirm CI initialization.',
    ],
  }
}

/**
 * Reads one bounded, repository-contained CI configuration file.
 *
 * @param {string} root repository root
 * @param {string} relativePath repository-relative CI path
 * @returns {string|undefined} file content when it is safe and bounded
 */
function readCiFile (root, relativePath) {
  const filename = path.join(root, relativePath)
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CI_FILE_BYTES) return
    const physicalRoot = fs.realpathSync(root)
    const physicalFile = fs.realpathSync(filename)
    if (!isPathInside(physicalRoot, physicalFile)) return
    return fs.readFileSync(physicalFile, 'utf8')
  } catch {}
}

/**
 * Ranks the small set of CI files most likely to contain the representative test job.
 *
 * @param {Array<{content: string, relativePath: string}>} files bounded CI files
 * @returns {string[]} repository-relative review targets
 */
function rankCiReviewTargets (files) {
  return files.map(file => {
    const filename = path.basename(file.relativePath).toLowerCase()
    const content = file.content.toLowerCase()
    let score = 0
    if (/^tests?\.ya?ml$/.test(filename)) score += 30
    if (/(?:^|[_-])(test|tests|ci)(?:[_-]|\.|$)/.test(filename)) score += 30
    if (/runtime.*test|test.*runtime/.test(filename)) score += 15
    if (/\brun\s*:\s*[^\n]*(?:cucumber(?:-js)?|cypress|jest|mocha|playwright|vitest|(?:npm|pnpm|yarn)[^\n]*test)/
      .test(content)) score += 40
    if (/(?:cucumber(?:-js)?|cypress|jest|mocha|playwright|vitest|\btest\b)/.test(content)) score += 10
    if (/codegen/.test(filename)) score -= 15
    if (/(?:release|publish|deploy|cleanup|stale|label|notify|lint)/.test(filename)) score -= 30
    return { ...file, score }
  }).filter(file => file.score > 0)
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
    .slice(0, MAX_CI_REVIEW_TARGETS)
    .map(file => file.relativePath)
}

function detectPackageManager (root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function detectWorkspaceManager (root) {
  if (fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) return 'pnpm'
  const packageJson = readJson(path.join(root, 'package.json'))
  return packageJson?.workspaces ? detectPackageManager(root) : 'none'
}

function getManifestOs (platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin' || platform === 'linux') return platform
  return 'unknown'
}

function findYarnRelease (root) {
  const directory = path.join(root, '.yarn', 'releases')
  try {
    const physicalRoot = fs.realpathSync(root)
    const releases = readDirectoryEntries(directory, 64)
      .map(entry => entry.name)
      .filter(filename => /^yarn-.+\.cjs$/.test(filename))
      .sort()
    for (const release of releases) {
      const filename = path.join(directory, release)
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const physicalFile = fs.realpathSync(filename)
      if (isPathInside(physicalRoot, physicalFile)) return filename
    }
  } catch {}
}

/**
 * Reads at most the approved number of entries without first allocating the whole directory.
 *
 * @param {string} directory directory to inspect
 * @param {number} limit maximum entries to return
 * @returns {fs.Dirent[]} bounded directory entries
 */
function readDirectoryEntries (directory, limit) {
  const entries = []
  const handle = fs.opendirSync(directory)
  try {
    while (entries.length < limit) {
      const entry = handle.readSync()
      if (!entry) break
      entries.push(entry)
    }
  } finally {
    handle.closeSync()
  }
  return entries
}

function getProjectIdentifier (packageJson, projectRoot, repositoryRoot) {
  if (packageJson.name) return packageJson.name.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
  if (path.resolve(projectRoot) === path.resolve(repositoryRoot)) {
    return path.basename(repositoryRoot).replaceAll(/[^A-Za-z0-9._-]+/g, '-')
  }
  return (path.relative(repositoryRoot, projectRoot) || 'root').replaceAll(path.sep, '-')
}

function isPathInside (root, filename) {
  const relative = path.relative(root, filename)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function readJson (filename) {
  let descriptor
  try {
    const entry = fs.lstatSync(filename)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_JSON_FILE_BYTES) return
    descriptor = fs.openSync(filename, 'r')
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_JSON_FILE_BYTES) return
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'))
  } catch {} finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

module.exports = { createManifestScaffold }
