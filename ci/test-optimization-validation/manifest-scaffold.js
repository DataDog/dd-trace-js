'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')

const { runDiagnosis } = require('../diagnose')
const { GENERATED_SCENARIOS, getGeneratedTestContent } = require('./generated-test-contract')
const { validateManifest } = require('./manifest-schema')
const { maskJavaScriptComments, maskJavaScriptNonCode } = require('./source-text')

const SUPPORTED_SCAFFOLD_FRAMEWORKS = new Set(['jest', 'mocha', 'vitest'])
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
    ciDiscovery: discoverCiFiles(repositoryRoot),
    frameworks: [
      ...selected.map(framework => buildFrameworkScaffold(repositoryRoot, framework)),
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

function buildFrameworkScaffold (repositoryRoot, detection) {
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
          `${detection.name} adapter. Live validation currently supports Jest, Mocha, and Vitest.`,
      ],
    }
  }

  const runner = tryResolveRunner(framework, projectRoot)
  if (!runner) {
    return {
      id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
      framework,
      frameworkVersion: detection.version,
      status: 'requires_manual_setup',
      project: getProject({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }),
      notes: [
        `${detection.name} was detected, but its executable package could not be resolved from ` +
          `${path.relative(repositoryRoot, projectRoot) || 'the repository root'}.`,
      ],
    }
  }
  const scriptName = getPackageScriptName(packageJson, detection.command)
  const preserveProjectWrapper = Boolean(scriptName) && !usesFrameworkRunner(detection.command, framework)
  const baseCommand = buildExistingCommand({
    framework,
    detectedCommand: detection.command,
    projectRoot,
    repositoryRoot,
    runner,
    scriptName,
    preserveProjectWrapper,
  })
  const representativeSelection = findRepresentativeTestFile(projectRoot, framework)
  const representative = representativeSelection.file
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
      project: getProject({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }),
      notes: [`${reason} Select a real ${detection.name} test before live validation.`],
    }
  }
  const representativeTestName = representativeSelection.testName
  const command = buildFocusedCommand(
    baseCommand,
    framework,
    representative,
    Boolean(scriptName),
    preserveProjectWrapper,
    undefined,
    representativeTestName
  )

  const generatedTestStrategy = buildGeneratedTestStrategy({
    baseCommand: preserveProjectWrapper ? baseCommand : undefined,
    framework,
    packageJson,
    projectRoot,
    representative,
    runner,
    runnerConfigurationArgs: preserveProjectWrapper
      ? []
      : getRunnerConfigurationArgs(framework, detection.command),
  })

  return {
    id: `${framework}:${getProjectIdentifier(packageJson, projectRoot, repositoryRoot)}`,
    framework,
    frameworkVersion: detection.version,
    language: /\.tsx?$/.test(generatedTestStrategy.fileExtension) ? 'typescript' : 'javascript',
    status: 'runnable',
    supportLevel: 'validator_supported',
    localSocketRequired: representativeSelection.requiresLocalSocket,
    project: getProject({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }),
    setup: { commands: [], services: [] },
    existingTestCommand: command,
    preflight: { status: 'pending', maxTestCount: 1 },
    ciWiring: {
      status: 'unknown',
      replayability: 'not_replayable',
      replayBlocker: 'CI command selection has not been completed. Inspect the discovered CI configuration and ' +
        'replace this with a concrete technical blocker only when the selected test command cannot be replayed.',
      diagnosis: 'Select one replayable CI test step and record its exact command and environment before live CI ' +
        'wiring validation.',
      initialization: {
        status: 'unknown',
        evidence: [],
      },
    },
    generatedTestStrategy,
    notes: [
      representative
        ? `Generated by --init-manifest using representative test ${path.relative(repositoryRoot, representative)}.`
        : 'Generated by --init-manifest. Narrow existingTestCommand if the detected command runs a broad suite.',
      preserveProjectWrapper
        ? `Basic Reporting preserves package script ${scriptName} because it contains runner flags or custom ` +
          'wrapper logic.'
        : `Basic Reporting invokes the installed ${framework} runner directly; record the CI wrapper separately.`,
      ...(representativeSelection.requiresLocalSocket
        ? ['Every safe representative test found appears to open a local listener. The approved test command may ' +
            'be blocked in an execution environment that denies project localhost sockets; do not escalate ' +
            'permissions automatically.']
        : []),
      'CI command selection still requires repository-specific evidence.',
    ],
  }
}

function getProject ({ packageJson, packageJsonPath, projectRoot, repositoryRoot, framework }) {
  return {
    name: packageJson.name || getProjectIdentifier(packageJson, projectRoot, repositoryRoot),
    root: projectRoot,
    packageJson: packageJsonPath,
    configFiles: findConfigFiles(projectRoot, framework),
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
    : getDirectRunnerArgv(framework, runner, detectedCommand)
  return {
    description: preserveProjectWrapper
      ? `Detected custom package script ${scriptName}`
      : `Direct installed ${framework} runner for local capability validation`,
    cwd: projectRoot,
    argv,
    env: {},
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
  runnerConfigurationArgs,
}) {
  const convention = getGeneratedTestConvention(representative, projectRoot)
  const packageType = getNearestPackageType(convention.testDirectory, projectRoot, packageJson.type)
  const moduleSystem = getGeneratedModuleSystem(framework, convention.fileExtension, packageType)
  const definitions = getGeneratedDefinitions({ framework, convention, moduleSystem })

  return {
    status: 'planned',
    reason: 'Standard isolated scenarios generated by the validator manifest scaffold.',
    adapter: framework,
    testDirectory: convention.testDirectory,
    moduleSystem,
    fileExtension: convention.fileExtension,
    supportsFocusedSingleFileRun: true,
    usesMultipleFiles: true,
    files: definitions.map(definition => ({
      path: definition.file,
      role: 'test',
      contentLines: definition.content.split('\n'),
    })),
    scenarios: definitions.map(definition => ({
      id: definition.id,
      purpose: definition.purpose,
      runCommand: baseCommand
        ? buildFocusedCommand(
          baseCommand,
          framework,
          definition.file,
          true,
          true,
          moduleSystem,
          definition.testName
        )
        : buildGeneratedRunCommand(
          framework,
          projectRoot,
          definition.file,
          runner,
          moduleSystem,
          runnerConfigurationArgs,
          definition.testName
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
      path.join(path.dirname(definitions.find(definition => definition.id === 'atr-fail-once').file),
        '.dd-test-optimization-validation-atr-state'),
    ],
  }
}

function getGeneratedModuleSystem (framework, fileExtension, packageType) {
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
        stateFile: path.join(path.dirname(generatedFile), '.dd-test-optimization-validation-atr-state'),
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
  testName
) {
  const args = {
    jest: ['--runTestsByPath', filename, '--runInBand', '--silent', '--no-watchman'],
    mocha: ['--reporter', 'spec', filename],
    vitest: ['run', filename, ...(moduleSystem === 'commonjs' ? ['--globals'] : [])],
  }[framework]
  return {
    cwd: projectRoot,
    argv: [
      process.execPath,
      runner,
      ...runnerConfigurationArgs,
      ...args,
      ...getFocusedTestNameArgs(framework, testName),
    ],
    env: {},
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
 * @param {string} [testName] selected test name
 * @returns {object} focused project command
 */
function buildFocusedCommand (
  baseCommand,
  framework,
  filename,
  packageScript,
  preserveDefaultReporter,
  moduleSystem,
  testName
) {
  const argv = [...baseCommand.argv]
  if (packageScript && path.basename(argv[0]).toLowerCase() === 'npm') argv.push('--')
  argv.push(...getFocusedTestArgs(framework, filename, preserveDefaultReporter, moduleSystem, testName))

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
 * @param {string} [testName] selected test name
 * @returns {string[]} focused test arguments
 */
function getFocusedTestArgs (framework, filename, preserveDefaultReporter, moduleSystem, testName) {
  if (framework === 'jest') {
    return [
      '--runTestsByPath',
      filename,
      ...getFocusedTestNameArgs(framework, testName),
      '--runInBand',
      ...(preserveDefaultReporter ? [] : ['--silent']),
      '--no-watchman',
    ]
  }
  return [
    filename,
    ...getFocusedTestNameArgs(framework, testName),
    ...(framework === 'vitest' && moduleSystem === 'commonjs' ? ['--globals'] : []),
  ]
}

/**
 * Returns a runner-native literal test-name filter.
 *
 * Mocha receives an unanchored leaf-title filter because its full title includes parent suites. The clean
 * preflight must still prove that the filter selected exactly one test.
 *
 * @param {string} framework framework name
 * @param {string|undefined} testName selected test name
 * @returns {string[]} runner arguments
 */
function getFocusedTestNameArgs (framework, testName) {
  if (!testName) return []
  const pattern = escapeRegex(testName)
  if (framework === 'mocha') return ['--grep', pattern]
  return ['--testNamePattern', pattern]
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
  const packageName = framework === 'jest' ? 'jest' : framework
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [projectRoot] })
  const packageJson = readJson(packageJsonPath)
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin[packageName]
  return path.resolve(path.dirname(packageJsonPath), bin)
}

function getPackageScriptArgv (packageManager, scriptName, repositoryRoot) {
  if (packageManager === 'yarn') {
    const release = findYarnRelease(repositoryRoot)
    return release ? [process.execPath, release, 'run', scriptName] : ['yarn', 'run', scriptName]
  }
  return [packageManager, 'run', scriptName]
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
  const tokens = String(command || '').trim().split(/\s+/)
  const executable = path.basename(tokens[0] || '').replace(/\.cmd$/i, '').toLowerCase()
  if (executable !== framework) return false
  return tokens.length === 1 || (framework === 'vitest' && tokens.length === 2 && tokens[1] === 'run')
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
    ...(framework === 'vitest' ? ['run'] : []),
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
    jest: new Set(['--config']),
    mocha: new Set(['--config', '--extension', '--loader', '--require', '--timeout', '--ui']),
    vitest: new Set(['--config', '--environment', '--project', '--root']),
  }[framework]
  if (!allowed) return []

  const tokens = String(command || '').trim().split(/\s+/).slice(1)
  const args = []
  for (let index = 0; index < tokens.length; index++) {
    const inlineName = tokens[index].split('=', 1)[0]
    if (!allowed.has(inlineName)) continue
    args.push(tokens[index])
    if (!tokens[index].includes('=') && tokens[index + 1] && !tokens[index + 1].startsWith('-')) {
      args.push(tokens[++index])
    }
  }
  return args
}

/**
 * Finds a bounded representative test owned by the selected framework.
 *
 * @param {string} root project root
 * @param {string} framework selected framework
 * @returns {{file?: string, testName?: string, rejected: string[]}} representative selection
 */
function findRepresentativeTestFile (root, framework) {
  const stack = [root]
  const candidates = []
  const rejected = []
  const packageRanks = new Map()
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
      const inTestsDirectory = path.relative(root, directory).split(path.sep).includes('__tests__')
      if (/^(?:test\.(?:[cm]?[jt]s|[jt]sx)|.+[.-](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx))$/.test(entry.name) ||
        (inTestsDirectory && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name))) {
        const ownershipConflict = getRunnerOwnershipConflict(filename, root, framework)
        if (ownershipConflict) {
          rejected.push(`${path.relative(root, filename)} (${ownershipConflict})`)
        } else {
          candidates.push(filename)
        }
      }
    }
  }

  candidates.sort((left, right) => {
    return getTestDirectoryRank(left, root) - getTestDirectoryRank(right, root) ||
      getTestAreaRank(left, root) - getTestAreaRank(right, root) ||
      getLocalListenerRank(left, root) - getLocalListenerRank(right, root) ||
      getIndependentTestProjectRank(left, root, packageRanks) -
        getIndependentTestProjectRank(right, root, packageRanks) ||
      left.localeCompare(right)
  })
  for (const filename of candidates) {
    const testName = getRepresentativeTestName(filename)
    if (testName) {
      return {
        file: filename,
        requiresLocalSocket: getLocalListenerRank(filename, root) > 0,
        testName,
        rejected,
      }
    }
    rejected.push(`${path.relative(root, filename)} (no bounded literal test name)`)
  }
  return { rejected }
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
    ],
    mocha: [
      [/(?:from\s+|require\s*\(\s*)['"](?:vitest|@jest\/globals|node:test)['"]/, 'imports another runner'],
    ],
    vitest: [
      [/(?:from\s+|require\s*\(\s*)['"](?:@jest\/globals|node:test)['"]/, 'imports another runner'],
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
 * Extracts one bounded literal test name from a representative source file.
 *
 * @param {string} filename representative test file
 * @returns {string|undefined} literal test name
 */
function getRepresentativeTestName (filename) {
  let source
  try {
    source = fs.readFileSync(filename, 'utf8')
  } catch {
    return
  }
  const code = maskJavaScriptNonCode(source)
  source = maskJavaScriptComments(source)

  const pattern = /(^|[^\w$])(?:it|test|specify)(?:\.only)?\s*\(\s*(['"])((?:\\.|[^\\'"\r\n]){1,200})\2/gm
  let match
  while ((match = pattern.exec(source))) {
    const declarationIndex = match.index + match[1].length
    if (code[declarationIndex] === ' ') continue
    if (!isInsideRepeatedTestBlock(source, match.index)) {
      return match[3].replaceAll(/\\(['"\\])/g, '$1')
    }
  }
}

/**
 * Rejects a literal test declaration that appears inside a simple loop or table expansion.
 *
 * @param {string} source test source
 * @param {number} testIndex literal test declaration offset
 * @returns {boolean} whether the declaration can create multiple runtime tests
 */
function isInsideRepeatedTestBlock (source, testIndex) {
  const prefix = source.slice(0, testIndex)
  const lastBlockEnd = prefix.lastIndexOf('}')
  return Math.max(
    prefix.lastIndexOf('for ('),
    prefix.lastIndexOf('for('),
    prefix.lastIndexOf('.forEach('),
    prefix.lastIndexOf('.each(')
  ) > lastBlockEnd
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
    return /(?:\bsupertest\b|\bcreateServer\s*\(|\.listen\s*\(|(?:from\s+|require\s*\(\s*)['"]node:(?:http|https|net)['"])/
      .test(source)
      ? 1
      : 0
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
  const match = /((?:[.-](?:test|spec))\.(?:[cm]?[jt]s|[jt]sx))$/.exec(filename)
  return match?.[1] || '.test.js'
}

function findConfigFiles (root, framework) {
  const patterns = {
    jest: /^jest\.config\./,
    mocha: /^\.mocharc\./,
    vitest: /^(?:vite|vitest)\.config\./,
  }[framework]
  if (!patterns) return []
  try {
    return fs.readdirSync(root).filter(filename => patterns.test(filename)).map(filename => path.join(root, filename))
  } catch {
    return []
  }
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
    const stat = fs.statSync(filename)
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(filename).sort()) {
        if (/\.ya?ml$/.test(entry)) found.push(path.posix.join(relativePath, entry))
      }
    } else {
      found.push(relativePath)
    }
  }
  return {
    searched: [...CI_PATHS],
    found,
    method: 'deterministic-known-ci-paths',
    warnings: [],
    notes: ['Generated by --init-manifest; select and record one replayable CI test step before live validation.'],
  }
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
  return (path.relative(repositoryRoot, projectRoot) || 'root').replaceAll(path.sep, '-')
}

/**
 * Escapes a literal value for a test-name regular expression.
 *
 * @param {string} value literal value
 * @returns {string} escaped expression
 */
function escapeRegex (value) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`)
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
