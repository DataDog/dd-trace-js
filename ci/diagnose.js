#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const satisfies = require('../vendor/dist/semifies')
const { getEnvironmentVariables } = require('../packages/dd-trace/src/config/helper')
const { DD_MAJOR, VERSION } = require('../version')

const MAX_TEXT_FILE_SIZE = 512 * 1024
const MAX_SCANNED_FILES = 1500

const PACKAGE_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

const SKIPPED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.serverless',
  '.svn',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'tmp',
  'vendor',
])

const SKIPPED_FILES = new Set([
  'ci/diagnose.js',
])

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.env',
  '.js',
  '.json',
  '.mjs',
  '.mts',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])

const TEXT_FILE_NAMES = new Set([
  '.env',
  '.env.ci',
  '.env.local',
  '.env.test',
  '.npmrc',
  'Dockerfile',
  'Jenkinsfile',
  'Makefile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'package.json',
])

const NODE_OPTIONS_RE = /\bNODE_OPTIONS\b/
const INIT_PRELOAD_RE = /(?:^|\s)(?:-r|--require)(?:=|\s+)['"]?(?:dd-trace\/ci\/init|\.\/ci\/init)(?:\.js)?['"]?(?=$|\s|["'])/
const REGISTER_PRELOAD_RE = /(?:^|\s)(?:--import|-r|--require)(?:=|\s+)['"]?dd-trace\/register(?:\.js)?['"]?(?=$|\s|["'])/
const WRONG_INIT_RE = /dd-trace\/(?:init|initialize\.mjs)\b|require\(['"]dd-trace['"]\)\.init\s*\(/
const DIRECT_CI_INIT_RE = /(?:require\(|import\s+)['"]dd-trace\/ci\/init(?:\.js)?['"]/
const CI_DISABLED_RE = /DD_CIVISIBILITY_ENABLED["'\s:=]+(?:false|0)\b/i
const ITR_DISABLED_RE = /DD_CIVISIBILITY_ITR_ENABLED["'\s:=]+(?:false|0)\b/i
const GIT_UPLOAD_DISABLED_RE = /DD_CIVISIBILITY_GIT_UPLOAD_ENABLED["'\s:=]+(?:false|0)\b/i
const AGENTLESS_ENABLED_RE = /DD_CIVISIBILITY_AGENTLESS_ENABLED["'\s:=]+(?:true|1)\b/i
const API_KEY_RE = /\b(?:DD_API_KEY|DATADOG_API_KEY)\b/
const SERVICE_RE = /\bDD_SERVICE\b/
const OTEL_OTLP_RE = /OTEL_TRACES_EXPORTER["'\s:=]+otlp\b/i

const CYPRESS_MANUAL_PLUGIN_RE = /dd-trace\/ci\/cypress\/(?:plugin|after-run|after-spec)\b/
const CYPRESS_SUPPORT_RE = /dd-trace\/ci\/cypress\/support\b/
const CYPRESS_SUPPORT_DISABLED_RE = /supportFile\s*:\s*false|"supportFile"\s*:\s*false/
const CUCUMBER_PARALLEL_RE = /\bcucumber(?:-js)?\b[\s\S]{0,200}\s--parallel\b|--parallel\b[\s\S]{0,200}\bcucumber(?:-js)?\b/
const JEST_FORCE_EXIT_RE = /\bforceExit\s*:\s*true\b|--forceExit\b|"forceExit"\s*:\s*true/
const JEST_JASMINE_RE = /jest-jasmine2/

const CURRENT_ENV_PROVIDER_KEYS = [
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'JENKINS_URL',
  'BUILDKITE',
  'TRAVIS',
  'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER',
  'DRONE',
  'TEAMCITY_VERSION',
]

/**
 * Builds the framework support table for the tracer major version that is running this script.
 *
 * @param {number} ddMajor dd-trace major version
 * @returns {Array<object>} supported framework definitions
 */
function getFrameworkDefinitions (ddMajor) {
  return [
    {
      id: 'jest',
      name: 'Jest',
      packages: ['jest', '@jest/core'],
      commandPatterns: [/\bjest\b/],
      configPatterns: [/^jest\.config\./, /^config-jest\./],
      supportedRange: ddMajor >= 6 ? '>=28.0.0' : '>=24.8.0',
      recommendation: ddMajor >= 6
        ? 'Upgrade Jest to >=28.0.0, or use dd-trace v5 for older Jest versions.'
        : 'Upgrade Jest to >=24.8.0.',
    },
    {
      id: 'mocha',
      name: 'Mocha',
      packages: ['mocha'],
      commandPatterns: [/\bmocha\b/],
      configPatterns: [/^\.mocharc\./],
      supportedRange: ddMajor >= 6 ? '>=8.0.0' : '>=5.2.0',
      recommendation: ddMajor >= 6
        ? 'Upgrade Mocha to >=8.0.0, or use dd-trace v5 for older Mocha versions.'
        : 'Upgrade Mocha to >=5.2.0.',
      notes: [
        'Impacted tests are detected at suite level for Mocha.',
      ],
    },
    {
      id: 'cucumber',
      name: 'Cucumber',
      packages: ['@cucumber/cucumber'],
      commandPatterns: [/\bcucumber-js\b/, /\bcucumber\b/],
      configPatterns: [/^cucumber\./],
      supportedRange: '>=7.0.0',
      recommendation: 'Upgrade @cucumber/cucumber to >=7.0.0.',
    },
    {
      id: 'cypress',
      name: 'Cypress',
      packages: ['cypress'],
      commandPatterns: [/\bcypress\s+(?:run|open)\b/],
      configPatterns: [/^cypress\.config\./, /^cypress\.json$/],
      supportedRange: ddMajor >= 6 ? '>=12.0.0' : '>=6.7.0',
      autoInstrumentationRange: ddMajor >= 6 ? '>=12.0.0' : '>=10.2.0',
      recommendation: ddMajor >= 6
        ? 'Upgrade Cypress to >=12.0.0, or use dd-trace v5 for older Cypress versions.'
        : 'Upgrade Cypress to >=6.7.0.',
    },
    {
      id: 'playwright',
      name: 'Playwright',
      packages: ['@playwright/test', 'playwright'],
      commandPatterns: [/\bplaywright\s+test\b/],
      configPatterns: [/^playwright\.config\./],
      supportedRange: ddMajor >= 6 ? '>=1.38.0' : '>=1.18.0',
      recommendation: ddMajor >= 6
        ? 'Upgrade Playwright to >=1.38.0, or use dd-trace v5 for older Playwright versions.'
        : 'Upgrade Playwright to >=1.18.0.',
      notes: [
        'Test Impact Analysis suite skipping is not supported for Playwright.',
        'Impacted tests are detected at suite level for Playwright.',
      ],
    },
    {
      id: 'vitest',
      name: 'Vitest',
      packages: ['vitest'],
      commandPatterns: [/\bvitest\b/],
      configPatterns: [/^vitest\.config\./, /^vite\.config\./],
      supportedRange: '>=1.6.0',
      recommendation: 'Upgrade Vitest to >=1.6.0.',
      notes: [
        'Test Impact Analysis suite skipping is not supported for Vitest.',
        'Impacted tests are detected at suite level for Vitest.',
      ],
      esmInitialization: true,
    },
  ]
}

const UNSUPPORTED_FRAMEWORKS = [
  {
    id: 'node-test',
    name: 'Node.js test runner',
    packages: [],
    commandPatterns: [/\bnode\s+--test\b/, /\bnode\s+--experimental-test-coverage\b/],
  },
  { id: 'ava', name: 'AVA', packages: ['ava'], commandPatterns: [/\bava\b/] },
  { id: 'tap', name: 'tap', packages: ['tap'], commandPatterns: [/\btap\b/] },
  { id: 'jasmine', name: 'Jasmine', packages: ['jasmine'], commandPatterns: [/\bjasmine\b/] },
  { id: 'karma', name: 'Karma', packages: ['karma'], commandPatterns: [/\bkarma\b/] },
  { id: 'uvu', name: 'uvu', packages: ['uvu'], commandPatterns: [/\buvu\b/] },
  {
    id: 'testcafe',
    name: 'TestCafe',
    packages: ['testcafe'],
    commandPatterns: [/\btestcafe\b/],
  },
]

/**
 * Runs all static checks for a repository.
 *
 * @param {object} [options] diagnosis options
 * @param {string} [options.root] repository path to inspect
 * @param {NodeJS.ProcessEnv} [options.env] environment to inspect
 * @param {Function} [options.execFile] command runner used for git checks
 * @param {number} [options.maxFiles] maximum number of text files to scan
 * @returns {object} diagnosis report
 */
function runDiagnosis (options = {}) {
  const root = path.resolve(options.root || process.cwd())
  const env = options.env || getEnvironmentVariables()
  const execFile = options.execFile || execFileSync
  const maxFiles = options.maxFiles || MAX_SCANNED_FILES
  const results = []
  const files = collectTextFiles(root, maxFiles)
  const textFiles = readTextFiles(root, files)
  const manifests = readPackageManifests(root, textFiles)
  const rootManifest = manifests.find(manifest => manifest.relativePath === 'package.json')
  const scripts = collectScripts(manifests)
  const workflowFiles = textFiles.filter(file => isWorkflowFile(file.relativePath))
  const definitions = getFrameworkDefinitions(DD_MAJOR)
  const supportedFrameworks = detectSupportedFrameworks(root, definitions, manifests, scripts, textFiles)
  const unsupportedFrameworks = detectUnsupportedFrameworks(UNSUPPORTED_FRAMEWORKS, manifests, scripts)
  const evidence = collectEvidence(textFiles, env)

  checkPackageManifest(results, rootManifest)
  checkDdTraceDependency(results, manifests)
  checkSupportedFrameworks(results, supportedFrameworks)
  checkUnsupportedFrameworks(results, unsupportedFrameworks, supportedFrameworks)
  checkInitialization(results, supportedFrameworks, evidence, env)
  checkFrameworkConfiguration(results, supportedFrameworks, evidence, textFiles)
  checkCiConfiguration(results, workflowFiles, evidence, env)
  checkGit(results, root, env, execFile)
  checkCurrentEnvironment(results, env, evidence)

  return {
    root,
    ddTraceVersion: VERSION,
    ddTraceMajor: DD_MAJOR,
    scannedFileCount: textFiles.length,
    truncatedFileScan: files.truncated,
    supportedFrameworks: supportedFrameworks.map(serializeSupportedFramework),
    unsupportedFrameworks: unsupportedFrameworks.map(serializeUnsupportedFramework),
    results,
  }
}

/**
 * Turns a diagnosis report into human-readable text.
 *
 * @param {object} report diagnosis report
 * @returns {string} formatted report
 */
function renderText (report) {
  const counts = countByStatus(report.results)
  const lines = [
    'Datadog Test Optimization diagnosis',
    `Repository: ${report.root}`,
    `dd-trace: ${report.ddTraceVersion}`,
    `Files scanned: ${report.scannedFileCount}${report.truncatedFileScan ? ' (truncated)' : ''}`,
    '',
  ]

  if (report.results.length === 0) {
    lines.push('[ok] No issues found.')
  } else {
    for (const result of report.results) {
      lines.push(`[${result.status}] ${result.title}`)
      if (result.message) {
        lines.push(`  ${result.message}`)
      }
      if (result.locations?.length) {
        lines.push(`  Locations: ${formatLocations(result.locations)}`)
      }
      if (result.recommendation) {
        lines.push(`  Recommendation: ${result.recommendation}`)
      }
      lines.push('')
    }
  }

  lines.push(`Summary: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info, ${counts.ok} ok`)
  return lines.join('\n').trimEnd()
}

/**
 * Computes the CLI exit code for a report and fail policy.
 *
 * @param {object} report diagnosis report
 * @param {string} failOn one of "error", "warning", or "never"
 * @returns {number} process exit code
 */
function getExitCode (report, failOn) {
  if (failOn === 'never') return 0

  for (const result of report.results) {
    if (result.status === 'error') return 1
    if (failOn === 'warning' && result.status === 'warning') return 1
  }
  return 0
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const parsed = {
    root: process.cwd(),
    json: false,
    failOn: 'error',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--path' || arg === '--root') {
      parsed.root = args[++i]
    } else if (arg.startsWith('--path=')) {
      parsed.root = arg.slice('--path='.length)
    } else if (arg.startsWith('--root=')) {
      parsed.root = arg.slice('--root='.length)
    } else if (arg === '--fail-on') {
      parsed.failOn = args[++i]
    } else if (arg.startsWith('--fail-on=')) {
      parsed.failOn = arg.slice('--fail-on='.length)
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else {
      parsed.unknown = arg
    }
  }

  return parsed
}

/**
 * Returns help text for the CLI.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-diagnose [--path <repository>] [--json] [--fail-on error|warning|never]',
    '',
    'Static checks only. The script reads repository files, package manifests, CI config,',
    'and the current environment. It does not contact Datadog or any package registry.',
  ].join('\n')
}

/**
 * Adds a normalized result to the list.
 *
 * @param {Array<object>} results mutable result list
 * @param {string} status result status
 * @param {string} title short title
 * @param {string} message result details
 * @param {object} [extra] optional fields
 */
function addResult (results, status, title, message, extra = {}) {
  results.push({
    status,
    title,
    message,
    ...extra,
  })
}

/**
 * Reads package.json files collected by the repository scan.
 *
 * @param {string} root repository root
 * @param {Array<object>} textFiles scanned text files
 * @returns {Array<object>} parsed package manifests
 */
function readPackageManifests (root, textFiles) {
  const manifests = []

  for (const file of textFiles) {
    if (path.basename(file.relativePath) !== 'package.json') continue

    const json = parseJson(file.content)
    if (!json) continue

    manifests.push({
      path: path.join(root, file.relativePath),
      relativePath: file.relativePath,
      json,
    })
  }

  return manifests
}

/**
 * Checks that a root package.json exists.
 *
 * @param {Array<object>} results mutable result list
 * @param {object|undefined} rootManifest parsed root package manifest
 */
function checkPackageManifest (results, rootManifest) {
  if (rootManifest) {
    addResult(results, 'ok', 'Root package.json found', 'Dependency and script checks can inspect package metadata.')
    return
  }

  addResult(
    results,
    'warning',
    'No root package.json found',
    'The diagnosis could not inspect root dependencies or package scripts.',
    { recommendation: 'Run this script from the JavaScript repository root, or pass --path <repository>.' }
  )
}

/**
 * Checks whether dd-trace is declared in repository manifests.
 *
 * @param {Array<object>} results mutable result list
 * @param {Array<object>} manifests package manifests
 */
function checkDdTraceDependency (results, manifests) {
  const entries = findDependencyEntries(manifests, ['dd-trace'])

  if (entries.length) {
    addResult(
      results,
      'ok',
      'dd-trace dependency found',
      `Detected dd-trace in ${formatLocations(entries.map(entry => entry.relativePath))}.`
    )
    return
  }

  addResult(
    results,
    'warning',
    'dd-trace dependency not found in package.json',
    'The script did not find dd-trace in dependencies or devDependencies.',
    { recommendation: 'Install dd-trace in the project that runs the tests.' }
  )
}

/**
 * Checks supported framework detections and versions.
 *
 * @param {Array<object>} results mutable result list
 * @param {Array<object>} frameworks detected supported frameworks
 */
function checkSupportedFrameworks (results, frameworks) {
  if (!frameworks.length) {
    addResult(
      results,
      'warning',
      'No supported test framework detected',
      'No supported Test Optimization framework was found in dependencies, scripts, or config files.',
      {
        recommendation:
          'Use Jest, Mocha, Cucumber, Cypress, Playwright, or Vitest with a supported version.',
      }
    )
    return
  }

  for (const framework of frameworks) {
    if (!framework.versionDetections.length) {
      addResult(
        results,
        'warning',
        `${framework.name} detected but version is unknown`,
        `${framework.name} appears in scripts or config, but no package version could be determined.`,
        {
          locations: framework.locations,
          recommendation:
            `Ensure ${framework.packages.join(' or ')} is installed and matches ${framework.supportedRange}.`,
        }
      )
    }

    for (const detection of framework.versionDetections) {
      if (!detection.version) {
        addResult(
          results,
          'warning',
          `${framework.name} version could not be determined`,
          `Detected ${detection.packageName}@${detection.rawVersion}, but the version is not statically comparable.`,
          {
            locations: [detection.relativePath],
            recommendation: `Verify ${framework.name} satisfies ${framework.supportedRange}.`,
          }
        )
        continue
      }

      const status = satisfies(detection.version, framework.supportedRange) ? 'ok' : 'error'
      const source = detection.source === 'installed' ? 'installed package' : 'package manifest'
      addResult(
        results,
        status,
        `${framework.name} ${detection.version} ${status === 'ok' ? 'is supported' : 'is not supported'}`,
        `Detected ${detection.packageName}@${detection.rawVersion} from ${source}; supported range is ` +
          `${framework.supportedRange}.`,
        {
          locations: detection.relativePath ? [detection.relativePath] : undefined,
          recommendation: status === 'error' ? framework.recommendation : undefined,
        }
      )
    }

    for (const note of framework.notes || []) {
      addResult(results, 'info', `${framework.name} capability note`, note)
    }
  }
}

/**
 * Checks unsupported framework detections.
 *
 * @param {Array<object>} results mutable result list
 * @param {Array<object>} unsupported detected unsupported frameworks
 * @param {Array<object>} supported detected supported frameworks
 */
function checkUnsupportedFrameworks (results, unsupported, supported) {
  for (const framework of unsupported) {
    const status = supported.length ? 'warning' : 'error'
    addResult(
      results,
      status,
      `${framework.name} is not supported by Test Optimization`,
      `${framework.name} was detected in dependencies or test scripts.`,
      {
        locations: framework.locations,
        recommendation:
          'Use a supported JavaScript test framework for automatic Test Optimization instrumentation.',
      }
    )
  }
}

/**
 * Checks Test Optimization initialization.
 *
 * @param {Array<object>} results mutable result list
 * @param {Array<object>} frameworks detected supported frameworks
 * @param {object} evidence repository evidence
 * @param {NodeJS.ProcessEnv} env environment
 */
function checkInitialization (results, frameworks, evidence, env) {
  if (!frameworks.length) return

  const hasCiInit = evidence.hasCiInit || hasCiInitInNodeOptions(env.NODE_OPTIONS)
  const hasCypressOnly = frameworks.length === 1 && frameworks[0].id === 'cypress'
  const hasCypressManualPlugin = evidence.cypressManualPluginLocations.length > 0

  if (hasCiInit) {
    addResult(
      results,
      'ok',
      'Test Optimization initialization found',
      'Found dd-trace/ci/init preloaded through NODE_OPTIONS in repository files or the current environment.',
      { locations: evidence.ciInitLocations }
    )
  } else if (hasCypressOnly && hasCypressManualPlugin) {
    addResult(
      results,
      'ok',
      'Cypress manual plugin initialization found',
      'Found the Cypress-specific dd-trace Test Optimization plugin setup.',
      { locations: evidence.cypressManualPluginLocations }
    )
  } else {
    addResult(
      results,
      'error',
      'Missing Test Optimization initialization',
      'No NODE_OPTIONS preload for dd-trace/ci/init was found in repository files or the current environment.',
      {
        recommendation:
          'Run tests with NODE_OPTIONS="-r dd-trace/ci/init". For ESM test runners, also include ' +
          '--import dd-trace/register.js.',
      }
    )
  }

  if (evidence.directCiInitLocations.length) {
    addResult(
      results,
      'error',
      'Test Optimization initialization is imported directly',
      'The diagnosis found require("dd-trace/ci/init") or import "dd-trace/ci/init". ' +
        'That does not preload the tracer early enough for Test Optimization setup.',
      {
        locations: evidence.directCiInitLocations,
        recommendation: 'Set NODE_OPTIONS="-r dd-trace/ci/init" on the test process instead.',
      }
    )
  }

  if (evidence.wrongInitLocations.length) {
    addResult(
      results,
      'error',
      'Plain dd-trace initialization found in test setup',
      'The diagnosis found dd-trace/init, dd-trace/initialize.mjs, or require("dd-trace").init(). ' +
        'That does not initialize the tracer in Test Optimization mode.',
      {
        locations: evidence.wrongInitLocations,
        recommendation: 'Use dd-trace/ci/init for test commands instead of the plain tracing initializer.',
      }
    )
  }

  if (frameworks.some(framework => framework.esmInitialization) && hasCiInit && !evidence.hasRegister &&
    !hasRegisterInNodeOptions(env.NODE_OPTIONS)) {
    addResult(
      results,
      'warning',
      'ESM loader registration not found',
      'Vitest and other ESM-heavy test runners often need dd-trace/register.js before dd-trace/ci/init.',
      {
        recommendation:
          'Use NODE_OPTIONS="--import dd-trace/register.js -r dd-trace/ci/init" for ESM test runs.',
      }
    )
  }
}

/**
 * Checks framework-specific configuration pitfalls.
 *
 * @param {Array<object>} results mutable result list
 * @param {Array<object>} frameworks detected supported frameworks
 * @param {object} evidence repository evidence
 * @param {Array<object>} textFiles scanned text files
 */
function checkFrameworkConfiguration (results, frameworks, evidence, textFiles) {
  if (hasFramework(frameworks, 'cypress')) {
    checkCypressConfiguration(results, evidence)
  }

  if (hasFramework(frameworks, 'jest')) {
    const jestLocations = findLocations(textFiles, JEST_FORCE_EXIT_RE)
    if (jestLocations.length) {
      addResult(
        results,
        'warning',
        'Jest forceExit can drop Test Optimization data',
        'Jest\'s forceExit option can terminate before dd-trace flushes all test data.',
        {
          locations: jestLocations,
          recommendation: 'Remove --forceExit or forceExit: true from Jest configuration when possible.',
        }
      )
    }

    const jasmineLocations = findLocations(textFiles, JEST_JASMINE_RE)
    if (jasmineLocations.length) {
      addResult(
        results,
        'info',
        'Jest is configured with jest-jasmine2',
        'dd-trace can avoid crashing with jest-jasmine2, but jest-circus is the better-supported runner.',
        {
          locations: jasmineLocations,
          recommendation: 'Prefer the default jest-circus runner on supported Jest versions.',
        }
      )
    }
  }

  if (hasFramework(frameworks, 'cucumber')) {
    const cucumber = frameworks.find(framework => framework.id === 'cucumber')
    const parallelLocations = findLocations(textFiles, CUCUMBER_PARALLEL_RE)
    const hasOldParallel = cucumber.versionDetections.some(detection =>
      detection.version && !satisfies(detection.version, '>=11.0.0')
    )

    if (parallelLocations.length && hasOldParallel) {
      addResult(
        results,
        'warning',
        'Cucumber parallel mode has feature limits before version 11',
        'Some Test Optimization features for Cucumber parallel mode require @cucumber/cucumber >=11.0.0.',
        {
          locations: parallelLocations,
          recommendation: 'Upgrade @cucumber/cucumber to >=11.0.0 when using --parallel.',
        }
      )
    }
  }
}

/**
 * Checks Cypress-specific setup.
 *
 * @param {Array<object>} results mutable result list
 * @param {object} evidence repository evidence
 */
function checkCypressConfiguration (results, evidence) {
  if (evidence.cypressSupportDisabledLocations.length) {
    addResult(
      results,
      'warning',
      'Cypress support file is disabled',
      'Cypress browser-side hooks cannot be injected when supportFile is false.',
      {
        locations: evidence.cypressSupportDisabledLocations,
        recommendation: 'Use a Cypress support file, or manually require dd-trace/ci/cypress/support.',
      }
    )
    return
  }

  if (evidence.cypressSupportLocations.length) {
    addResult(
      results,
      'ok',
      'Cypress support hook found',
      'Found dd-trace/ci/cypress/support in the repository.',
      { locations: evidence.cypressSupportLocations }
    )
  } else {
    addResult(
      results,
      'info',
      'Cypress support hook not explicitly configured',
      'For supported Cypress versions, dd-trace can inject a temporary support wrapper when dd-trace/ci/init is used.',
      {
        recommendation:
          'If browser-side test events are missing, add require("dd-trace/ci/cypress/support") to the ' +
          'Cypress support file.',
      }
    )
  }
}

/**
 * Checks static CI workflow files.
 *
 * @param {Array<object>} results mutable result list
 * @param {Array<object>} workflowFiles scanned CI workflow files
 * @param {object} evidence repository evidence
 * @param {NodeJS.ProcessEnv} env environment
 */
function checkCiConfiguration (results, workflowFiles, evidence, env) {
  if (!workflowFiles.length) {
    addResult(
      results,
      'info',
      'No CI workflow files found',
      'The diagnosis did not find common CI configuration files to inspect.'
    )
    return
  }

  addResult(
    results,
    'ok',
    'CI workflow files found',
    `Inspected ${workflowFiles.length} CI workflow file(s).`,
    { locations: workflowFiles.map(file => file.relativePath) }
  )

  if (!evidence.hasCiInit && !hasCiInitInNodeOptions(env.NODE_OPTIONS)) {
    addResult(
      results,
      'warning',
      'CI workflows do not show Test Optimization initialization',
      'No CI workflow file shows NODE_OPTIONS preloading dd-trace/ci/init.',
      {
        recommendation:
          'Set NODE_OPTIONS="-r dd-trace/ci/init" in the CI job that runs the supported JavaScript test framework.',
      }
    )
  }

  const shallowGithubLocations = []
  const containerGithubLocations = []

  for (const file of workflowFiles) {
    if (!file.relativePath.startsWith('.github/workflows/')) continue

    if (/actions\/checkout/.test(file.content) && !/fetch-depth\s*:\s*0\b/.test(file.content)) {
      shallowGithubLocations.push(file.relativePath)
    }

    if (/\bcontainer\s*:/.test(file.content) && !/safe\.directory/.test(file.content)) {
      containerGithubLocations.push(file.relativePath)
    }
  }

  if (shallowGithubLocations.length) {
    addResult(
      results,
      'warning',
      'GitHub Actions checkout may be shallow',
      'actions/checkout defaults to a shallow checkout, which can limit git metadata and impacted-test detection.',
      {
        locations: shallowGithubLocations,
        recommendation: 'Set fetch-depth: 0 for the checkout step, or keep git unshallowing enabled.',
      }
    )
  }

  if (containerGithubLocations.length) {
    addResult(
      results,
      'info',
      'Containerized GitHub jobs may need Git safe.directory',
      'Git can reject metadata commands in containerized jobs when checkout ownership differs from the container user.',
      {
        locations: containerGithubLocations,
        recommendation: 'Run git config --global --add safe.directory "$GITHUB_WORKSPACE" when needed.',
      }
    )
  }

  if (evidence.hasAgentlessEnabled && !evidence.hasApiKey && !env.DD_API_KEY && !env.DATADOG_API_KEY) {
    addResult(
      results,
      'warning',
      'Agentless mode is enabled but no API key reference was found',
      'DD_CIVISIBILITY_AGENTLESS_ENABLED requires DD_API_KEY or DATADOG_API_KEY at runtime.',
      {
        recommendation: 'Provide DD_API_KEY or DATADOG_API_KEY as a CI secret in the test job.',
      }
    )
  }

  if (evidence.gitStrategyNoneLocations.length) {
    addResult(
      results,
      'warning',
      'CI configuration disables git checkout',
      'Git metadata extraction cannot work when the CI job does not check out the repository.',
      {
        locations: evidence.gitStrategyNoneLocations,
        recommendation: 'Enable repository checkout for Test Optimization jobs.',
      }
    )
  }
}

/**
 * Checks local git availability and repository metadata.
 *
 * @param {Array<object>} results mutable result list
 * @param {string} root repository root
 * @param {NodeJS.ProcessEnv} env environment
 * @param {Function} execFile command runner
 */
function checkGit (results, root, env, execFile) {
  if (!canRunGit(execFile, root)) {
    addResult(
      results,
      'error',
      'git executable is not available',
      'Test Optimization uses git to extract repository metadata and impacted files.',
      { recommendation: 'Install git in the CI image or runner that executes tests.' }
    )
    return
  }

  addResult(results, 'ok', 'git executable found', 'The current environment can execute git.')

  const insideWorktree = runGit(execFile, root, ['rev-parse', '--is-inside-work-tree'])
  if (insideWorktree !== 'true') {
    addResult(
      results,
      'warning',
      'Current path is not inside a git worktree',
      'Git metadata extraction needs the checked-out repository.',
      { recommendation: 'Run the test command from inside the checked-out repository.' }
    )
    return
  }

  const head = runGit(execFile, root, ['rev-parse', 'HEAD'])
  const remote = runGit(execFile, root, ['config', '--get', 'remote.origin.url'])
  const branch = runGit(execFile, root, ['branch', '--show-current'])
  const shallow = runGit(execFile, root, ['rev-parse', '--is-shallow-repository'])

  if (head) {
    addResult(results, 'ok', 'git commit SHA detected', `Current HEAD is ${head.slice(0, 12)}.`)
  } else {
    addResult(
      results,
      'warning',
      'git commit SHA could not be detected',
      'The diagnosis could not read git rev-parse HEAD.',
      { recommendation: 'Ensure the CI checkout includes a valid git repository.' }
    )
  }

  if (!remote) {
    addResult(
      results,
      'warning',
      'git remote origin is not configured',
      'Repository URL metadata may be missing.',
      { recommendation: 'Configure remote.origin.url or provide DD_GIT_REPOSITORY_URL.' }
    )
  }

  if (!branch && !hasBranchMetadata(env)) {
    addResult(
      results,
      'warning',
      'git branch metadata could not be detected',
      'The checkout appears detached and no CI branch metadata was found in the current environment.',
      { recommendation: 'Provide branch metadata through CI provider variables or DD_GIT_BRANCH.' }
    )
  }

  if (shallow === 'true') {
    addResult(
      results,
      'warning',
      'Repository is shallow',
      'A shallow repository can limit metadata upload and impacted-test detection.',
      { recommendation: 'Use a full checkout, or keep DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED enabled.' }
    )
  }
}

/**
 * Checks current environment variables relevant to Test Optimization.
 *
 * @param {Array<object>} results mutable result list
 * @param {NodeJS.ProcessEnv} env environment
 * @param {object} evidence repository evidence
 */
function checkCurrentEnvironment (results, env, evidence) {
  if (isFalseLike(env.DD_CIVISIBILITY_ENABLED) || evidence.hasCiVisibilityDisabled) {
    addResult(
      results,
      'error',
      'Test Optimization is explicitly disabled',
      'DD_CIVISIBILITY_ENABLED is set to false or 0.',
      { recommendation: 'Remove DD_CIVISIBILITY_ENABLED=false from the test job.' }
    )
  }

  if (isFalseLike(env.DD_CIVISIBILITY_ITR_ENABLED) || evidence.hasItrDisabled) {
    addResult(
      results,
      'warning',
      'Test Impact Analysis is disabled',
      'DD_CIVISIBILITY_ITR_ENABLED is set to false or 0.',
      { recommendation: 'Remove DD_CIVISIBILITY_ITR_ENABLED=false if suite skipping should be enabled.' }
    )
  }

  if (isFalseLike(env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED) || evidence.hasGitUploadDisabled) {
    addResult(
      results,
      'warning',
      'Git metadata upload is disabled',
      'DD_CIVISIBILITY_GIT_UPLOAD_ENABLED is set to false or 0.',
      { recommendation: 'Remove DD_CIVISIBILITY_GIT_UPLOAD_ENABLED=false unless this is intentional.' }
    )
  }

  if (isTrueLike(env.DD_CIVISIBILITY_AGENTLESS_ENABLED) && !env.DD_API_KEY && !env.DATADOG_API_KEY) {
    addResult(
      results,
      'error',
      'Agentless mode is missing an API key',
      'The current environment has DD_CIVISIBILITY_AGENTLESS_ENABLED set, but no DD_API_KEY or DATADOG_API_KEY.',
      { recommendation: 'Set DD_API_KEY or DATADOG_API_KEY in the CI job.' }
    )
  }

  if (!env.DD_SERVICE && !evidence.hasService) {
    addResult(
      results,
      'warning',
      'DD_SERVICE was not found',
      'A missing service name makes Test Optimization data harder to find and group.',
      { recommendation: 'Set DD_SERVICE in the test job.' }
    )
  }

  if ((env.OTEL_TRACES_EXPORTER || '').toLowerCase() === 'otlp' || evidence.hasOtelOtlpExporter) {
    addResult(
      results,
      'warning',
      'OTEL_TRACES_EXPORTER=otlp was found',
      'An OTLP traces exporter can interfere with dd-trace test payloads in instrumented shells.',
      { recommendation: 'Unset OTEL_TRACES_EXPORTER for dd-trace Test Optimization jobs.' }
    )
  }

  if (env.CI) {
    checkCurrentCiMetadata(results, env)
  } else {
    addResult(
      results,
      'info',
      'Current process is not running in CI',
      'Runtime CI metadata checks were skipped because CI is not set in the current environment.'
    )
  }
}

/**
 * Checks current CI provider metadata.
 *
 * @param {Array<object>} results mutable result list
 * @param {NodeJS.ProcessEnv} env environment
 */
function checkCurrentCiMetadata (results, env) {
  const providerDetected = CURRENT_ENV_PROVIDER_KEYS.some(key => env[key])
  if (!providerDetected) {
    addResult(
      results,
      'warning',
      'Current CI provider is not recognized',
      'The current environment has CI set, but no known CI provider variables were found.',
      { recommendation: 'Provide CI and git metadata with DD_GIT_* variables if the provider is custom.' }
    )
  }

  if (!hasShaMetadata(env)) {
    addResult(
      results,
      'warning',
      'Current CI commit SHA metadata is missing',
      'The current CI environment does not expose a recognized commit SHA variable.',
      { recommendation: 'Provide DD_GIT_COMMIT_SHA when the CI provider does not expose one.' }
    )
  }

  if (!hasBranchMetadata(env)) {
    addResult(
      results,
      'warning',
      'Current CI branch metadata is missing',
      'The current CI environment does not expose a recognized branch or tag variable.',
      { recommendation: 'Provide DD_GIT_BRANCH or DD_GIT_TAG when the CI provider does not expose one.' }
    )
  }
}

/**
 * Collects package scripts from all manifests.
 *
 * @param {Array<object>} manifests package manifests
 * @returns {Array<object>} scripts
 */
function collectScripts (manifests) {
  const scripts = []

  for (const manifest of manifests) {
    const manifestScripts = manifest.json.scripts || {}
    for (const [name, command] of Object.entries(manifestScripts)) {
      if (typeof command !== 'string') continue

      scripts.push({
        name,
        command,
        relativePath: manifest.relativePath,
      })
    }
  }

  return scripts
}

/**
 * Detects supported test frameworks.
 *
 * @param {string} root repository root
 * @param {Array<object>} definitions framework definitions
 * @param {Array<object>} manifests package manifests
 * @param {Array<object>} scripts package scripts
 * @param {Array<object>} textFiles scanned text files
 * @returns {Array<object>} detected supported frameworks
 */
function detectSupportedFrameworks (root, definitions, manifests, scripts, textFiles) {
  const frameworks = []

  for (const definition of definitions) {
    const dependencyEntries = findDependencyEntries(manifests, definition.packages)
    const scriptMatches = findScriptMatches(scripts, definition.commandPatterns)
    const configMatches = findConfigMatches(textFiles, definition.configPatterns)

    if (!dependencyEntries.length && !scriptMatches.length && !configMatches.length) continue

    frameworks.push({
      ...definition,
      dependencyEntries,
      scriptMatches,
      configMatches,
      locations: unique([
        ...dependencyEntries.map(entry => entry.relativePath),
        ...scriptMatches.map(script => script.relativePath),
        ...configMatches,
      ]),
      versionDetections: getVersionDetections(root, definition.packages, dependencyEntries),
    })
  }

  return frameworks
}

/**
 * Detects unsupported test frameworks.
 *
 * @param {Array<object>} definitions unsupported framework definitions
 * @param {Array<object>} manifests package manifests
 * @param {Array<object>} scripts package scripts
 * @returns {Array<object>} detected unsupported frameworks
 */
function detectUnsupportedFrameworks (definitions, manifests, scripts) {
  const frameworks = []

  for (const definition of definitions) {
    const dependencyEntries = findDependencyEntries(manifests, definition.packages)
    const scriptMatches = findScriptMatches(scripts, definition.commandPatterns)

    if (!dependencyEntries.length && !scriptMatches.length) continue

    frameworks.push({
      ...definition,
      locations: unique([
        ...dependencyEntries.map(entry => entry.relativePath),
        ...scriptMatches.map(script => script.relativePath),
      ]),
    })
  }

  return frameworks
}

/**
 * Collects useful boolean evidence from scanned files and environment.
 *
 * @param {Array<object>} textFiles scanned text files
 * @param {NodeJS.ProcessEnv} env environment
 * @returns {object} evidence object
 */
function collectEvidence (textFiles, env) {
  const ciInitLocations = findNodeOptionsPreloadLocations(textFiles, INIT_PRELOAD_RE)
  const registerLocations = findNodeOptionsPreloadLocations(textFiles, REGISTER_PRELOAD_RE)

  return {
    ciInitLocations,
    directCiInitLocations: findLocations(textFiles, DIRECT_CI_INIT_RE),
    wrongInitLocations: findLocations(textFiles, WRONG_INIT_RE),
    cypressManualPluginLocations: findLocations(textFiles, CYPRESS_MANUAL_PLUGIN_RE),
    cypressSupportLocations: findLocations(textFiles, CYPRESS_SUPPORT_RE),
    cypressSupportDisabledLocations: findLocations(textFiles, CYPRESS_SUPPORT_DISABLED_RE),
    gitStrategyNoneLocations: findLocations(textFiles, /GIT_STRATEGY\s*:\s*none\b/i),
    hasCiInit: ciInitLocations.length > 0,
    hasRegister: registerLocations.length > 0,
    hasCiVisibilityDisabled: findLocations(textFiles, CI_DISABLED_RE).length > 0,
    hasItrDisabled: findLocations(textFiles, ITR_DISABLED_RE).length > 0,
    hasGitUploadDisabled: findLocations(textFiles, GIT_UPLOAD_DISABLED_RE).length > 0,
    hasAgentlessEnabled: findLocations(textFiles, AGENTLESS_ENABLED_RE).length > 0 ||
      isTrueLike(env.DD_CIVISIBILITY_AGENTLESS_ENABLED),
    hasApiKey: findLocations(textFiles, API_KEY_RE).length > 0,
    hasService: findLocations(textFiles, SERVICE_RE).length > 0,
    hasOtelOtlpExporter: findLocations(textFiles, OTEL_OTLP_RE).length > 0,
  }
}

/**
 * Finds dependency entries in package manifests.
 *
 * @param {Array<object>} manifests package manifests
 * @param {string[]} packageNames package names
 * @returns {Array<object>} matching dependency entries
 */
function findDependencyEntries (manifests, packageNames) {
  const entries = []
  const packageSet = new Set(packageNames)

  for (const manifest of manifests) {
    for (const section of PACKAGE_SECTIONS) {
      const dependencies = manifest.json[section]
      if (!dependencies) continue

      for (const [name, range] of Object.entries(dependencies)) {
        if (!packageSet.has(name)) continue

        entries.push({
          packageName: name,
          rawVersion: String(range),
          section,
          relativePath: manifest.relativePath,
        })
      }
    }
  }

  return entries
}

/**
 * Resolves framework package versions from installed modules and manifest ranges.
 *
 * @param {string} root repository root
 * @param {string[]} packageNames package names
 * @param {Array<object>} dependencyEntries dependency entries
 * @returns {Array<object>} version detections
 */
function getVersionDetections (root, packageNames, dependencyEntries) {
  const detections = []
  const installed = []

  for (const packageName of packageNames) {
    const version = getInstalledPackageVersion(root, packageName)
    if (version) {
      installed.push({
        packageName,
        rawVersion: version,
        version,
        source: 'installed',
      })
    }
  }

  if (installed.length) return installed

  for (const entry of dependencyEntries) {
    detections.push({
      packageName: entry.packageName,
      rawVersion: entry.rawVersion,
      version: coerceVersion(entry.rawVersion),
      relativePath: entry.relativePath,
      source: 'manifest',
    })
  }

  return uniqueVersionDetections(detections)
}

/**
 * Reads an installed package version from node_modules.
 *
 * @param {string} root repository root
 * @param {string} packageName package name
 * @returns {string|undefined} installed version
 */
function getInstalledPackageVersion (root, packageName) {
  const packageJsonPath = path.join(root, 'node_modules', ...packageName.split('/'), 'package.json')
  const json = readJsonFile(packageJsonPath)
  return typeof json?.version === 'string' ? json.version : undefined
}

/**
 * Finds scripts matching any pattern.
 *
 * @param {Array<object>} scripts package scripts
 * @param {RegExp[]} patterns command patterns
 * @returns {Array<object>} matching scripts
 */
function findScriptMatches (scripts, patterns) {
  const matches = []

  for (const script of scripts) {
    if (!/test|spec|e2e|integration|unit/i.test(script.name) &&
      !patterns.some(pattern => pattern.test(script.command))) {
      continue
    }

    if (patterns.some(pattern => pattern.test(script.command))) {
      matches.push(script)
    }
  }

  return matches
}

/**
 * Finds scanned config files that match definition patterns.
 *
 * @param {Array<object>} textFiles scanned text files
 * @param {RegExp[]} patterns filename patterns
 * @returns {string[]} matching relative paths
 */
function findConfigMatches (textFiles, patterns) {
  const matches = []

  for (const file of textFiles) {
    const basename = path.basename(file.relativePath)
    if (patterns.some(pattern => pattern.test(basename))) {
      matches.push(file.relativePath)
    }
  }

  return matches
}

/**
 * Finds files where NODE_OPTIONS appears close to a supported Node preload option.
 *
 * @param {Array<object>} textFiles scanned text files
 * @param {RegExp} preloadPattern Node preload option pattern
 * @returns {string[]} matching relative paths
 */
function findNodeOptionsPreloadLocations (textFiles, preloadPattern) {
  const locations = []

  for (const file of textFiles) {
    const lines = file.content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!NODE_OPTIONS_RE.test(lines[i])) continue

      const window = lines.slice(i, i + 4).join('\n')
      preloadPattern.lastIndex = 0
      if (preloadPattern.test(window)) {
        locations.push(file.relativePath)
        break
      }
    }
  }

  return unique(locations)
}

/**
 * Finds files whose content matches a pattern.
 *
 * @param {Array<object>} textFiles scanned text files
 * @param {RegExp} pattern content pattern
 * @returns {string[]} matching relative paths
 */
function findLocations (textFiles, pattern) {
  const locations = []

  for (const file of textFiles) {
    pattern.lastIndex = 0
    if (pattern.test(file.content)) {
      locations.push(file.relativePath)
    }
  }

  return unique(locations)
}

/**
 * Collects text-like repository files.
 *
 * @param {string} root repository root
 * @param {number} maxFiles maximum number of files
 * @returns {Array<string> & {truncated?: boolean}} relative paths
 */
function collectTextFiles (root, maxFiles) {
  const files = []
  files.truncated = false

  function walk (dir, relativeDir) {
    if (files.length >= maxFiles) {
      files.truncated = true
      return
    }

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        files.truncated = true
        return
      }

      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name
      const absolutePath = path.join(root, relativePath)

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(absolutePath, relativePath)
        }
        continue
      }

      if (entry.isFile() && isTextFileName(entry.name)) {
        const normalizedPath = normalizeRelativePath(relativePath)
        if (!SKIPPED_FILES.has(normalizedPath)) {
          files.push(relativePath)
        }
      }
    }
  }

  walk(root, '')
  return files
}

/**
 * Reads scanned text files within the size limit.
 *
 * @param {string} root repository root
 * @param {string[]} files relative file paths
 * @returns {Array<object>} text file records
 */
function readTextFiles (root, files) {
  const textFiles = []

  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath)
    let stat
    try {
      stat = fs.statSync(absolutePath)
    } catch {
      continue
    }

    if (stat.size > MAX_TEXT_FILE_SIZE) continue

    try {
      textFiles.push({
        relativePath: normalizeRelativePath(relativePath),
        content: fs.readFileSync(absolutePath, 'utf8'),
      })
    } catch {
      // Ignore files that cannot be read as UTF-8.
    }
  }

  return textFiles
}

/**
 * Checks whether a filename should be scanned as text.
 *
 * @param {string} name filename
 * @returns {boolean} true if the file is text-like
 */
function isTextFileName (name) {
  return TEXT_FILE_NAMES.has(name) || TEXT_EXTENSIONS.has(path.extname(name))
}

/**
 * Checks whether a file is a common CI workflow file.
 *
 * @param {string} relativePath relative path
 * @returns {boolean} true if the path is a workflow file
 */
function isWorkflowFile (relativePath) {
  return relativePath.startsWith('.github/workflows/') ||
    relativePath === '.gitlab-ci.yml' ||
    relativePath === '.gitlab-ci.yaml' ||
    relativePath === 'bitbucket-pipelines.yml' ||
    relativePath === 'bitbucket-pipelines.yaml' ||
    relativePath === 'azure-pipelines.yml' ||
    relativePath === 'azure-pipelines.yaml' ||
    relativePath === 'Jenkinsfile' ||
    relativePath === '.circleci/config.yml' ||
    relativePath === '.circleci/config.yaml' ||
    relativePath === '.buildkite/pipeline.yml' ||
    relativePath === '.buildkite/pipeline.yaml'
}

/**
 * Runs git --version to check availability.
 *
 * @param {Function} execFile command runner
 * @param {string} root repository root
 * @returns {boolean} true if git runs
 */
function canRunGit (execFile, root) {
  try {
    execFile('git', ['--version'], { cwd: root, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Runs a git command and trims output.
 *
 * @param {Function} execFile command runner
 * @param {string} root repository root
 * @param {string[]} args git arguments
 * @returns {string} command output
 */
function runGit (execFile, root, args) {
  try {
    return String(execFile('git', args, { cwd: root, stdio: 'pipe' })).trim()
  } catch {
    return ''
  }
}

/**
 * Reads a JSON file.
 *
 * @param {string} filePath absolute file path
 * @returns {object|undefined} parsed JSON
 */
function readJsonFile (filePath) {
  try {
    return parseJson(fs.readFileSync(filePath, 'utf8'))
  } catch {
    // File is absent or unreadable.
  }
}

/**
 * Parses JSON safely.
 *
 * @param {string} content JSON content
 * @returns {object|undefined} parsed JSON
 */
function parseJson (content) {
  try {
    return JSON.parse(content)
  } catch {
    // Invalid JSON is reported by the checks that depend on it.
  }
}

/**
 * Extracts a comparable semantic version from a package range.
 *
 * @param {string} rawVersion raw package version or range
 * @returns {string|undefined} comparable version
 */
function coerceVersion (rawVersion) {
  const aliasedVersion = rawVersion.match(/^npm:[^@]+@(.+)$/)?.[1] || rawVersion
  const match = aliasedVersion.match(/\d+(?:\.\d+){0,2}/)
  if (!match) return

  const parts = match[0].split('.')
  while (parts.length < 3) {
    parts.push('0')
  }
  return parts.slice(0, 3).join('.')
}

/**
 * Checks whether a framework id is present.
 *
 * @param {Array<object>} frameworks detected frameworks
 * @param {string} id framework id
 * @returns {boolean} true if present
 */
function hasFramework (frameworks, id) {
  return frameworks.some(framework => framework.id === id)
}

/**
 * Checks whether NODE_OPTIONS preloads dd-trace/ci/init.
 *
 * @param {string|undefined} nodeOptions NODE_OPTIONS value
 * @returns {boolean} true if dd-trace/ci/init is present
 */
function hasCiInitInNodeOptions (nodeOptions) {
  return !!nodeOptions && INIT_PRELOAD_RE.test(nodeOptions)
}

/**
 * Checks whether NODE_OPTIONS preloads dd-trace/register.js.
 *
 * @param {string|undefined} nodeOptions NODE_OPTIONS value
 * @returns {boolean} true if dd-trace/register.js is present
 */
function hasRegisterInNodeOptions (nodeOptions) {
  return !!nodeOptions && REGISTER_PRELOAD_RE.test(nodeOptions)
}

/**
 * Checks whether environment contains branch or tag metadata.
 *
 * @param {NodeJS.ProcessEnv} env environment
 * @returns {boolean} true if branch metadata exists
 */
function hasBranchMetadata (env) {
  return !!(
    env.DD_GIT_BRANCH ||
    env.DD_GIT_TAG ||
    env.GITHUB_HEAD_REF ||
    env.GITHUB_REF_NAME ||
    env.CI_COMMIT_REF_NAME ||
    env.CIRCLE_BRANCH ||
    env.GIT_BRANCH ||
    env.BUILDKITE_BRANCH ||
    env.TRAVIS_BRANCH ||
    env.BITBUCKET_BRANCH ||
    env.DRONE_BRANCH ||
    env.BUDDY_EXECUTION_BRANCH ||
    env.BITRISE_GIT_BRANCH
  )
}

/**
 * Checks whether environment contains commit SHA metadata.
 *
 * @param {NodeJS.ProcessEnv} env environment
 * @returns {boolean} true if SHA metadata exists
 */
function hasShaMetadata (env) {
  return !!(
    env.DD_GIT_COMMIT_SHA ||
    env.GITHUB_SHA ||
    env.CI_COMMIT_SHA ||
    env.CIRCLE_SHA1 ||
    env.GIT_COMMIT ||
    env.BUILDKITE_COMMIT ||
    env.TRAVIS_COMMIT ||
    env.BITBUCKET_COMMIT ||
    env.DRONE_COMMIT ||
    env.BUDDY_EXECUTION_REVISION
  )
}

/**
 * Checks truthy string env values.
 *
 * @param {string|undefined} value value to inspect
 * @returns {boolean} true if value is true-like
 */
function isTrueLike (value) {
  return /^(?:1|true)$/i.test(String(value || ''))
}

/**
 * Checks false-like string env values.
 *
 * @param {string|undefined} value value to inspect
 * @returns {boolean} true if value is false-like
 */
function isFalseLike (value) {
  return /^(?:0|false)$/i.test(String(value || ''))
}

/**
 * Counts result statuses.
 *
 * @param {Array<object>} results diagnosis results
 * @returns {object} counts by status
 */
function countByStatus (results) {
  const counts = { error: 0, warning: 0, info: 0, ok: 0 }
  for (const result of results) {
    counts[result.status]++
  }
  return counts
}

/**
 * Formats a list of locations for text output.
 *
 * @param {string[]} locations relative paths
 * @returns {string} formatted locations
 */
function formatLocations (locations) {
  const uniqueLocations = unique(locations).slice(0, 5)
  const suffix = locations.length > uniqueLocations.length
    ? `, and ${locations.length - uniqueLocations.length} more`
    : ''
  return uniqueLocations.join(', ') + suffix
}

/**
 * Serializes a supported framework for JSON output.
 *
 * @param {object} framework detected framework
 * @returns {object} serializable framework summary
 */
function serializeSupportedFramework (framework) {
  return {
    id: framework.id,
    name: framework.name,
    packages: framework.packages,
    supportedRange: framework.supportedRange,
    locations: framework.locations,
    versionDetections: framework.versionDetections,
  }
}

/**
 * Serializes an unsupported framework for JSON output.
 *
 * @param {object} framework detected unsupported framework
 * @returns {object} serializable framework summary
 */
function serializeUnsupportedFramework (framework) {
  return {
    id: framework.id,
    name: framework.name,
    locations: framework.locations,
  }
}

/**
 * Deduplicates values.
 *
 * @param {Array<string>} values values
 * @returns {string[]} unique values
 */
function unique (values) {
  return [...new Set(values.filter(Boolean))]
}

/**
 * Deduplicates version detections.
 *
 * @param {Array<object>} detections version detections
 * @returns {Array<object>} unique detections
 */
function uniqueVersionDetections (detections) {
  const seen = new Set()
  const uniqueDetections = []

  for (const detection of detections) {
    const key = `${detection.packageName}:${detection.rawVersion}:${detection.relativePath || ''}`
    if (seen.has(key)) continue

    seen.add(key)
    uniqueDetections.push(detection)
  }

  return uniqueDetections
}

/**
 * Normalizes relative paths to POSIX separators for stable output.
 *
 * @param {string} relativePath relative path
 * @returns {string} normalized path
 */
function normalizeRelativePath (relativePath) {
  return relativePath.split(path.sep).join('/')
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  const hasValidFailOn = ['error', 'warning', 'never'].includes(args.failOn)

  if (args.help) {
    console.log(getHelpText())
  } else if (args.unknown) {
    console.error(`Unknown argument: ${args.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else if (hasValidFailOn) {
    const report = runDiagnosis({ root: args.root })
    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(renderText(report))
    }
    process.exitCode = getExitCode(report, args.failOn)
  } else {
    console.error(`Invalid --fail-on value: ${args.failOn}`)
    console.error(getHelpText())
    process.exitCode = 1
  }
}

module.exports = {
  getExitCode,
  getFrameworkDefinitions,
  parseArgs,
  renderText,
  runDiagnosis,
}
