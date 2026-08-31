'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { runDiagnosis } = require('../diagnose')
const { BLOCKER_CATEGORIES } = require('./blocker-category')
const cucumber = require('./framework-adapters/cucumber')
const cypress = require('./framework-adapters/cypress')
const playwright = require('./framework-adapters/playwright')
const vitest = require('./framework-adapters/vitest')
const { isProjectBuildArtifactPath } = require('./project-build-artifact')
const {
  GENERATED_SCENARIOS,
  getGeneratedRetryStatePath,
  getGeneratedTestContent,
} = require('./generated-test-contract')
const { validateManifest } = require('./manifest-schema')
const {
  getProjectNodeRunner,
  getRunnerConfigurationContract,
  getRunnerContract,
  getRunnerSearchRoots,
} = require('./runner-contract')

const SUPPORTED_FRAMEWORKS = new Set(['cucumber', 'cypress', 'jest', 'mocha', 'playwright', 'vitest'])
const MAX_DISCOVERY_ENTRIES = 5000
const MAX_DIRECTORY_ENTRIES = 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_CI_FILES = 256
const MAX_CI_REVIEW_TARGETS = 3
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.yarn',
  'build',
  'coverage',
  'dd-test-optimization-validation-results',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
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
const CONFIG_PATTERNS = {
  cucumber: cucumber.CONFIG_PATTERN,
  cypress: cypress.CONFIG_PATTERN,
  jest: /^(?:jest|config-jest)\.config\.(?:[cm]?[jt]s|json)$/,
  mocha: /^\.mocharc\.(?:json|ya?ml|[cm]?js)$/,
  playwright: playwright.CONFIG_PATTERN,
  vitest: /^(?:vite\.config|vitest\.(?:config|workspace))\.[cm]?[jt]s$/,
}
const JS_CONFIG_EXTENSIONS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts']
const IMPLICIT_CONFIG_FILENAMES = {
  cucumber: ['json', 'yaml', 'yml', ...JS_CONFIG_EXTENSIONS].map(extension => `cucumber.${extension}`),
  cypress: ['json', ...JS_CONFIG_EXTENSIONS].flatMap(extension => [
    `cypress.${extension}`,
    `cypress.config.${extension}`,
  ]),
  jest: ['json', ...JS_CONFIG_EXTENSIONS].flatMap(extension => [
    `jest.config.${extension}`,
    `config-jest.config.${extension}`,
  ]),
  mocha: ['json', 'yaml', 'yml', ...JS_CONFIG_EXTENSIONS].map(extension => `.mocharc.${extension}`),
  playwright: JS_CONFIG_EXTENSIONS.map(extension => `playwright.config.${extension}`),
  vitest: JS_CONFIG_EXTENSIONS.flatMap(extension => [
    `vite.config.${extension}`,
    `vitest.config.${extension}`,
    `vitest.workspace.${extension}`,
  ]),
}
const TEST_FILE_PATTERN = /^.+[._-](?:test|spec)\.[cm]?[jt]sx?$/
const BARE_TEST_FILE_PATTERN = /^test\.[cm]?[jt]sx?$/
const TYPE_ONLY_TEST_PATTERN = /\.(?:test|spec)-d\.[cm]?tsx?$|\.d\.[cm]?ts$/i
const TYPE_ONLY_DIRECTORY_PATTERN = /(?:^|\/)(?:type[-_]?tests?|test-dts?)(?:\/|$)/i
const LOCAL_SOCKET_PATTERN =
  /\bcreateServer\s*\(|\.listen\s*\(|\b(?:localhost|127\.0\.0\.1|supertest)\b|\bcy\.(?:visit|request)\s*\(/
const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|require\s*\(\s*|import\s*\(\s*)(['"])([^'"]+)\1/g
const CUCUMBER_BROWSER_SUPPORT_DIRECTORY_PATTERN =
  /(?:^|\/)(?:features?|helpers?|step_definitions|steps?|support)(?:\/|$)/i
const CUCUMBER_BROWSER_DRIVER_PATTERN =
  /(?:from\s+|(?:import|require)\s*\(\s*)['"](?:@playwright\/test|nightwatch|playwright(?:-core)?|puppeteer(?:-core)?|selenium-webdriver|webdriverio)['"]/
const CYPRESS_LOCAL_ORIGIN_PATTERN =
  /\bcy\.(?:visit|request)\s*\([\s\S]{0,512}\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?=[:/'"`\s}])/i

/**
 * Creates a schema-valid data-only manifest without executing project code.
 *
 * @param {object} input scaffold inputs
 * @param {string} input.root repository root
 * @param {Set<string>} [input.frameworks] selected framework ids or kinds
 * @returns {object} validation manifest scaffold
 */
function createManifestScaffold ({ root, frameworks = new Set() }) {
  const repositoryRoot = fs.realpathSync(path.resolve(root))
  const diagnosis = runDiagnosis({ root: repositoryRoot, env: {} })
  const ciDiscovery = discoverCiFiles(repositoryRoot)
  const eligible = diagnosis.eligibleFrameworks.filter(detection => isSelected(detection.id, frameworks))
  const eligibleKinds = new Set(eligible.map(detection => detection.id))
  const detectedOnly = diagnosis.supportedFrameworks.filter(detection => {
    return !eligibleKinds.has(detection.id) && isSelected(detection.id, frameworks)
  })
  const unsupported = diagnosis.unsupportedFrameworks.filter(detection => isSelected(detection.id, frameworks))

  if (eligible.length === 0 && detectedOnly.length === 0 && unsupported.length === 0) {
    throw new Error('No test framework was detected for manifest scaffolding.')
  }

  const manifest = {
    schemaVersion: '2.0',
    generatedAt: new Date().toISOString(),
    repository: {
      root: repositoryRoot,
      packageManager: detectPackageManager(repositoryRoot),
      workspaceManager: detectWorkspaceManager(repositoryRoot),
    },
    environment: {
      nodeVersion: process.version,
      os: getManifestOs(process.platform),
    },
    ciDiscovery,
    frameworks: [
      ...eligible.map(detection => buildFramework(repositoryRoot, detection, ciDiscovery)),
      ...detectedOnly.map(detection => {
        return detection.supportedVersion && SUPPORTED_FRAMEWORKS.has(detection.id)
          ? buildFramework(repositoryRoot, detection, ciDiscovery)
          : buildDetectedOnlyFramework(repositoryRoot, detection, ciDiscovery)
      }),
      ...unsupported.map(detection => buildUnsupportedFramework(repositoryRoot, detection, ciDiscovery)),
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
 * Builds one runnable direct-runner framework or a precise setup blocker.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} detection eligible framework detection
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} framework manifest entry
 */
function buildFramework (repositoryRoot, detection, ciDiscovery) {
  const framework = detection.id
  const packageJson = getFrameworkPackageJson(repositoryRoot, detection)
  if (!packageJson) {
    return buildDetectedOnlyFramework(
      repositoryRoot,
      detection,
      ciDiscovery,
      `The package that owns ${detection.name} could not be identified from the bounded detection evidence.`
    )
  }
  const projectRoot = path.dirname(packageJson.path)
  const base = getFrameworkBase({
    ciDiscovery,
    detection,
    framework,
    packageJson,
    projectRoot,
    repositoryRoot,
  })

  if (!SUPPORTED_FRAMEWORKS.has(framework)) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      status: 'unsupported_by_validator',
      notes: [`${detection.name} is supported by dd-trace, but this validator has no direct-runner adapter.`],
    }
  }

  if (framework === 'cucumber' && !cucumber.supportsConfigIsolation(base.frameworkVersion)) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      status: 'requires_manual_setup',
      notes: [
        `${detection.name} ${base.frameworkVersion || 'with an unknown version'} is supported by dd-trace, but its ` +
          'CLI cannot bypass customer profiles with a validator-owned config. Live validation is unavailable because ' +
          'changing the working directory or loading the profile dynamically would weaken isolation. The static CI ' +
          'audit can still run.',
      ],
    }
  }

  const projectRunner = getProjectNodeRunner(detection.command, projectRoot, repositoryRoot)
  const runner = projectRunner || resolveRunner(framework, projectRoot, repositoryRoot)
  if (!runner) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      status: 'requires_manual_setup',
      notes: [
        `${detection.name} is detected, but its repository-contained executable is unavailable. Install this ` +
        'package normally, then create a fresh validation plan.',
      ],
    }
  }

  const projectFiles = collectProjectFiles(projectRoot)
  const commandRoots = getRunnerSearchRoots(framework, detection.command, projectRoot, repositoryRoot)
  let runnerContract = getRunnerContract(framework, detection.command, projectRoot, repositoryRoot)
  if (runnerContract.error) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      status: 'requires_manual_setup',
      notes: [
        `${detection.name} runner configuration was not retained because ${runnerContract.error}. ` +
          'Choose a representative test command manually or adjust the project setup, then create a fresh plan.',
      ],
    }
  }
  const implicitConfigFiles = [...new Set([
    ...getImplicitConfigFiles(framework, projectRoot, repositoryRoot),
    ...(framework === 'vitest' && commandRoots[0]
      ? getImplicitConfigFiles(framework, commandRoots[0], repositoryRoot)
      : []),
  ])]
  if (framework === 'cucumber') {
    const expanded = cucumber.expandProfiles({
      configFiles: [...new Set([...runnerContract.inputFiles, ...implicitConfigFiles])],
      projectFiles,
      projectRoot,
      runnerArgs: runnerContract.runnerArgs,
    })
    if (expanded.error) {
      return {
        ...base,
        blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
        status: 'requires_manual_setup',
        notes: [
          `${detection.name} runner configuration was not retained because ${expanded.error}. ` +
            'Use a literal Cucumber profile or a direct command with bounded support-code options, then create a ' +
            'fresh plan.',
        ],
      }
    }
    const expandedContract = getRunnerConfigurationContract(
      framework,
      expanded.runnerArgs,
      runnerContract.environment,
      projectRoot,
      repositoryRoot
    )
    if (expandedContract.error) {
      return {
        ...base,
        blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
        status: 'requires_manual_setup',
        notes: [
          `${detection.name} profile configuration was not retained because ${expandedContract.error}. ` +
            'Use repository-contained support-code inputs, then create a fresh plan.',
        ],
      }
    }
    runnerContract = {
      ...expandedContract,
      omittedOptions: runnerContract.omittedOptions,
    }
  }
  const vitestProject = framework === 'vitest'
    ? vitest.bindLiteralProject({
      configFiles: [...new Set([...runnerContract.inputFiles, ...implicitConfigFiles])],
      projectFiles,
      projectRoot,
      runnerArgs: runnerContract.runnerArgs,
    })
    : undefined
  if (vitestProject?.error) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      status: 'requires_manual_setup',
      notes: [
        `${detection.name} runner configuration was not retained because ${vitestProject.error}. ` +
          'Use one literal, uniquely named Vitest project with static configuration, then create a fresh plan.',
      ],
    }
  }
  const representativeRoot = vitestProject?.root ||
    commandRoots[0] ||
    findPreferredRepresentativeRoot(projectRoot, repositoryRoot)
  const representativePackage = readJson(path.join(representativeRoot, 'package.json')) || packageJson.json
  const candidateFiles = vitestProject?.files ||
    (representativeRoot === projectRoot ? projectFiles : collectProjectFiles(representativeRoot))
  const candidates = selectRepresentativeTests(
    candidateFiles,
    framework,
    representativeRoot,
    representativePackage.name,
    commandRoots.length > 0 || vitestProject !== undefined
  )
  const candidate = candidates[0]
  if (!candidate) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      status: 'requires_manual_setup',
      notes: [
        `No single ${detection.name} test file could be selected confidently. Choose a normal framework-owned ` +
        'test file or validate this framework manually.',
      ],
    }
  }
  if (candidate.requiresExternalService) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      status: 'requires_manual_setup',
      notes: [
        `No self-contained ${detection.name} spec could be selected. The available spec accesses a localhost ` +
        'application that discovery will not start. Start the application through the project\'s normal setup and ' +
        'validate Cypress manually, or add a self-contained spec before creating a fresh plan.',
      ],
    }
  }

  const plannedGeneratedTestStrategy = buildGeneratedTestStrategy({
    framework,
    projectRoot: vitestProject?.root || projectRoot,
    representative: candidate.path,
  })
  const generatedTestStrategy = vitestProject &&
    !vitest.supportsGeneratedFiles(vitestProject, plannedGeneratedTestStrategy)
    ? {
        reason: 'The selected Vitest project include or exclude patterns do not collect ' +
          'validator-generated test files.',
        status: 'not_possible',
      }
    : plannedGeneratedTestStrategy
  const configFiles = [...new Set([
    ...runnerContract.inputFiles,
    ...(vitestProject?.configFile ? [vitestProject.configFile] : []),
    ...implicitConfigFiles,
    ...(representativeRoot === projectRoot
      ? []
      : getImplicitConfigFiles(framework, representativeRoot, repositoryRoot)),
    ...projectFiles.filter(filename => CONFIG_PATTERNS[framework]?.test(path.basename(filename))).slice(0, 5),
  ])]
  if (configFiles.length > 20) {
    return {
      ...base,
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      status: 'requires_manual_setup',
      notes: [
        `${detection.name} loads more configuration files than the validator can approval-bind safely. ` +
          'Use a narrower project setup before creating a fresh plan.',
      ],
    }
  }
  const runnerDescription = projectRunner ? 'repository test wrapper' : `installed ${framework} runner`
  const runnerConfigurationNote = detection.command
    ? 'The validator retained only allowlisted runner configuration from the detected package script.'
    : 'The validator uses the installed runner with repository-contained configuration files; the unresolved ' +
      'package wrapper is not executed.'
  const cucumberBrowserRequired = framework === 'cucumber' &&
    hasCucumberBrowserSupport(candidateFiles, runnerContract.inputFiles, representativeRoot)
  const browserRequired = framework === 'cypress' ||
    framework === 'playwright' ||
    cucumberBrowserRequired ||
    (framework === 'vitest' && runnerContract.runnerArgs.includes('--browser'))
  const fallbackCandidates = candidates
    .slice(1)
    .filter(candidate => hasGeneratedTestContract(
      candidate.path,
      framework,
      vitestProject?.root || projectRoot,
      plannedGeneratedTestStrategy
    ))
  const fallbackTests = fallbackCandidates
    .map(candidate => ({
      buildArtifactRequired: candidate.requiresBuildArtifact,
      localSocketRequired: candidate.requiresLocalSocket,
      testFile: candidate.path,
    }))
  const allCandidatesRequireLocalSocket =
    [candidate, ...fallbackCandidates].every(candidate => candidate.requiresLocalSocket)

  return {
    ...base,
    allCandidatesRequireLocalSocket,
    browserRequired,
    buildArtifactRequired: candidate.requiresBuildArtifact,
    language: /\.[cm]?tsx?$/.test(candidate.path) ? 'typescript' : 'javascript',
    localSocketRequired: candidate.requiresLocalSocket,
    status: 'runnable',
    supportLevel: 'validator_direct_runner',
    project: {
      ...base.project,
      configFiles,
    },
    validation: {
      environment: runnerContract.environment,
      ...(runnerContract.omittedOptions?.length > 0
        ? { omittedRunnerOptions: runnerContract.omittedOptions }
        : {}),
      requiredEnvVars: [],
      runner,
      runnerArgs: runnerContract.runnerArgs,
      selectorScope: projectRunner ? 'instrumented_event_identity' : 'bounded_direct_runner',
      testFile: candidate.path,
      ...(fallbackTests.length > 0 ? { fallbackTests } : {}),
      timeoutMs: browserRequired ? 300_000 : 180_000,
    },
    preflight: { status: 'pending' },
    generatedTestStrategy,
    notes: [
      `Basic Reporting will invoke the ${runnerDescription} ` +
        'directly for ' +
        `${path.relative(repositoryRoot, candidate.path)}.`,
      runnerConfigurationNote,
      ...(projectRunner
        ? [
            'Basic Reporting will remain incomplete unless captured test events identify only the approved ' +
              'representative file.',
          ]
        : []),
      ...(candidate.requiresLocalSocket
        ? [
            `${allCandidatesRequireLocalSocket ? 'Every approved candidate appears' : 'The selected test appears'} ` +
              'to require localhost. A restricted execution environment may leave local validation incomplete.',
          ]
        : []),
      ...(candidate.requiresBuildArtifact
        ? [
            'The selected test appears to load a build or dist artifact. Complete the project\'s normal build before ' +
              'validation if that artifact is not already present.',
          ]
        : []),
      ...(cucumberBrowserRequired
        ? [
            'The selected Cucumber support code imports a browser driver. The approved validation command may launch ' +
              'the project browser.',
          ]
        : []),
    ],
  }
}

function getImplicitConfigFiles (framework, projectRoot, repositoryRoot) {
  const files = []
  if (IMPLICIT_CONFIG_FILENAMES[framework]) {
    for (const basename of IMPLICIT_CONFIG_FILENAMES[framework]) {
      const filename = path.join(projectRoot, basename)
      try {
        const stat = fs.lstatSync(filename)
        const physical = fs.realpathSync(filename)
        if (stat.isFile() && !stat.isSymbolicLink() &&
          fs.statSync(physical).isFile() &&
          isPathInside(fs.realpathSync(repositoryRoot), physical)) files.push(physical)
      } catch {}
    }
  }
  return files
}

/**
 * Builds a diagnostic-only supported framework entry.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} detection supported framework detection
 * @param {object} ciDiscovery bounded CI discovery result
 * @param {string} [blockerNote] precise reason live validation is unavailable
 * @returns {object} framework manifest entry
 */
function buildDetectedOnlyFramework (repositoryRoot, detection, ciDiscovery, blockerNote) {
  const packageJson = getDetectionPackageJson(repositoryRoot, getDetectionPackageLocation(detection))
  const projectRoot = path.dirname(packageJson.path)
  const version = detection.supportedVersion?.version ||
    detection.versionDetections?.[0]?.version ||
    detection.versionDetections?.[0]?.rawVersion
  const unsupportedVersion = !detection.supportedVersion &&
    (detection.versionDetections?.[0]?.version || detection.versionDetections?.[0]?.rawVersion)
  return {
    ...getFrameworkBase({
      ciDiscovery,
      detection: { ...detection, version },
      framework: detection.id,
      packageJson,
      projectRoot,
      repositoryRoot,
    }),
    blockerCategory: unsupportedVersion
      ? BLOCKER_CATEGORIES.UNSUPPORTED_VERSION
      : BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
    status: 'detected_not_runnable',
    notes: [
      blockerNote || (unsupportedVersion
        ? `${detection.name} ${unsupportedVersion} was detected, but live validation requires ` +
          `${detection.supportedRange}. Upgrade ${detection.name} through the project's normal dependency workflow ` +
          'before creating a fresh validation plan.'
        : detection.supportedVersion
          ? `A supported ${detection.name} installation was detected, but no project-local validation target was found.`
          : `${detection.name} was detected, but no supported installed version was confirmed.`),
    ],
  }
}

/**
 * Builds an unsupported framework entry.
 *
 * @param {string} repositoryRoot repository root
 * @param {object} detection unsupported framework detection
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} framework manifest entry
 */
function buildUnsupportedFramework (repositoryRoot, detection, ciDiscovery) {
  const packageJson = getDetectionPackageJson(repositoryRoot, detection.locations?.[0])
  const projectRoot = path.dirname(packageJson.path)
  const framework = detection.id === 'node-test' ? 'node:test' : detection.id
  return {
    ...getFrameworkBase({
      ciDiscovery,
      detection,
      framework,
      packageJson,
      projectRoot,
      repositoryRoot,
    }),
    blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
    status: 'unsupported_by_validator',
    notes: [`${detection.name} is not supported by this Test Optimization validator.`],
  }
}

/**
 * Returns fields shared by runnable and diagnostic framework entries.
 *
 * @param {object} input framework inputs
 * @param {object} input.ciDiscovery bounded CI discovery
 * @param {object} input.detection framework detection
 * @param {string} input.framework framework name
 * @param {object} input.packageJson package metadata
 * @param {string} input.projectRoot project root
 * @param {string} input.repositoryRoot repository root
 * @returns {object} shared framework fields
 */
function getFrameworkBase ({
  ciDiscovery,
  detection,
  framework,
  packageJson,
  projectRoot,
  repositoryRoot,
}) {
  return {
    id: `${framework}:${getProjectId(packageJson.json, projectRoot, repositoryRoot)}`,
    framework,
    frameworkVersion: detection.version || detection.supportedVersion?.version || null,
    language: 'unknown',
    supportLevel: 'detected_only',
    project: {
      configFiles: [],
      name: packageJson.json.name || path.basename(projectRoot) || 'root',
      packageJson: packageJson.path,
      root: projectRoot,
    },
    ciWiring: buildCiWiring(ciDiscovery),
  }
}

/**
 * Builds inert CI review fields. The agent may populate only this evidence section.
 *
 * @param {object} ciDiscovery bounded CI discovery result
 * @returns {object} CI evidence scaffold
 */
function buildCiWiring (ciDiscovery) {
  const unresolved = ciDiscovery.reviewRequired
    ? ['The exact CI test job and its effective environment have not been reviewed.']
    : ['No supported CI configuration file was found by bounded discovery.']
  return {
    command: null,
    configFile: null,
    initialization: { evidence: [], status: 'unknown' },
    job: null,
    reviewComplete: false,
    step: null,
    transport: { evidence: [], mode: 'unknown' },
    unresolved,
    workingDirectory: null,
  }
}

/**
 * Builds canonical generated test data without embedding executable commands.
 *
 * @param {object} input generated-test inputs
 * @param {string} input.framework framework name
 * @param {string} input.projectRoot project root
 * @param {string} input.representative representative test file
 * @returns {object} generated test strategy
 */
function buildGeneratedTestStrategy ({ framework, projectRoot, representative }) {
  const convention = getGeneratedTestConvention(framework, representative, projectRoot)
  const testDirectory = convention.testDirectory
  const extension = convention.fileExtension
  const moduleSystem = getModuleSystem(representative, projectRoot)
  const files = []
  const scenarios = []
  const cleanupPaths = []

  for (const [id, scenario] of Object.entries(GENERATED_SCENARIOS)) {
    const prefix = `dd-test-optimization-validation-${framework}-${id}`
    const filename = convention.exactFilename
      ? path.join(testDirectory, prefix, convention.exactFilename)
      : path.join(testDirectory, `${prefix}${extension}`)
    const content = getGeneratedTestContent({
      framework,
      moduleSystem,
      scenarioId: id,
      stateFile: ['cucumber', 'cypress', 'playwright'].includes(framework)
        ? undefined
        : getGeneratedRetryStatePath(framework, filename),
    })
    files.push({ path: filename, contentLines: content.split('\n') })
    cleanupPaths.push(filename)
    scenarios.push({
      id,
      expectedWithoutDatadog: scenario.expectedWithoutDatadog,
      testIdentities: [{
        file: filename,
        name: scenario.testName,
        suite: scenario.suiteName,
      }],
    })
  }

  if (framework === 'cucumber') {
    const stepsFile = cucumber.getGeneratedStepsPath(testDirectory)
    files.push({ path: stepsFile, contentLines: cucumber.getGeneratedStepsContent().split('\n') })
    cleanupPaths.push(stepsFile)
  } else if (framework === 'playwright') {
    const configFile = playwright.getGeneratedConfigPath(testDirectory)
    files.push({ path: configFile, contentLines: playwright.getGeneratedConfigContent().split('\n') })
    cleanupPaths.push(configFile)
  }
  if (['jest', 'mocha', 'vitest'].includes(framework)) {
    cleanupPaths.push(getGeneratedRetryStatePath(framework, scenarios[1].testIdentities[0].file))
  }

  return {
    cleanupPaths,
    fileExtension: extension,
    files,
    moduleSystem,
    reason: 'Validator-owned direct-runner recipes.',
    scenarios,
    status: 'planned',
    testDirectory,
  }
}

function hasGeneratedTestContract (representative, framework, projectRoot, strategy) {
  const convention = getGeneratedTestConvention(framework, representative, projectRoot)
  return convention.fileExtension === strategy.fileExtension &&
    convention.testDirectory === strategy.testDirectory &&
    getModuleSystem(representative, projectRoot) === strategy.moduleSystem
}

/**
 * Selects up to three representative framework-owned test files.
 *
 * @param {string[]} files bounded project files
 * @param {string} framework framework name
 * @param {string} projectRoot project root
 * @param {string} packageName project package name
 * @param {boolean} allowDirectoryConvention whether a literal runner selector owns this root
 * @returns {Array<{
 *   path: string,
 *   requiresBuildArtifact: boolean,
 *   requiresExternalService: boolean,
 *   requiresLocalSocket: boolean
 * }>} selected tests
 */
function selectRepresentativeTests (files, framework, projectRoot, packageName, allowDirectoryConvention) {
  const candidates = []
  for (const filename of files) {
    const source = readText(filename)
    if (source === undefined ||
      !isTestFile(filename, source, framework, projectRoot, allowDirectoryConvention) ||
      hasConflictingFramework(source, framework)) continue
    if (framework === 'cucumber'
      ? cucumber.getScenarioCount(source) === 0
      : getStaticTestCount(source) === 0) continue
    if (!hasFrameworkOwnership(filename, source, framework, packageName)) continue
    candidates.push({
      explicitFilename: TEST_FILE_PATTERN.test(path.basename(filename)),
      path: filename,
      rank: getTestRank(filename, source, projectRoot),
      requiresBuildArtifact: requiresProjectBuildArtifact(source, projectRoot, path.dirname(filename)),
      requiresExternalService: framework === 'cypress' && CYPRESS_LOCAL_ORIGIN_PATTERN.test(source),
      requiresLocalSocket: LOCAL_SOCKET_PATTERN.test(source),
    })
  }
  candidates.sort((left, right) => {
    return Number(left.requiresExternalService) - Number(right.requiresExternalService) ||
      Number(right.explicitFilename) - Number(left.explicitFilename) ||
      left.rank - right.rank ||
      left.path.localeCompare(right.path)
  })
  return candidates.slice(0, 3)
}

function requiresProjectBuildArtifact (source, projectRoot, sourceDirectory) {
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    if (isProjectBuildArtifactPath(match[2], projectRoot, sourceDirectory)) return true
  }
  return false
}

function hasCucumberBrowserSupport (files, retainedInputs, projectRoot) {
  const retained = new Set(retainedInputs)
  for (const filename of new Set([...files, ...retained])) {
    const relative = path.relative(projectRoot, filename).replaceAll('\\', '/')
    if (!retained.has(filename) && !CUCUMBER_BROWSER_SUPPORT_DIRECTORY_PATTERN.test(relative)) continue
    const source = readText(filename)
    if (source !== undefined && CUCUMBER_BROWSER_DRIVER_PATTERN.test(source)) return true
  }
  return false
}

/**
 * Reports whether a file follows a selected framework's test convention.
 *
 * @param {string} filename candidate file
 * @param {string} source candidate source
 * @param {string} framework framework name
 * @param {string} projectRoot project root
 * @param {boolean} allowDirectoryConvention whether a literal runner selector owns this root
 * @returns {boolean} whether the file is a candidate
 */
function isTestFile (filename, source, framework, projectRoot, allowDirectoryConvention) {
  const basename = path.basename(filename)
  const normalized = filename.replaceAll('\\', '/')
  if (normalized.includes('/dd-test-optimization-validation-')) return false
  if (TYPE_ONLY_TEST_PATTERN.test(basename) || TYPE_ONLY_DIRECTORY_PATTERN.test(normalized)) return false
  if (framework === 'cucumber') return cucumber.isTestFile(filename)
  if (framework === 'cypress') return cypress.isTestFile(basename, path.dirname(filename), projectRoot)
  if (framework === 'playwright') return playwright.isTestFile(basename, path.dirname(filename), projectRoot)
  if (TEST_FILE_PATTERN.test(basename)) return true
  const directories = [
    path.basename(projectRoot),
    ...path.relative(projectRoot, path.dirname(filename)).split(path.sep),
  ]
  const inTestDirectory = directories.some(directory => {
    return ['__tests__', 'spec', 'test', 'tests'].includes(directory)
  })
  if (BARE_TEST_FILE_PATTERN.test(basename)) {
    return (allowDirectoryConvention && inTestDirectory) || hasExplicitFrameworkImport(source, framework)
  }
  return allowDirectoryConvention && inTestDirectory && /\.[cm]?[jt]sx?$/.test(basename)
}

/**
 * Reports whether an unconventional test file imports the selected framework directly.
 *
 * @param {string} source candidate source
 * @param {string} framework framework name
 * @returns {boolean} whether ownership is explicit
 */
function hasExplicitFrameworkImport (source, framework) {
  if (framework === 'vitest') {
    return /(?:from\s+|require\s*\(\s*)['"]vitest['"]/.test(source)
  }
  if (framework === 'jest') {
    return /(?:from\s+|require\s*\(\s*)['"]@jest\/globals['"]/.test(source)
  }
  if (framework === 'mocha') {
    return /(?:from\s+|require\s*\(\s*)['"]mocha['"]/.test(source)
  }
  return false
}

/**
 * Conservatively associates a test source with one framework.
 *
 * @param {string} filename candidate filename
 * @param {string} source file source
 * @param {string} framework framework name
 * @param {string} packageName project package name
 * @returns {boolean} whether ownership is plausible
 */
function hasFrameworkOwnership (filename, source, framework, packageName) {
  const normalized = filename.replaceAll('\\', '/').toLowerCase()
  if (framework === 'cucumber') return /^[ \t]*(?:Feature|Rule):/m.test(source)
  if (framework === 'cypress') return /\.cy\./.test(filename) || normalized.includes('/cypress/')
  if (framework === 'playwright') {
    return /@playwright\/test/.test(source) || normalized.includes('/playwright/') ||
      normalized.includes('/e2e/')
  }
  if (framework === 'vitest') return /\bvitest\b/.test(source) || getStaticTestCount(source) > 0
  if (framework === 'jest') return /\bjest\b/.test(source) || getStaticTestCount(source) > 0
  if (framework === 'mocha') {
    return /\bmocha\b/.test(source) || /\bdescribe\s*\(/.test(source) ||
      packageName === 'mocha'
  }
  return false
}

/**
 * Rejects files visibly owned by another supported runner.
 *
 * @param {string} source candidate source
 * @param {string} framework selected framework
 * @returns {boolean} whether source ownership conflicts
 */
function hasConflictingFramework (source, framework) {
  const markers = {
    cypress: /\bcy\.(?:visit|request|get)\b|from\s+['"]cypress/,
    jest: /@jest\/globals|\bjest\.(?:mock|fn|spyOn)\b/,
    'node:test': /(?:from\s+|require\s*\(\s*)['"]node:test['"]/,
    playwright: /@playwright\/test/,
    vitest: /from\s+['"]vitest['"]|require\s*\(\s*['"]vitest['"]\s*\)|\bvi\./,
  }
  return Object.entries(markers).some(([name, pattern]) => name !== framework && pattern.test(source))
}

/**
 * Ranks simpler unit tests ahead of integration and service-dependent tests.
 *
 * @param {string} filename candidate filename
 * @param {string} source candidate source
 * @param {string} projectRoot project root
 * @returns {number} lower-is-better rank
 */
function getTestRank (filename, source, projectRoot) {
  const relative = path.relative(projectRoot, filename).replaceAll('\\', '/').toLowerCase()
  let rank = relative.split('/').length
  if (/(?:^|\/)(?:test|tests|__tests__|spec)\//.test(relative)) rank -= 20
  if (/(?:^|[._/-])unit(?:[._/-]|$)/.test(relative)) rank -= 15
  if (/e2e|integration|acceptance|browser|conformance|fixtures?/.test(relative)) rank += 20
  if (LOCAL_SOCKET_PATTERN.test(source)) rank += 30
  rank += Math.min(getStaticTestCount(source), 50)
  return rank
}

/**
 * Counts static test declarations for preferring small representative files.
 *
 * @param {string} source test source
 * @returns {number} approximate test declaration count
 */
function getStaticTestCount (source) {
  const direct = [...source.matchAll(/\b(?:it|test)((?:\.[A-Za-z]+)*)\s*\(\s*(['"`])/g)]
    .filter(match => !/\.(?:skip|todo)\b/.test(match[1]))
  const parameterized = [...source.matchAll(
    /\b(?:it|test)((?:\.[A-Za-z]+)*)\.each\s*(?:\([^()]*\)|`(?:\\[\s\S]|[^\\`])*`)((?:\.[A-Za-z]+)*)\s*\(\s*(['"`])/g
  )].filter(match => !/\.(?:skip|todo)\b/.test(`${match[1]}${match[2]}`))
  return direct.length + parameterized.length
}

/**
 * Narrows a repository root to the conventional package matching its identity.
 *
 * @param {string} projectRoot detected project root
 * @param {string} repositoryRoot repository root
 * @returns {string} preferred representative root
 */
function findPreferredRepresentativeRoot (projectRoot, repositoryRoot) {
  if (path.resolve(projectRoot) !== path.resolve(repositoryRoot)) return projectRoot
  const repositoryName = normalizeProjectIdentity(path.basename(repositoryRoot))

  for (const containerName of ['packages', 'pkgs', 'modules']) {
    const container = path.join(repositoryRoot, containerName)
    for (const entry of readDirectoryEntries(container)) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(container, entry.name)
      const packageJson = readJson(path.join(candidate, 'package.json'))
      if (normalizeProjectIdentity(packageJson?.name || entry.name) === repositoryName) return candidate
    }
  }
  return projectRoot
}

/**
 * Normalizes repository and package names for exact identity comparison.
 *
 * @param {string} value package identity
 * @returns {string} normalized identity
 */
function normalizeProjectIdentity (value) {
  const unscoped = String(value || '').toLowerCase().replace(/^@[^/]+\//, '')
  return unscoped.replaceAll(/[^a-z0-9]+/g, '').replace(/js$/, '')
}

/**
 * Collects bounded regular project files without following symbolic links.
 *
 * @param {string} root project root
 * @returns {string[]} absolute files
 */
function collectProjectFiles (root) {
  const files = []
  const pending = [root]
  let visited = 0

  while (pending.length > 0 && visited < MAX_DISCOVERY_ENTRIES) {
    const directory = pending.shift()
    for (const entry of readDirectoryEntries(directory)) {
      if (++visited > MAX_DISCOVERY_ENTRIES) break
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(filename)
      } else if (entry.isFile()) {
        files.push(filename)
      }
    }
  }
  return files
}

/**
 * Resolves a framework package executable only inside the repository.
 *
 * @param {string} framework framework name
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} physical runner path
 */
function resolveRunner (framework, projectRoot, repositoryRoot) {
  const packageName = getRunnerPackageName(framework)
  const packageRoot = findPackageRoot(packageName, projectRoot, repositoryRoot)
  if (!packageRoot) return

  const packageJson = readJson(path.join(packageRoot, 'package.json'))
  const binName = framework === 'cucumber' ? 'cucumber-js' : framework === 'playwright' ? 'playwright' : framework
  const bin = typeof packageJson?.bin === 'string' ? packageJson.bin : packageJson?.bin?.[binName]
  if (typeof bin !== 'string') return

  try {
    const runner = fs.realpathSync(path.resolve(packageRoot, bin))
    return isPathInside(fs.realpathSync(repositoryRoot), runner) && fs.statSync(runner).isFile()
      ? runner
      : undefined
  } catch {}
}

/**
 * Finds an installed package or a framework source checkout.
 *
 * @param {string} packageName runner package name
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} physical package root
 */
function findPackageRoot (packageName, projectRoot, repositoryRoot) {
  const ownPackage = readJson(path.join(projectRoot, 'package.json'))
  if (ownPackage?.name === packageName) return projectRoot

  let directory = projectRoot
  while (isPathInside(repositoryRoot, directory)) {
    const candidate = path.join(directory, 'node_modules', ...packageName.split('/'))
    try {
      const physical = fs.realpathSync(candidate)
      if (isPathInside(fs.realpathSync(repositoryRoot), physical)) return physical
    } catch {}
    if (directory === repositoryRoot) break
    directory = path.dirname(directory)
  }
}

/**
 * Returns a runner package name.
 *
 * @param {string} framework framework name
 * @returns {string} package name
 */
function getRunnerPackageName (framework) {
  return {
    cucumber: '@cucumber/cucumber',
    playwright: '@playwright/test',
  }[framework] || framework
}

/**
 * Returns a generated-test location that follows the representative discovery convention.
 *
 * @param {string} framework framework name
 * @param {string} representative representative test
 * @param {string} projectRoot detected project root
 * @returns {{exactFilename: string|undefined, fileExtension: string, testDirectory: string}} convention
 */
function getGeneratedTestConvention (framework, representative, projectRoot) {
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
    fileExtension: getTestExtension(framework, representative),
    testDirectory: path.dirname(representative),
  }
}

/**
 * Returns the complete suffix needed for framework discovery.
 *
 * @param {string} framework framework name
 * @param {string} representative representative test
 * @returns {string} generated test suffix
 */
function getTestExtension (framework, representative) {
  if (framework === 'cucumber') return '.feature'
  if (framework === 'cypress') return cypress.getTestExtension(representative)
  if (framework === 'playwright') return playwright.getTestExtension(representative)
  const match = /([.-](?:test|spec)\.[cm]?[jt]sx?)$/.exec(representative)
  if (match) return match[1]
  const moduleExtension = /\.([cm]js|[cm]ts)$/.exec(representative)?.[1]
  return moduleExtension ? `.test.${moduleExtension}` : '.test.js'
}

/**
 * Determines the generated JavaScript module system.
 *
 * @param {string} representative representative test
 * @param {string} projectRoot project root
 * @returns {'commonjs'|'esm'} module system
 */
function getModuleSystem (representative, projectRoot) {
  if (/\.(?:mjs|mts)$/.test(representative)) return 'esm'
  if (/\.(?:cjs|cts)$/.test(representative)) return 'commonjs'

  let directory = path.dirname(representative)
  while (isPathInside(projectRoot, directory)) {
    const packageJson = readJson(path.join(directory, 'package.json'))
    if (packageJson) return packageJson.type === 'module' ? 'esm' : 'commonjs'
    if (directory === projectRoot) break
    directory = path.dirname(directory)
  }
  return 'commonjs'
}

/**
 * Discovers bounded CI configuration paths without interpreting them.
 *
 * @param {string} root repository root
 * @returns {object} CI discovery data
 */
function discoverCiFiles (root) {
  const found = []
  for (const relativePath of CI_PATHS) {
    const absolutePath = path.join(root, relativePath)
    try {
      const stat = fs.lstatSync(absolutePath)
      if (stat.isSymbolicLink()) continue
      if (stat.isFile()) {
        found.push(relativePath)
      } else if (stat.isDirectory()) {
        for (const entry of readDirectoryEntries(absolutePath).slice(0, MAX_CI_FILES)) {
          if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) found.push(path.join(relativePath, entry.name))
        }
      }
    } catch {}
  }
  const normalized = found.map(filename => filename.split(path.sep).join('/')).sort()
  return {
    found: normalized,
    reviewRequired: normalized.length > 0,
    reviewTargets: rankCiReviewTargets(normalized).slice(0, MAX_CI_REVIEW_TARGETS),
    searched: CI_PATHS,
  }
}

/**
 * Ranks likely test workflows first.
 *
 * @param {string[]} files discovered CI paths
 * @returns {string[]} ranked paths
 */
function rankCiReviewTargets (files) {
  return [...files].sort((left, right) => getCiRank(left) - getCiRank(right) || left.localeCompare(right))
}

/**
 * Returns a lower-is-better CI review rank.
 *
 * @param {string} filename CI path
 * @returns {number} rank
 */
function getCiRank (filename) {
  const value = filename.toLowerCase()
  if (/test|ci|build|unit|integration/.test(value)) return 0
  return 10
}

/**
 * Finds the package manifest that owns a detection.
 *
 * @param {string} repositoryRoot repository root
 * @param {string|undefined} location detected relative path
 * @returns {{json: object, path: string}} package metadata
 */
function getDetectionPackageJson (repositoryRoot, location) {
  const candidate = typeof location === 'string' && path.basename(location) === 'package.json'
    ? path.resolve(repositoryRoot, location)
    : path.join(repositoryRoot, 'package.json')
  const json = readJson(candidate)
  if (json) return { json, path: candidate }
  return {
    json: readJson(path.join(repositoryRoot, 'package.json')) || {},
    path: path.join(repositoryRoot, 'package.json'),
  }
}

function getFrameworkPackageJson (repositoryRoot, detection) {
  const preciseLocation = detection.commandLocation ||
    detection.supportedVersion?.relativePath ||
    detection.eligibleCommand?.relativePath ||
    detection.versionLocation
  if (preciseLocation) return findOwningPackageJson(repositoryRoot, preciseLocation)

  const owners = new Map()
  if (detection.locations) {
    for (const location of detection.locations) {
      const owner = findOwningPackageJson(repositoryRoot, location)
      if (owner) owners.set(owner.path, owner)
    }
  }
  if (owners.size === 1) return [...owners.values()][0]
}

function findOwningPackageJson (repositoryRoot, location) {
  let candidate = path.resolve(repositoryRoot, location)
  if (!isPathInside(repositoryRoot, candidate)) return
  try {
    if (!fs.statSync(candidate).isDirectory()) candidate = path.dirname(candidate)
  } catch {
    candidate = path.dirname(candidate)
  }

  while (isPathInside(repositoryRoot, candidate)) {
    const packageJson = path.join(candidate, 'package.json')
    const json = readJson(packageJson)
    if (json) return { json, path: packageJson }
    if (candidate === repositoryRoot) return
    candidate = path.dirname(candidate)
  }
}

function getDetectionPackageLocation (detection) {
  return detection.commandLocation ||
    detection.supportedVersion?.relativePath ||
    detection.eligibleCommand?.relativePath ||
    detection.versionLocation ||
    detection.locations?.[0]
}

/**
 * Safely reads a bounded directory.
 *
 * @param {string} directory directory path
 * @returns {fs.Dirent[]} entries
 */
function readDirectoryEntries (directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).slice(0, MAX_DIRECTORY_ENTRIES)
  } catch {
    return []
  }
}

/**
 * Reads bounded UTF-8 source.
 *
 * @param {string} filename file path
 * @returns {string|undefined} source
 */
function readText (filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

/**
 * Reads JSON without throwing.
 *
 * @param {string} filename JSON path
 * @returns {object|undefined} parsed object
 */
function readJson (filename) {
  const source = readText(filename)
  if (source === undefined) return
  try {
    return JSON.parse(source)
  } catch {}
}

/**
 * Returns whether a framework target was selected.
 *
 * @param {string} framework framework id
 * @param {Set<string>} selected selected ids
 * @returns {boolean} selection result
 */
function isSelected (framework, selected) {
  return selected.size === 0 || selected.has(framework)
}

/**
 * Returns a stable project identifier.
 *
 * @param {object} packageJson package metadata
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @returns {string} project id
 */
function getProjectId (packageJson, projectRoot, repositoryRoot) {
  const value = packageJson.name || path.relative(repositoryRoot, projectRoot) || 'root'
  return value.replace(/^@/, '').replaceAll(/[^A-Za-z0-9_.-]+/g, '-')
}

/**
 * Detects package-manager metadata for reporting only.
 *
 * @param {string} root repository root
 * @returns {string} package manager
 */
function detectPackageManager (root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm'
  return 'unknown'
}

/**
 * Detects workspace metadata for reporting only.
 *
 * @param {string} root repository root
 * @returns {string} workspace manager
 */
function detectWorkspaceManager (root) {
  if (fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) return 'pnpm'
  const packageJson = readJson(path.join(root, 'package.json'))
  return packageJson?.workspaces ? detectPackageManager(root) : 'none'
}

/**
 * Returns a manifest operating-system name.
 *
 * @param {string} platform Node.js platform
 * @returns {string} OS name
 */
function getManifestOs (platform) {
  return platform === 'win32' ? 'windows' : platform
}

/**
 * Checks lexical path containment.
 *
 * @param {string} root root path
 * @param {string} filename candidate path
 * @returns {boolean} whether the candidate is contained
 */
function isPathInside (root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = { createManifestScaffold }
