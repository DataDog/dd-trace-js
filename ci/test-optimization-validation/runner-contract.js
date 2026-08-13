'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { environmentNamesEqual, setEnvironmentValue } = require('./environment')

const RUNNER_OPTIONS = {
  cucumber: {
    flags: new Set(['--backtrace', '--fail-fast', '--no-strict', '--strict']),
    values: new Set([
      '-p', '--config', '--import', '--language', '--loader', '--profile', '--require', '--require-module',
      '--parallel', '--world-parameters',
    ]),
  },
  cypress: {
    flags: new Set(['--component', '--e2e', '--headed', '--headless']),
    values: new Set(['--browser', '--config-file']),
  },
  jest: {
    flags: new Set(['--color', '--colors', '--detectLeaks']),
    values: new Set(['-c', '--config', '--env', '--runner', '--testEnvironment']),
  },
  mocha: {
    flags: new Set(['--check-leaks', '--enable-source-maps']),
    values: new Set(['-r', '-t', '-u', '--config', '--extension', '--loader', '--require', '--timeout', '--ui']),
  },
  playwright: {
    flags: new Set(),
    values: new Set(['-c', '--config', '--project']),
  },
  vitest: {
    flags: new Set(['--browser']),
    values: new Set(['--config', '--environment', '--project', '--root']),
  },
}
const IGNORED_RUNNER_OPTIONS = {
  mocha: {
    flags: new Set(),
    values: new Set(['-R', '--reporter']),
  },
}
const OMITTED_RUNNER_OPTIONS = {
  vitest: new Set(['--run', '--typecheck']),
}
const SOURCE_SELECTOR_OPTIONS = {
  cypress: new Set(['--spec']),
}
const RUNNER_ENVIRONMENT_NAMES = new Set([
  'BABEL_ENV',
  'CI',
  'NODE_ENV',
  'TS_NODE_PROJECT',
  'TZ',
])
const RUNNER_LAUNCHERS = new Set(['c8', 'cross-env', 'env', 'npx', 'nyc', 'node'])
const MODULE_OPTIONS = new Set([
  '-r',
  '-u',
  '--env',
  '--environment',
  '--import',
  '--loader',
  '--require',
  '--require-module',
  '--runner',
  '--testEnvironment',
  '--ui',
])
const FILE_OPTIONS = new Set(['-c', '--config', '--config-file'])
const DIRECTORY_OPTIONS = new Set(['--root'])
const UNSUPPORTED_CONFIGURATION_OPTIONS = {
  cypress: new Set(['--config']),
  jest: new Set(['--projects']),
  mocha: new Set(['--config']),
}
const BUILTIN_MODULE_VALUES = new Map([
  ['-u', new Set(['bdd', 'exports', 'qunit', 'tdd'])],
  ['--env', new Set(['node'])],
  ['--environment', new Set(['node'])],
  ['--testEnvironment', new Set(['node'])],
  ['--ui', new Set(['bdd', 'exports', 'qunit', 'tdd'])],
])
const CONTROL_PATTERN = /[\0\r\n;&|`]|\$\(|\$\{/
const ENVIRONMENT_EXPANSION_PATTERN = /\$|%[^%]+%|![^!]+!/

/**
 * Extracts bounded runner configuration from a detected package script.
 *
 * @param {string} framework framework name
 * @param {string} command detected package script
 * @param {string} projectRoot detected project root
 * @param {string} repositoryRoot repository root
 * @param {string} [platform] target platform
 * @returns {{
 *   environment: Record<string, string>,
 *   error?: string,
 *   inputFiles: string[],
 *   runnerArgs: string[]
 * }} runner contract
 */
function getRunnerContract (framework, command, projectRoot, repositoryRoot, platform = process.platform) {
  const dynamicEnvironmentError = getDynamicRunnerEnvironmentError(command)
  if (dynamicEnvironmentError) {
    return { environment: {}, error: dynamicEnvironmentError, inputFiles: [], runnerArgs: [] }
  }
  const invocation = getFrameworkInvocation(command, framework)
  if (!invocation) return { environment: {}, inputFiles: [], runnerArgs: [] }
  if (invocation.error) {
    return { environment: {}, error: invocation.error, inputFiles: [], runnerArgs: [] }
  }
  const unsupportedOption = getUnsupportedConfigurationOption(framework, invocation)
  if (unsupportedOption) {
    return {
      environment: {},
      error: `${unsupportedOption} has configuration semantics that the validator does not preserve`,
      inputFiles: [],
      runnerArgs: [],
    }
  }
  const unknownOption = getUnknownRunnerOption(framework, invocation)
  if (unknownOption) {
    return {
      environment: {},
      error: `${unknownOption} is not preserved by the validator direct-runner contract`,
      inputFiles: [],
      runnerArgs: [],
    }
  }
  const omittedOptions = getOmittedRunnerOptions(framework, invocation)

  const environment = getRunnerEnvironment(invocation, platform)
  const environmentError = getRunnerEnvironmentError(environment, platform)
  if (environmentError) {
    return { environment: {}, error: `runner environment ${environmentError}`, inputFiles: [], runnerArgs: [] }
  }
  const runnerArgs = getRunnerArgs(framework, invocation)
  const runnerArgsError = getRunnerArgsError(framework, runnerArgs)
  if (runnerArgsError) {
    return {
      environment: {},
      error: `runner arguments ${runnerArgsError}`,
      inputFiles: [],
      runnerArgs: [],
    }
  }
  const inputs = getRunnerInputs(runnerArgs, environment, projectRoot, repositoryRoot)
  if (inputs.error) {
    return { environment: {}, error: inputs.error, inputFiles: [], runnerArgs: [] }
  }
  return {
    environment,
    inputFiles: inputs.files,
    omittedOptions,
    runnerArgs,
  }
}

function getRunnerConfigurationContract (framework, runnerArgs, environment, projectRoot, repositoryRoot) {
  const runnerArgsError = getRunnerArgsError(framework, runnerArgs)
  if (runnerArgsError) {
    return {
      environment: {},
      error: `runner arguments ${runnerArgsError}`,
      inputFiles: [],
      runnerArgs: [],
    }
  }
  const inputs = getRunnerInputs(runnerArgs, environment, projectRoot, repositoryRoot)
  if (inputs.error) {
    return { environment: {}, error: inputs.error, inputFiles: [], runnerArgs: [] }
  }
  return { environment, inputFiles: inputs.files, runnerArgs }
}

/**
 * Rejects shell-expanded allowlisted environment assignments before command tokenization.
 *
 * @param {string} command detected package script
 * @returns {string|undefined} validation error
 */
function getDynamicRunnerEnvironmentError (command) {
  const source = String(command || '')
  for (const match of source.matchAll(
    /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
  )) {
    const value = match[2] ?? match[3] ?? match[4]
    if (RUNNER_ENVIRONMENT_NAMES.has(match[1]) && ENVIRONMENT_EXPANSION_PATTERN.test(value)) {
      return `runner environment contains an unsafe value for ${match[1]}`
    }
  }
  if (ENVIRONMENT_EXPANSION_PATTERN.test(source)) {
    return 'runner command contains shell-expanded values that the validator does not preserve'
  }
}

/**
 * Returns literal existing test roots selected by a direct framework invocation.
 *
 * @param {string} framework framework name
 * @param {string} command detected package script
 * @param {string} projectRoot detected project root
 * @param {string} repositoryRoot repository root
 * @returns {string[]} physical search roots
 */
function getRunnerSearchRoots (framework, command, projectRoot, repositoryRoot) {
  const invocation = getFrameworkInvocation(command, framework)
  const options = RUNNER_OPTIONS[framework]
  if (!invocation || invocation.error || !options) return []

  const roots = new Set()
  const selectors = SOURCE_SELECTOR_OPTIONS[framework] || new Set()
  const tokens = invocation.tokens.slice(invocation.runnerIndex + 1)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.startsWith('-')) {
      const option = token.split('=', 1)[0]
      if (DIRECTORY_OPTIONS.has(option)) {
        const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[++index]
        addRunnerSearchRoot(roots, value, projectRoot, repositoryRoot, true)
      } else if (selectors.has(option)) {
        const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[++index]
        addRunnerSearchRoot(roots, value, projectRoot, repositoryRoot, false)
      } else if (options.values.has(option) && !token.includes('=')) {
        index++
      }
      continue
    }
    if (['run', 'test'].includes(token)) continue
    addRunnerSearchRoot(roots, token, projectRoot, repositoryRoot, false)
    if (roots.size === 3) break
  }
  return [...roots]
}

/**
 * Adds one literal, contained command selector to the representative search roots.
 *
 * @param {Set<string>} roots accumulated physical roots
 * @param {string|undefined} value command selector
 * @param {string} projectRoot detected project root
 * @param {string} repositoryRoot repository root
 * @param {boolean} directory whether the option explicitly requires a directory
 * @returns {void}
 */
function addRunnerSearchRoot (roots, value, projectRoot, repositoryRoot, directory) {
  if (typeof value !== 'string' || !value) return
  const literal = value.split(/[*?{[]/, 1)[0].replace(/(?<![\\/])[\\/]+$/, '')
  if (!literal) return
  const candidate = path.resolve(projectRoot, literal)
  const searchRoot = directory || !path.extname(candidate) ? candidate : path.dirname(candidate)
  try {
    const physical = fs.realpathSync(searchRoot)
    if (fs.statSync(physical).isDirectory() &&
      isPathInside(fs.realpathSync(repositoryRoot), physical)) roots.add(physical)
  } catch {}
}

/**
 * Returns a configuration-bearing option that the direct-runner contract intentionally rejects.
 *
 * @param {string} framework framework name
 * @param {{runnerIndex: number, tokens: string[]}} invocation parsed invocation
 * @returns {string|undefined} unsupported option
 */
function getUnsupportedConfigurationOption (framework, invocation) {
  const unsupported = UNSUPPORTED_CONFIGURATION_OPTIONS[framework]
  if (!unsupported) return
  return invocation.tokens.slice(invocation.runnerIndex + 1).find(token => {
    return token.startsWith('-') && unsupported.has(token.split('=', 1)[0])
  })?.split('=', 1)[0]
}

/**
 * Returns the first runner option whose semantics are neither retained nor explicitly safe to omit.
 *
 * @param {string} framework framework name
 * @param {{runnerIndex: number, tokens: string[]}} invocation parsed invocation
 * @returns {string|undefined} unsupported option
 */
function getUnknownRunnerOption (framework, invocation) {
  const retained = RUNNER_OPTIONS[framework]
  if (!retained) return
  const ignored = IGNORED_RUNNER_OPTIONS[framework] || { flags: new Set(), values: new Set() }
  const omitted = OMITTED_RUNNER_OPTIONS[framework] || new Set()
  const selectors = SOURCE_SELECTOR_OPTIONS[framework] || new Set()
  const tokens = invocation.tokens.slice(invocation.runnerIndex + 1)

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) continue
    const option = token.split('=', 1)[0]
    if (omitted.has(option)) {
      if (token !== option) return option
      continue
    }
    if (selectors.has(option)) {
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[index + 1]
      if (!value || value.startsWith('-')) return option
      if (!token.includes('=')) index++
      continue
    }
    if (retained.flags.has(option) || ignored.flags.has(option)) continue
    if (retained.values.has(option) || ignored.values.has(option)) {
      if (!token.includes('=') && tokens[index + 1] && !tokens[index + 1].startsWith('-')) index++
      continue
    }
    return option
  }
}

function getOmittedRunnerOptions (framework, invocation) {
  const omitted = OMITTED_RUNNER_OPTIONS[framework] || new Set()
  const ignored = IGNORED_RUNNER_OPTIONS[framework] || { flags: new Set(), values: new Set() }
  return [...new Set(invocation.tokens
    .slice(invocation.runnerIndex + 1)
    .filter(token => {
      if (!token.startsWith('-')) return false
      const option = token.split('=', 1)[0]
      return omitted.has(option) || ignored.flags.has(option) || ignored.values.has(option)
    })
    .map(token => token.split('=', 1)[0]))]
}

function getArgumentOptionValues (args, expected) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    if (args[index].split('=', 1)[0] !== expected) continue
    values.push(args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : args[index + 1])
  }
  return values
}

/**
 * Selects a project-owned runner only for an exact `node <regular-file>` package script.
 *
 * @param {string} command detected package script
 * @param {string} projectRoot detected project root
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} physical runner path
 */
function getProjectNodeRunner (command, projectRoot, repositoryRoot) {
  if (CONTROL_PATTERN.test(String(command || ''))) return
  const tokens = tokenizeCommand(command)
  if (tokens.length !== 2 || !/^node(?:\.exe)?$/i.test(path.basename(tokens[0])) || tokens[1].startsWith('-')) return

  const filename = path.resolve(projectRoot, tokens[1])
  try {
    const lexicalStat = fs.lstatSync(filename)
    const physical = fs.realpathSync(filename)
    if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink() ||
      !fs.statSync(physical).isFile() ||
      !isPathInside(fs.realpathSync(repositoryRoot), physical)) return
    return physical
  } catch {}
}

/**
 * Validates scaffold-owned runner arguments before they can affect execution.
 *
 * @param {string} framework framework name
 * @param {unknown} args runner arguments
 * @returns {string|undefined} validation error
 */
function getRunnerArgsError (framework, args) {
  if (!Array.isArray(args)) return 'must be an array'
  const options = RUNNER_OPTIONS[framework]
  if (!options) return 'are unsupported for this framework'

  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (typeof token !== 'string' || !token || CONTROL_PATTERN.test(token)) {
      return 'must contain only bounded strings without shell control syntax'
    }
    const option = token.split('=', 1)[0]
    if (options.flags.has(option)) {
      if (token !== option &&
        !/^--(?:color|colors|detectLeaks)=(?:true|false)$/.test(token)) {
        return `contain an invalid value for ${option}`
      }
      continue
    }
    if (!options.values.has(option)) return `contain unsupported option ${option}`
    if (token.includes('=')) {
      if (!token.slice(token.indexOf('=') + 1)) return `contain a missing value for ${option}`
      continue
    }
    const value = args[++index]
    if (typeof value !== 'string' || !value || value.startsWith('-') || CONTROL_PATTERN.test(value)) {
      return `contain a missing or unsafe value for ${option}`
    }
  }

  if (framework === 'cucumber') {
    const language = getArgumentOptionValues(args, '--language').find(value => value !== 'en')
    if (language) {
      return `--language ${language} is not supported by the validator-generated English scenarios`
    }
  }
}

/**
 * Validates the small static environment retained from a runner invocation.
 *
 * @param {unknown} environment runner environment
 * @param {string} [platform] target platform
 * @returns {string|undefined} validation error
 */
function getRunnerEnvironmentError (environment, platform = process.platform) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return 'must be an object'
  for (const [name, value] of Object.entries(environment)) {
    if (!getCanonicalRunnerEnvironmentName(name, platform)) return `contains unsupported variable ${name}`
    if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 ||
      CONTROL_PATTERN.test(value) || ENVIRONMENT_EXPANSION_PATTERN.test(value)) {
      return `contains an unsafe value for ${name}`
    }
  }
}

/**
 * Validates that retained code-loading inputs are contained and approval-bound.
 *
 * @param {string[]} args runner arguments
 * @param {Record<string, string>} environment runner environment
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @param {string[]} configFiles approval-bound project inputs
 * @returns {string|undefined} validation error
 */
function getRunnerInputError (args, environment, projectRoot, repositoryRoot, configFiles) {
  const inputs = getRunnerInputs(args, environment, projectRoot, repositoryRoot)
  if (inputs.error) return inputs.error

  const approved = new Set()
  if (configFiles) {
    for (const filename of configFiles) {
      try {
        approved.add(fs.realpathSync(filename))
      } catch {}
    }
  }
  const unbound = inputs.files.find(filename => !approved.has(filename))
  if (unbound) return `references an input that is not approval-bound: ${unbound}`
}

/**
 * Finds a direct framework executable behind inert launch wrappers.
 *
 * @param {string} command detected package script
 * @param {string} framework framework name
 * @returns {{error?: string, runnerIndex: number, tokens: string[]}|undefined} parsed invocation
 */
function getFrameworkInvocation (command, framework) {
  if (CONTROL_PATTERN.test(String(command || ''))) return
  if (command === `direct ${framework} binary`) return
  const tokens = tokenizeCommand(command)
  const executable = getRunnerExecutableName(framework)
  const runnerIndex = tokens.findIndex(token => {
    const basename = normalizeRunnerBasename(token)
    return basename === executable ||
      (framework === 'cucumber' && ['cucumber', 'cucumber-js'].includes(basename))
  })
  if (runnerIndex === -1) return

  const prefixError = getRunnerPrefixError(tokens.slice(0, runnerIndex))
  if (prefixError) return { error: prefixError, runnerIndex, tokens }
  return { runnerIndex, tokens }
}

function getRunnerPrefixError (prefix) {
  let coverageLauncher = false
  for (let index = 0; index < prefix.length; index++) {
    const token = prefix[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=[^;&|`]*$/.test(token)) continue

    const basename = path.basename(token).toLowerCase()
    if (RUNNER_LAUNCHERS.has(basename)) {
      coverageLauncher = basename === 'c8' || basename === 'nyc'
      continue
    }
    if (coverageLauncher && /^(?:-r|--reporter)=\S+$/.test(token)) continue
    if (coverageLauncher && /^(?:-r|--reporter)$/.test(token) &&
      prefix[index + 1] && !prefix[index + 1].startsWith('-')) {
      index++
      continue
    }
    if (!prefix.some(candidate => RUNNER_LAUNCHERS.has(path.basename(candidate).toLowerCase()))) {
      return `runner launch wrapper ${path.basename(token)} is not allowlisted`
    }
    return 'runner launch wrapper contains options or positional arguments whose semantics the validator does not ' +
      'preserve'
  }
}

/**
 * Extracts allowlisted runner options while dropping source selectors and presentation flags.
 *
 * @param {string} framework framework name
 * @param {{runnerIndex: number, tokens: string[]}} invocation parsed invocation
 * @returns {string[]} retained options
 */
function getRunnerArgs (framework, invocation) {
  const options = RUNNER_OPTIONS[framework]
  if (!options) return []
  const args = []
  for (let index = invocation.runnerIndex + 1; index < invocation.tokens.length; index++) {
    const token = invocation.tokens[index]
    if (!token.startsWith('-')) continue
    const option = token.split('=', 1)[0]
    if (options.flags.has(option)) {
      args.push(token)
    } else if (options.values.has(option)) {
      args.push(token)
      if (!token.includes('=') && invocation.tokens[index + 1] && !invocation.tokens[index + 1].startsWith('-')) {
        args.push(invocation.tokens[++index])
      }
    }
  }
  return args
}

/**
 * Normalizes executable shims and supported JavaScript runner entrypoints.
 *
 * @param {string} token command token
 * @returns {string} normalized executable basename
 */
function normalizeRunnerBasename (token) {
  return path.basename(token)
    .replace(/\.cmd$/i, '')
    .replace(/\.(?:cjs|mjs|js)$/i, '')
    .toLowerCase()
}

/**
 * Extracts allowlisted literal environment assignments before the framework runner.
 *
 * @param {{runnerIndex: number, tokens: string[]}} invocation parsed invocation
 * @param {string} [platform] target platform
 * @returns {Record<string, string>} retained environment
 */
function getRunnerEnvironment (invocation, platform = process.platform) {
  const environment = {}
  for (const token of invocation.tokens.slice(0, invocation.runnerIndex)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token)
    const name = match && getCanonicalRunnerEnvironmentName(match[1], platform)
    if (name && !CONTROL_PATTERN.test(match[2])) {
      setEnvironmentValue(environment, name, match[2], platform)
    }
  }
  return environment
}

function getCanonicalRunnerEnvironmentName (name, platform) {
  return [...RUNNER_ENVIRONMENT_NAMES].find(candidate => {
    return environmentNamesEqual(candidate, name, platform)
  })
}

/**
 * Resolves regular files referenced by retained configuration.
 *
 * @param {string[]} args runner arguments
 * @param {Record<string, string>} environment runner environment
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @returns {{error?: string, files: string[]}} physical input files
 */
function getRunnerInputs (args, environment, projectRoot, repositoryRoot) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    const option = args[index].split('=', 1)[0]
    if (!MODULE_OPTIONS.has(option) && !FILE_OPTIONS.has(option) && !DIRECTORY_OPTIONS.has(option)) continue
    const value = args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : args[++index]
    values.push({
      directory: DIRECTORY_OPTIONS.has(option),
      label: option,
      module: MODULE_OPTIONS.has(option),
      value,
    })
  }
  if (environment.TS_NODE_PROJECT) {
    values.push({
      directory: false,
      label: 'TS_NODE_PROJECT',
      module: false,
      value: environment.TS_NODE_PROJECT,
    })
  }

  const files = new Set()
  for (const input of values) {
    if (input.directory) {
      const directoryError = getContainedDirectoryError(input, projectRoot, repositoryRoot)
      if (directoryError) return { error: directoryError, files: [] }
      continue
    }
    if (input.module && BUILTIN_MODULE_VALUES.get(input.label)?.has(input.value)) continue
    const filename = resolveInputFile(input, projectRoot)
    if (!filename) return { error: `${input.label} does not resolve to a repository-contained file`, files: [] }
    try {
      const physical = fs.realpathSync(filename)
      if (!fs.statSync(physical).isFile() || !isPathInside(fs.realpathSync(repositoryRoot), physical)) {
        return { error: `${input.label} resolves outside the repository`, files: [] }
      }
      files.add(physical)
    } catch {
      return { error: `${input.label} does not resolve to a repository-contained file`, files: [] }
    }
  }
  if (files.size > 20) return { error: 'retains more than 20 code-loading inputs', files: [] }
  return { files: [...files].sort() }
}

/**
 * Checks one retained directory selector without traversing it.
 *
 * @param {{label: string, value: string}} input input descriptor
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} validation error
 */
function getContainedDirectoryError (input, projectRoot, repositoryRoot) {
  try {
    const physical = fs.realpathSync(path.resolve(projectRoot, input.value))
    if (!fs.statSync(physical).isDirectory() || !isPathInside(fs.realpathSync(repositoryRoot), physical)) {
      return `${input.label} resolves outside the repository`
    }
  } catch {
    return `${input.label} does not resolve to a repository-contained directory`
  }
}

/**
 * Resolves one module or path without loading it.
 *
 * @param {{module: boolean, value: string}} input input descriptor
 * @param {string} projectRoot project root
 * @returns {string|undefined} resolved filename
 */
function resolveInputFile (input, projectRoot) {
  if (!input.value) return
  if (!input.module || path.isAbsolute(input.value) || input.value.startsWith('.')) {
    return path.resolve(projectRoot, input.value)
  }
  const projectRelative = path.resolve(projectRoot, input.value)
  try {
    return require.resolve(projectRelative)
  } catch {}
  try {
    return require.resolve(input.value, { paths: [projectRoot] })
  } catch {}
}

/**
 * Tokenizes bounded package-script evidence without expanding variables or invoking a shell.
 *
 * @param {string} command package script
 * @returns {string[]} inert tokens
 */
function tokenizeCommand (command) {
  const tokens = []
  for (const match of String(command || '').matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

/**
 * Returns the executable name for a framework.
 *
 * @param {string} framework framework name
 * @returns {string} executable name
 */
function getRunnerExecutableName (framework) {
  if (framework === 'cucumber') return 'cucumber-js'
  return framework === 'playwright' ? 'playwright' : framework
}

/**
 * Checks physical path containment.
 *
 * @param {string} root root path
 * @param {string} filename candidate path
 * @returns {boolean} whether the candidate is contained
 */
function isPathInside (root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = {
  getProjectNodeRunner,
  getRunnerArgsError,
  getRunnerConfigurationContract,
  getRunnerContract,
  getRunnerEnvironmentError,
  getRunnerInputError,
  getRunnerSearchRoots,
}
