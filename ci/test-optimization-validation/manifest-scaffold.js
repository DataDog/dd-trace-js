'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')

const { runDiagnosis } = require('../diagnose')
const { getCommandSuitabilityError } = require('./command-suitability')
const cucumberAdapter = require('./framework-adapters/cucumber')
const cypressAdapter = require('./framework-adapters/cypress')
const playwrightAdapter = require('./framework-adapters/playwright')
const { GENERATED_SCENARIOS, getGeneratedTestContent } = require('./generated-test-contract')
const { validateManifest } = require('./manifest-schema')
const { maskJavaScriptComments, maskJavaScriptNonCode } = require('./source-text')

const SUPPORTED_SCAFFOLD_FRAMEWORKS = new Set(['cucumber', 'cypress', 'jest', 'mocha', 'playwright', 'vitest'])
const MAX_LOCAL_TEST_CANDIDATES = 3
const MAX_REPRESENTATIVE_TESTS = 150
const MAX_CI_FILE_BYTES = 512 * 1024
const MAX_CI_REVIEW_TARGETS = 3
const JEST_RUNNER_CONFIG_EXTENSION_PATTERN = /\.[cm]?[jt]s$/
const JEST_RUNNER_CONFIG_SUFFIX_PATTERN = /^[A-Za-z0-9_.-]+$/
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
      ...selected.map(framework => buildFrameworkScaffold(repositoryRoot, framework, ciDiscovery)),
      ...detectedNotRunnable.map(framework => buildDetectedNotRunnableFrameworkScaffold(repositoryRoot, framework)),
      ...unsupported.map(framework => buildUnsupportedFrameworkScaffold(repositoryRoot, framework)),
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
 * @returns {object} manifest framework entry
 */
function buildDetectedNotRunnableFrameworkScaffold (repositoryRoot, detection) {
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
    notes: [reason],
  }
}

/**
 * Builds a diagnostic-only entry for a detected runner the validator cannot execute.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} detection static framework detection
 * @returns {object} non-runnable framework manifest entry
 */
function buildUnsupportedFrameworkScaffold (repositoryRoot, detection) {
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
    notes: [
      `${detection.name} was detected at ${detection.locations.join(', ') || 'an unknown location'}, but is not ` +
        'supported by this Test Optimization validator.',
    ],
  }
}

function buildFrameworkScaffold (repositoryRoot, detection, ciDiscovery) {
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
      notes: [
        `${detection.name} was detected and is supported by dd-trace, but this local validator has no live ` +
          `${detection.name} adapter. Live validation currently supports Cucumber, Cypress, Jest, Mocha, ` +
          'Playwright, and Vitest.',
      ],
    }
  }

  const runner = tryResolveRunner(framework, projectRoot)
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
      notes: [
        `${detection.name} was detected, but its executable package could not be resolved from ` +
          `${path.relative(repositoryRoot, projectRoot) || 'the repository root'}.${setupDetail}`,
      ],
    }
  }
  const scriptName = getPackageScriptName(packageJson, detection.command)
  const preserveProjectWrapper = framework !== 'cypress' &&
    Boolean(scriptName) && !usesFrameworkRunner(detection.command, framework)
  const packageScriptSetupBlocker = preserveProjectWrapper
    ? getPackageScriptSetupBlocker({
      command: detection.command,
      packageJson,
      projectRoot,
      repositoryRoot,
      scriptName,
    })
    : undefined
  if (packageScriptSetupBlocker) {
    return {
      id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
      framework,
      frameworkVersion: detection.version,
      language: 'unknown',
      status: 'requires_manual_setup',
      supportLevel: 'validator_supported',
      project: getProject({
        detectedCommand: detection.command,
        framework,
        packageJson,
        packageJsonPath,
        projectRoot,
        repositoryRoot,
      }),
      notes: [packageScriptSetupBlocker],
    }
  }
  const projectOwnedRunner = preserveProjectWrapper
    ? getProjectOwnedNodeRunner(detection.command, projectRoot)
    : undefined
  const baseCommand = buildExistingCommand({
    framework,
    detectedCommand: detection.command,
    projectOwnedRunner,
    projectRoot,
    repositoryRoot,
    runner,
    scriptName,
    preserveProjectWrapper,
  })
  const representativeRoot = findPreferredRepresentativeRoot(projectRoot, repositoryRoot)
  const representativePackage = readJson(path.join(representativeRoot, 'package.json')) || packageJson
  const representativeSelection = findRepresentativeTestFiles(
    representativeRoot,
    framework,
    representativePackage.name
  )
  const project = getProject({
    detectedCommand: detection.command,
    framework,
    packageJson,
    packageJsonPath,
    projectRoot,
    repositoryRoot,
  })
  const localTestCandidates = representativeSelection.candidates.map(({ file }) => ({
    command: buildFocusedCommand(
      baseCommand,
      framework,
      file,
      Boolean(scriptName),
      preserveProjectWrapper
    ),
    maxTestCount: MAX_REPRESENTATIVE_TESTS,
    sourceFile: file,
  })).filter(candidate => !getCommandSuitabilityError({
    command: candidate.command,
    framework: { framework, project },
    label: 'the selected test command',
    repositoryRoot,
  }))
  const representative = localTestCandidates[0]?.sourceFile
  if (!representative) {
    const reason = representativeSelection.rejected.length > 0
      ? `Candidate test files could not be selected safely: ${representativeSelection.rejected.slice(0, 3).join(', ')}.`
      : 'No bounded representative test file could be selected from the detected project.'
    return {
      id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
      framework,
      frameworkVersion: detection.version,
      language: 'unknown',
      status: 'requires_manual_setup',
      supportLevel: 'validator_supported',
      project,
      notes: [`${reason} Select a real ${detection.name} test before live validation.`],
    }
  }
  const command = localTestCandidates[0].command

  const generatedTestStrategy = buildGeneratedTestStrategy({
    baseCommand: preserveProjectWrapper ? baseCommand : undefined,
    framework,
    packageJson,
    projectRoot,
    representative,
    runner,
    runnerEnvironment: getRunnerEnvironment(detection.command, framework),
    runnerConfigurationArgs: preserveProjectWrapper
      ? []
      : getRunnerConfigurationArgs(framework, detection.command),
  })
  const ciWiring = buildCiWiringScaffold(repositoryRoot, ciDiscovery)

  return {
    id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
    framework,
    frameworkVersion: detection.version,
    language: /\.tsx?$/.test(generatedTestStrategy.fileExtension) ? 'typescript' : 'javascript',
    status: 'runnable',
    supportLevel: 'validator_supported',
    localSocketRequired: representativeSelection.candidates.every(candidate => candidate.requiresLocalSocket),
    project,
    setup: { commands: [], services: [] },
    existingTestCommand: command,
    localTestCandidates,
    preflight: { status: 'pending', maxTestCount: MAX_REPRESENTATIVE_TESTS },
    ciWiring,
    generatedTestStrategy,
    notes: [
      representative
        ? `Generated by --init-manifest with up to ${MAX_LOCAL_TEST_CANDIDATES} bounded whole-file candidates, ` +
          `starting with ${path.relative(repositoryRoot, representative)}.`
        : 'Generated by --init-manifest. Select a bounded existing test file if no candidate passes preflight.',
      projectOwnedRunner
        ? `Basic Reporting preserves project-owned runner ${path.relative(projectRoot, projectOwnedRunner)}.`
        : preserveProjectWrapper
          ? `Basic Reporting preserves package script ${scriptName} because it contains runner flags or custom ` +
            'wrapper logic.'
          : `Basic Reporting invokes the installed ${framework} runner directly; record the CI wrapper separately.`,
      ...(representativeSelection.candidates.every(candidate => candidate.requiresLocalSocket)
        ? ['Every safe representative test found appears to open a local listener. The approved test command may ' +
            'be blocked in an execution environment that denies project localhost sockets. If so, request normal ' +
            'host/test permission only for the exact checksum-approved validator command.']
        : []),
      'CI command selection still requires repository-specific evidence.',
    ],
  }
}

/**
 * Builds bounded static CI evidence for a runnable framework.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} static CI wiring evidence
 */
function buildCiWiringScaffold (repositoryRoot, ciDiscovery) {
  const reviewTarget = ciDiscovery.reviewTargets[0]
  const initialization = {
    status: ciDiscovery.initialization.status,
    evidence: [...ciDiscovery.initialization.evidence],
  }
  if (initialization.status !== 'not_configured') {
    return {
      diagnosis: 'Inspect the first matching CI review target and record the selected test job, command, ' +
        'environment, and Test Optimization initialization evidence.',
      initialization,
    }
  }

  const ciWiring = {
    diagnosis: 'The bounded scaffold inspected every discovered CI configuration file and found no ' +
      'dd-trace/ci/init preload. No additional CI-file review is required for this static conclusion.',
    initialization,
  }
  if (reviewTarget) {
    ciWiring.provider = getCiProvider(reviewTarget)
    ciWiring.configFile = path.join(repositoryRoot, reviewTarget)
    ciWiring.whySelected = `${reviewTarget} is the highest-ranked discovered test workflow. The missing ` +
      'initialization conclusion applies to every discovered CI configuration file.'
  }
  return ciWiring
}

/**
 * Identifies a CI provider from a known repository-relative configuration path.
 *
 * @param {string} relativePath repository-relative CI path
 * @returns {string} provider name
 */
function getCiProvider (relativePath) {
  if (relativePath.startsWith('.github/workflows/')) return 'github-actions'
  if (relativePath.startsWith('.circleci/')) return 'circleci'
  if (relativePath.startsWith('.buildkite/')) return 'buildkite'
  if (relativePath.startsWith('.gitlab-ci.')) return 'gitlab-ci'
  if (relativePath.startsWith('azure-pipelines.')) return 'azure-pipelines'
  if (relativePath.startsWith('bitbucket-pipelines.')) return 'bitbucket-pipelines'
  if (relativePath === 'Jenkinsfile') return 'jenkins'
  return 'unknown'
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
  projectOwnedRunner,
  repositoryRoot,
  runner,
  scriptName,
  preserveProjectWrapper,
}) {
  const packageManager = preserveProjectWrapper && !projectOwnedRunner
    ? detectPackageManager(repositoryRoot)
    : undefined
  const argv = projectOwnedRunner
    ? [process.execPath, projectOwnedRunner]
    : preserveProjectWrapper
      ? getPackageScriptArgv(packageManager, scriptName, repositoryRoot)
      : getDirectRunnerArgv(framework, runner, detectedCommand)
  return {
    description: projectOwnedRunner
      ? `Detected project test runner ${path.relative(projectRoot, projectOwnedRunner)}`
      : preserveProjectWrapper
        ? `Detected custom package script ${scriptName}`
        : `Direct installed ${framework} runner for local capability validation`,
    cwd: projectRoot,
    argv,
    env: preserveProjectWrapper ? {} : getRunnerEnvironment(detectedCommand, framework),
    requiredEnvVars: [],
    timeoutMs: 300_000,
    usesShell: false,
  }
}

function buildGeneratedTestStrategy ({
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
  const definitions = getGeneratedDefinitions({ framework, convention, moduleSystem })
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
        ? buildFocusedCommand(
          baseCommand,
          framework,
          definition.file,
          true,
          true,
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
        : [path.join(path.dirname(definitions.find(definition => definition.id === 'atr-fail-once').file),
            '.dd-test-optimization-validation-atr-state')]),
    ],
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

function getGeneratedDefinitions ({ framework, convention, moduleSystem }) {
  return Object.entries(GENERATED_SCENARIOS).map(([id, definition]) => {
    const prefix = `dd-test-optimization-validation-${id}`
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
          : path.join(path.dirname(generatedFile), '.dd-test-optimization-validation-atr-state'),
      }),
    }
  })
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
function tryResolveRunner (framework, projectRoot) {
  try {
    return resolveRunner(framework, projectRoot)
  } catch {}
}

function resolveRunner (framework, projectRoot) {
  const packageName = getRunnerPackageName(framework)
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [projectRoot] })
  const packageJson = readJson(packageJsonPath)
  const binName = getRunnerExecutableName(framework)
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin[binName]
  return path.resolve(path.dirname(packageJsonPath), bin)
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
 * Reports whether a package script is a plain framework invocation that can be narrowed directly.
 *
 * @param {string} command detected framework command
 * @param {string} framework detected test framework
 * @returns {boolean} whether the command contains no project-owned runner flags
 */
function usesFrameworkRunner (command, framework) {
  return getFrameworkInvocation(command, framework) !== undefined
}

/**
 * Builds a direct local runner invocation while retaining bounded configuration flags.
 *
 * @param {string} framework framework name
 * @param {string} runner resolved runner entrypoint
 * @param {string} detectedCommand detected package command
 * @returns {string[]} command arguments
 */
function getDirectRunnerArgv (framework, runner, detectedCommand) {
  return [
    process.execPath,
    runner,
    ...(['cypress', 'vitest'].includes(framework) ? ['run'] : framework === 'playwright' ? ['test'] : []),
    ...getRunnerConfigurationArgs(framework, detectedCommand),
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
  const allowed = {
    cucumber: new Set([
      '--config',
      '--import',
      '--language',
      '--loader',
      '--profile',
      '--require',
      '--require-module',
      '--world-parameters',
    ]),
    cypress: new Set(['--component', '--config-file', '--e2e']),
    jest: new Set(['--config', '--env', '--runner', '--testEnvironment']),
    mocha: new Set([
      '-r',
      '-t',
      '-u',
      '--check-leaks',
      '--config',
      '--enable-source-maps',
      '--extension',
      '--loader',
      '--require',
      '--timeout',
      '--ui',
    ]),
    playwright: new Set(['-c', '--config', '--project']),
    vitest: new Set(['--config', '--environment', '--project', '--root']),
  }[framework]
  if (!allowed) return []
  const valueOptions = {
    cucumber: new Set([
      '--config',
      '--import',
      '--language',
      '--loader',
      '--profile',
      '--require',
      '--require-module',
      '--world-parameters',
    ]),
    cypress: new Set(['--config-file']),
    jest: new Set(['--config', '--env', '--runner', '--testEnvironment']),
    mocha: new Set(['-r', '-t', '-u', '--config', '--extension', '--loader', '--require', '--timeout', '--ui']),
    playwright: new Set(['-c', '--config', '--project']),
    vitest: new Set(['--config', '--environment', '--project', '--root']),
  }[framework]

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
    const match = /^(BABEL_ENV|CI|NODE_ENV|TS_NODE_PROJECT|TZ)=(.*)$/.exec(token)
    if (match) env[match[1]] = match[2]
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
  const tokens = tokenizeCommand(command)
  const executableName = getRunnerExecutableName(framework)
  const runnerIndex = tokens.findIndex(token => {
    const basename = path.basename(token).replace(/\.cmd$/i, '').toLowerCase()
    return basename === executableName || (framework === 'cucumber' && basename === 'cucumber')
  })
  if (runnerIndex === -1) return

  for (const token of tokens.slice(0, runnerIndex)) {
    if (['c8', 'cross-env', 'env', 'npx'].includes(path.basename(token).toLowerCase())) continue
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
 * Identifies package scripts that would install dependencies or remove files before the selected runner starts.
 *
 * @param {object} input package-script inputs
 * @param {string} input.command selected package script source
 * @param {object} input.packageJson selected package metadata
 * @param {string} input.projectRoot selected project root
 * @param {string} input.repositoryRoot repository root
 * @param {string} input.scriptName selected package script name
 * @returns {string|undefined} customer-facing setup blocker
 */
function getPackageScriptSetupBlocker ({ command, packageJson, projectRoot, repositoryRoot, scriptName }) {
  const scripts = [packageJson.scripts?.[`pre${scriptName}`], packageJson.scripts?.[scriptName]]
  const nested = /^cd\s+([^\s;&|]+)\s*&&\s*(?:npm\s+)?(?:run\s+)?(test)\b/.exec(String(command || '').trim())
  if (nested) {
    const nestedRoot = path.resolve(projectRoot, nested[1])
    if (isPathInside(repositoryRoot, nestedRoot)) {
      const nestedPackageJson = readJson(path.join(nestedRoot, 'package.json'))
      scripts.push(nestedPackageJson?.scripts?.pretest, nestedPackageJson?.scripts?.test)
    }
  }
  const setup = scripts.find(script => typeof script === 'string' && hasMaterialPackageScriptSetup(script))
  if (!setup) return

  return 'The selected package script performs a dependency install or recursive file removal before the test ' +
    `runner starts: ${JSON.stringify(setup)}. That setup is not included in the bounded local validation plan. ` +
    'Review and approve the setup separately, or use an already-installed direct runner command.'
}

/**
 * Reports whether a lifecycle script contains material install or recursive-delete behavior.
 *
 * @param {string} script package script source
 * @returns {boolean} whether material setup is present
 */
function hasMaterialPackageScriptSetup (script) {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:ci|install)\b/.test(script) ||
    /(?:^|[;&|]\s*)(?:rm\s+-[a-z]*r[a-z]*f?|rimraf)\b/.test(script)
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
      entries = fs.readdirSync(container, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 256)
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
 * @returns {{candidates: Array<{file: string, requiresLocalSocket: boolean}>, rejected: string[]}}
 * representative selection
 */
function findRepresentativeTestFiles (root, framework, packageName) {
  const stack = [root]
  const candidates = []
  const rejected = []
  const packageRanks = new Map()
  const sourceRanks = new Map()
  let visited = 0
  while (stack.length > 0 && visited < 5000) {
    const directory = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (['.git', 'node_modules', 'coverage', 'dist', 'build'].includes(entry.name)) continue
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(filename)
        continue
      }
      visited++
      const testDirectories = path.relative(root, directory).split(path.sep)
      const inTestsDirectory = testDirectories.some(name => ['__tests__', 'test', 'tests'].includes(name))
      const matchesFrameworkConvention = framework === 'cucumber'
        ? cucumberAdapter.isTestFile(entry.name)
        : framework === 'cypress'
          ? cypressAdapter.isTestFile(entry.name, directory, root)
          : framework === 'playwright'
            ? playwrightAdapter.isTestFile(entry.name, directory, root)
            : /^(?:test\.(?:[cm]?[jt]s|[jt]sx)|.+[.-](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx))$/.test(entry.name) ||
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
    return /(?:\bsupertest\b|\bcreateServer\s*\(|\.listen\s*\(|(?:from\s+|require\s*\(\s*)['"]node:(?:http|https|net)['"]|\bcy\.(?:visit|request)\s*\(\s*['"](?:\/|https?:\/\/(?:localhost|127\.0\.0\.1)))/
      .test(source)
      ? 1
      : 0
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
    configFiles = fs.readdirSync(root)
      .filter(filename => patterns.test(filename))
      .map(filename => path.join(root, filename))
  } catch {}

  if (framework !== 'jest') return configFiles
  const runner = getProjectOwnedNodeRunner(detectedCommand, root)
  if (!runner) return configFiles

  try {
    const runnerConfigs = fs.readdirSync(path.dirname(runner))
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
      for (const entry of fs.readdirSync(filename).sort()) {
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
  const initialization = readableFiles.length > 0 && !hasInitialization
    ? {
        status: 'not_configured',
        evidence: [
          `The scaffold inspected ${readableFiles.length} discovered CI configuration file(s) and found no ` +
            'reference to dd-trace/ci/init.',
        ],
      }
    : {
        status: 'unknown',
        evidence: [],
      }
  return {
    searched: [...CI_PATHS],
    found,
    reviewTargets,
    reviewRequired: initialization.status !== 'not_configured',
    initialization,
    method: 'deterministic-known-ci-paths',
    warnings: [],
    notes: [
      initialization.status === 'not_configured'
        ? 'Generated by --init-manifest; the bounded scan found no initialization in any discovered CI file, so ' +
          'no additional CI-file review is required.'
        : 'Generated by --init-manifest; inspect CI review targets in order and stop after recording the first ' +
          'matching test step for each runnable framework.',
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
    if (/\brun\s*:\s*[^\n]*(?:jest|vitest|mocha|(?:npm|pnpm|yarn)[^\n]*test)/.test(content)) score += 40
    if (/(?:jest|vitest|mocha|\btest\b)/.test(content)) score += 10
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
    const release = fs.readdirSync(directory).find(filename => /^yarn-.+\.cjs$/.test(filename))
    return release && path.join(directory, release)
  } catch {}
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
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch {}
}

module.exports = { createManifestScaffold }
