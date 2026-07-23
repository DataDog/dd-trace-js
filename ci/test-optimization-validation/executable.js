'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const crypto = require('node:crypto')
const fs = require('node:fs')
const { builtinModules, createRequire } = require('node:module')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const {
  getPackageScriptDirectCommand,
  getPackageScriptExpansion,
  getShellDirectCommand,
} = require('./command-suitability')
const {
  environmentNamesEqual,
  findEnvironmentEntry,
  getEnvironmentValue,
} = require('./environment')
const { bindApprovedExecutable, getApprovedExecutable } = require('./executable-approval')
const { getLocalValidationCommand } = require('./local-command')

const BUILTIN_MODULES = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const NODE_EXECUTION_FILE_OPTIONS = new Map([
  ['-r', 'Node.js preload module'],
  ['--experimental-loader', 'Node.js loader module'],
  ['--import', 'Node.js import module'],
  ['--loader', 'Node.js loader module'],
  ['--require', 'Node.js preload module'],
])
const NODE_FLAG_OPTIONS = new Set([
  '-c', '--check',
  '-h', '--help',
  '-v', '--version',
  '--abort-on-uncaught-exception',
  '--allow-addons',
  '--allow-child-process',
  '--allow-inspector',
  '--allow-wasi',
  '--allow-worker',
  '--completion-bash',
  '--cpu-prof',
  '--disable-sigusr1',
  '--disable-wasm-trap-handler',
  '--disallow-code-generation-from-strings',
  '--enable-etw-stack-walking',
  '--enable-fips',
  '--enable-source-maps',
  '--experimental-addon-modules',
  '--experimental-eventsource',
  '--experimental-import-meta-resolve',
  '--experimental-inspector-network-resource',
  '--experimental-network-inspection',
  '--experimental-print-required-tla',
  '--experimental-test-coverage',
  '--experimental-test-module-mocks',
  '--experimental-transform-types',
  '--experimental-vm-modules',
  '--experimental-webstorage',
  '--experimental-worker-inspection',
  '--expose-gc',
  '--force-context-aware',
  '--force-fips',
  '--force-node-api-uncaught-exceptions-policy',
  '--frozen-intrinsics',
  '--heap-prof',
  '--insecure-http-parser',
  '--interpreted-frames-native-stack',
  '--jitless',
  '--no-addons',
  '--no-async-context-frame',
  '--no-deprecation',
  '--no-experimental-detect-module',
  '--no-experimental-global-navigator',
  '--no-experimental-repl-await',
  '--no-experimental-require-module',
  '--no-experimental-sqlite',
  '--no-experimental-websocket',
  '--no-extra-info-on-fatal-exception',
  '--no-force-async-hooks-checks',
  '--no-global-search-paths',
  '--no-network-family-autoselection',
  '--no-strip-types',
  '--no-warnings',
  '--node-memory-debug',
  '--openssl-legacy-provider',
  '--openssl-shared-config',
  '--pending-deprecation',
  '--permission',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--prof',
  '--prof-process',
  '--report-compact',
  '--report-exclude-env',
  '--report-exclude-network',
  '--report-on-fatalerror',
  '--report-on-signal',
  '--report-uncaught-exception',
  '--test-force-exit',
  '--test-only',
  '--throw-deprecation',
  '--tls-max-v1.2',
  '--tls-max-v1.3',
  '--tls-min-v1.0',
  '--tls-min-v1.1',
  '--tls-min-v1.2',
  '--tls-min-v1.3',
  '--trace-deprecation',
  '--trace-env',
  '--trace-env-js-stack',
  '--trace-env-native-stack',
  '--trace-exit',
  '--trace-promises',
  '--trace-sigint',
  '--trace-sync-io',
  '--trace-tls',
  '--trace-uncaught',
  '--trace-warnings',
  '--track-heap-objects',
  '--use-bundled-ca',
  '--use-env-proxy',
  '--use-openssl-ca',
  '--use-system-ca',
  '--v8-options',
  '--watch',
  '--watch-preserve-output',
  '--zero-fill-buffers',
])
const NODE_INLINE_VALUE_OPTIONS = new Set([
  '--allow-fs-read',
  '--allow-fs-write',
  '--cpu-prof-dir',
  '--cpu-prof-interval',
  '--cpu-prof-name',
  '--diagnostic-dir',
  '--disable-proto',
  '--disable-warning',
  '--dns-result-order',
  '--heap-prof-dir',
  '--heap-prof-interval',
  '--heap-prof-name',
  '--heapsnapshot-near-heap-limit',
  '--heapsnapshot-signal',
  '--input-type',
  '--inspect-port',
  '--inspect-publish-uid',
  '--max-http-header-size',
  '--max-old-space-size',
  '--max-old-space-size-percentage',
  '--max-semi-space-size',
  '--network-family-autoselection-attempt-timeout',
  '--redirect-warnings',
  '--report-dir',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  '--secure-heap',
  '--secure-heap-min',
  '--stack-trace-limit',
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-isolation',
  '--test-name-pattern',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
  '--title',
  '--tls-cipher-list',
  '--tls-keylog',
  '--trace-event-categories',
  '--trace-event-file-pattern',
  '--trace-require-module',
  '--unhandled-rejections',
  '--use-largepages',
  '--v8-pool-size',
  '--watch-kill-signal',
  '--watch-path',
])
const NODE_OPTIONAL_INLINE_VALUE_OPTIONS = new Set(['--inspect', '--inspect-brk', '--inspect-wait'])
const REJECTED_NODE_FILE_OPTIONS = new Set([
  '--build-snapshot',
  '--build-snapshot-config',
  '--conditions',
  '--entry-url',
  '--env-file',
  '--env-file-if-exists',
  '--experimental-config-file',
  '--experimental-default-config-file',
  '--experimental-policy',
  '--experimental-sea-config',
  '--icu-data-dir',
  '--localstorage-file',
  '--openssl-config',
  '--policy-integrity',
  '--run',
  '--snapshot-blob',
  '--test',
  '--test-global-setup',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-rerun-failures',
  '--test-update-snapshots',
])

/**
 * Returns an executable that is unavailable for a structured command.
 *
 * @param {object} command manifest command
 * @param {string} [repositoryRoot] repository root containing package scripts
 * @returns {string|undefined} unavailable executable
 */
function getUnavailableExecutable (command, repositoryRoot) {
  const executableCommands = getEffectiveExecutableCommands(command, repositoryRoot)
  for (const executableCommand of executableCommands) {
    const executable = getExecutable(executableCommand)
    if (executable && !resolveExecutable(executable, executableCommand)) return executable
  }
}

/**
 * Reads the executable used to start a structured command.
 *
 * @param {object} command manifest command
 * @returns {string|undefined} command executable
 */
function getExecutable (command) {
  if (!command?.usesShell) return command?.argv?.[0]
  if (typeof command.shell === 'string' && command.shell.trim()) return command.shell.trim()
  return process.platform === 'win32'
    ? process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    : process.env.SHELL || '/bin/sh'
}

/**
 * Resolves an executable from the command working directory or PATH.
 *
 * @param {string} executable executable name or path
 * @param {object} command manifest command
 * @returns {boolean} whether the executable can be resolved
 */
function resolveExecutable (executable, command) {
  if (isExplicitExecutablePath(executable)) {
    return isExecutable(path.resolve(command.cwd, executable))
  }

  const environmentPath = getEnvironmentPath(command)
  const extensions = getExecutableExtensions()

  for (const directory of environmentPath.split(path.delimiter)) {
    if (!directory) continue
    const resolvedDirectory = path.resolve(command.cwd, directory)
    for (const extension of extensions) {
      const filename = path.join(resolvedDirectory, `${executable}${extension}`)
      if (isExecutable(filename)) return true
    }
  }
  return false
}

/**
 * Resolves the filesystem path used for a structured command executable.
 *
 * @param {object} command manifest command
 * @returns {string|undefined} resolved executable path
 */
function getResolvedExecutable (command) {
  const executable = getExecutable(command)
  if (!executable) return

  if (isExplicitExecutablePath(executable)) {
    const filename = path.resolve(command.cwd, executable)
    return isExecutable(filename) ? filename : undefined
  }

  const environmentPath = getEnvironmentPath(command)
  const extensions = getExecutableExtensions()

  for (const directory of environmentPath.split(path.delimiter)) {
    if (!directory) continue
    const resolvedDirectory = path.resolve(command.cwd, directory)
    for (const extension of extensions) {
      const filename = path.join(resolvedDirectory, `${executable}${extension}`)
      if (isExecutable(filename)) return filename
    }
  }
}

/**
 * Returns the PATH used by a command, preserving an explicitly empty value.
 *
 * @param {object} command manifest command
 * @returns {string} command PATH
 */
function getEnvironmentPath (command) {
  const pathEntry = findEnvironmentEntry(command.env || {}, 'PATH')
  if (pathEntry) return pathEntry[1] || ''
  return process.env.PATH || ''
}

/**
 * Binds every executable selected by an approvable manifest command to its canonical file identity.
 *
 * @param {object} manifest loaded manifest
 * @returns {object[]} sorted executable identities included in approval material
 */
function bindManifestExecutables (manifest) {
  const identities = []
  const identitiesByPath = new Map()
  for (const [label, command, sourceCommand] of getManifestCommands(manifest)) {
    const identity = getCommandExecutableIdentity(command, identitiesByPath, manifest.repository.root)
    if (!identity) continue
    if (label.includes(':isolation') || label.includes(':generated:')) {
      assertValidatorOwnedExecutableContained(command, identity, manifest.repository.root, label)
    }
    bindApprovedExecutable(command, identity)
    if (sourceCommand !== command) bindApprovedExecutable(sourceCommand, identity)
    identities.push({ label, ...identity })
  }
  return identities.sort((left, right) => left.label.localeCompare(right.label))
}

function assertValidatorOwnedExecutableContained (command, identity, repositoryRoot, label) {
  const executableCommands = getEffectiveExecutableCommands(command, repositoryRoot)
  const executableIdentities = [identity, ...(identity.delegated || [])]
  const selectedCommand = executableCommands.at(-1)
  const selectedIdentity = executableIdentities[executableCommands.length - 1]
  if (!selectedCommand || !selectedIdentity) {
    throw new Error(`Cannot approve ${label} because its selected executable could not be identified.`)
  }

  if (isNodeExecutable(selectedCommand.argv?.[0]) &&
    selectedIdentity.path === fs.realpathSync(process.execPath)) return

  const physicalRoot = fs.realpathSync(repositoryRoot)
  const relative = path.relative(physicalRoot, selectedIdentity.path)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Cannot approve ${label} because its validator-owned executable resolves outside the repository: ` +
      selectedIdentity.invocationPath
    )
  }
}

/**
 * Verifies and returns the canonical executable and approved invocation name used to spawn it.
 *
 * @param {object} command command about to execute
 * @param {{requireApproval?: boolean}} [options] verification options
 * @returns {{argv0: string, path: string}} approved launch identity
 */
function getExecutableForSpawn (command, options = {}) {
  const approved = getApprovedExecutable(command)
  const current = getCommandExecutableIdentity(command, undefined, approved?.repositoryRoot)
  if (!approved) {
    if (options.requireApproval) {
      throw new Error('The selected command executable was not covered by the approved execution plan.')
    }
    if (!current) throw new Error(`Command executable is unavailable: ${getExecutable(command)}`)
    return getLaunchIdentity(current)
  }
  if (!areExecutableIdentitiesEqual(current, approved)) {
    throw new Error(
      'The selected command executable changed after approval. Render and approve a fresh execution plan.'
    )
  }
  return getLaunchIdentity(approved)
}

/**
 * Resolves a command launcher and every executable delegated through env wrappers.
 *
 * @param {object} command manifest command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @param {string} [repositoryRoot] repository root containing execution-bearing entrypoints
 * @returns {{delegated?: object[], entrypoints?: object[], invocationPath: string, path: string,
 *   repositoryRoot?: string, sha256: string}|undefined} identity tree
 */
function getCommandExecutableIdentity (command, identitiesByPath, repositoryRoot) {
  const identities = []
  const entrypoints = []
  const executableCommands = getEffectiveExecutableCommands(command, repositoryRoot)
  for (const executableCommand of executableCommands) {
    const identity = getExecutableIdentity(executableCommand, identitiesByPath)
    if (!identity) return
    identities.push(identity)
    const nodeFiles = getNodeExecutionFileIdentities(executableCommand, identitiesByPath, repositoryRoot)
    for (const nodeFile of nodeFiles) {
      if (!entrypoints.some(candidate => candidate.path === nodeFile.path)) entrypoints.push(nodeFile)
    }
  }
  const packageJson = getPackageScriptConfigIdentity(command, identitiesByPath, repositoryRoot)
  if (packageJson && !entrypoints.some(candidate => candidate.path === packageJson.path)) entrypoints.push(packageJson)

  const [launcher, ...delegated] = identities
  return {
    ...launcher,
    ...(delegated.length > 0 ? { delegated } : {}),
    ...(entrypoints.length > 0 ? { entrypoints } : {}),
    ...(repositoryRoot ? { repositoryRoot: fs.realpathSync(repositoryRoot) } : {}),
  }
}

/**
 * Expands launchers to the project runner whose containment matters for validator-owned commands.
 *
 * External package managers and shells remain fingerprinted as launchers. Their statically resolved project runner is
 * the final executable that must remain inside the repository.
 *
 * @param {object} command manifest command
 * @param {string} [repositoryRoot] repository root containing package scripts and runner files
 * @returns {object[]} launcher and delegated executable commands in execution order
 */
function getEffectiveExecutableCommands (command, repositoryRoot) {
  const packageScriptCommand = repositoryRoot && getPackageScriptDirectCommand(command, repositoryRoot)
  const shellDirectCommand = getShellDirectCommand(command)
  return [
    ...getExecutableCommands(command),
    ...(packageScriptCommand ? getExecutableCommands(packageScriptCommand) : []),
    ...(shellDirectCommand ? getExecutableCommands(shellDirectCommand) : []),
  ]
}

/**
 * Fingerprints package.json when a package manager will resolve a script and its lifecycle at execution time.
 *
 * @param {object} command structured package command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @param {string} [repositoryRoot] repository root containing package.json
 * @returns {{invocationPath: string, path: string, sha256: string}|undefined} package metadata identity
 */
function getPackageScriptConfigIdentity (command, identitiesByPath, repositoryRoot) {
  if (!repositoryRoot || !getPackageScriptExpansion(command, repositoryRoot)) return
  return getContainedFileIdentity(
    path.join(command.cwd, 'package.json'),
    identitiesByPath,
    repositoryRoot,
    'package.json'
  )
}

/**
 * Checks whether the launcher and delegated executable identities still match approval.
 *
 * @param {object|undefined} current current identity tree
 * @param {object|undefined} approved approved identity tree
 * @returns {boolean} whether every executable matches
 */
function areExecutableIdentitiesEqual (current, approved) {
  if (!current || !approved) return false
  const currentIdentities = [current, ...(current.delegated || [])]
  const approvedIdentities = [approved, ...(approved.delegated || [])]
  if (currentIdentities.length !== approvedIdentities.length) return false
  if (current.repositoryRoot !== approved.repositoryRoot) return false

  const executablesMatch = currentIdentities.every((identity, index) => {
    const expected = approvedIdentities[index]
    return identity.invocationPath === expected.invocationPath && identity.path === expected.path &&
      identity.sha256 === expected.sha256
  })
  if (!executablesMatch) return false

  const currentEntrypoints = current.entrypoints || []
  const approvedEntrypoints = approved.entrypoints || []
  return currentEntrypoints.length === approvedEntrypoints.length && currentEntrypoints.every((identity, index) => {
    const expected = approvedEntrypoints[index]
    return identity.invocationPath === expected.invocationPath && identity.path === expected.path &&
      identity.sha256 === expected.sha256
  })
}

/**
 * Resolves and fingerprints every file Node.js can execute before or as the selected program.
 *
 * @param {object} command structured Node.js command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @param {string} [repositoryRoot] repository root containing the entrypoint
 * @returns {{invocationPath: string, path: string, sha256: string}[]} execution-bearing file identities
 */
function getNodeExecutionFileIdentities (command, identitiesByPath, repositoryRoot) {
  const nodeOptionsModules = getNodeOptionsExecutionModules(getEnvironmentValue(command.env || {}, 'NODE_OPTIONS'))
  if (command.usesShell || !isNodeExecutable(command.argv?.[0])) {
    return getNodeModuleFileIdentities(nodeOptionsModules, command, identitiesByPath, repositoryRoot)
  }
  const { entrypoint, modules } = getNodeExecutionFiles(command.argv)
  const identities = getNodeModuleFileIdentities(
    [...nodeOptionsModules, ...modules],
    command,
    identitiesByPath,
    repositoryRoot
  )
  if (entrypoint) {
    identities.push(getContainedFileIdentity(
      path.resolve(command.cwd, entrypoint),
      identitiesByPath,
      repositoryRoot,
      'Node.js program entrypoint'
    ))
  }
  return identities
}

/**
 * Resolves execution-bearing modules from NODE_OPTIONS.
 *
 * @param {string|undefined} nodeOptions effective project-provided NODE_OPTIONS
 * @returns {{label: string, specifier: string}[]} selected execution modules
 */
function getNodeOptionsExecutionModules (nodeOptions) {
  if (typeof nodeOptions !== 'string' || !nodeOptions.trim()) return []
  return getNodeExecutionFiles(['node', ...splitNodeOptions(nodeOptions)], { nodeOptions: true }).modules
}

/**
 * Splits NODE_OPTIONS without invoking a shell or expanding variables.
 *
 * @param {string} source NODE_OPTIONS source
 * @returns {string[]} Node.js arguments
 */
function splitNodeOptions (source) {
  const argumentsList = []
  let argument = ''
  let argumentStarted = false
  let quote
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '\0') throw new Error('Cannot approve NODE_OPTIONS containing a null byte.')
    if (!quote && /\s/.test(character)) {
      if (argumentStarted) argumentsList.push(argument)
      argument = ''
      argumentStarted = false
      continue
    }
    if (character === "'" || character === '"') {
      if (!quote) {
        quote = character
        argumentStarted = true
        continue
      }
      if (quote === character) {
        quote = undefined
        continue
      }
    }
    const escapedCharacter = source[index + 1]
    const escapesNodeOptionsCharacter = quote
      ? escapedCharacter === quote || escapedCharacter === '\\'
      : /\s|['"\\]/.test(escapedCharacter || '')
    if (character === '\\' && escapedCharacter && escapesNodeOptionsCharacter) {
      argument += source[++index]
      argumentStarted = true
      continue
    }
    argument += character
    argumentStarted = true
  }
  if (quote) throw new Error('Cannot approve NODE_OPTIONS with an unterminated quoted value.')
  if (argumentStarted) argumentsList.push(argument)
  return argumentsList
}

/**
 * Resolves and fingerprints Node.js preload, import, and loader modules.
 *
 * @param {{label: string, specifier: string}[]} modules selected execution modules
 * @param {object} command structured command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @param {string} [repositoryRoot] repository root containing the modules
 * @returns {{invocationPath: string, path: string, sha256: string}[]} module identities
 */
function getNodeModuleFileIdentities (modules, command, identitiesByPath, repositoryRoot) {
  const identities = []
  if (getEnvironmentValue(command.env || {}, 'NODE_PATH')?.trim() &&
    modules.some(({ specifier }) => isBareNodeModuleSpecifier(specifier))) {
    throw new Error(
      'Cannot approve a bare Node.js preload while NODE_PATH is set because module resolution could select a ' +
      'different file at execution time. Use an explicit repository-contained preload path or remove NODE_PATH.'
    )
  }
  for (const { label, specifier } of modules) {
    const filename = resolveNodeModuleFile(specifier, command.cwd, label)
    if (!filename) continue
    identities.push(getContainedFileIdentity(filename, identitiesByPath, repositoryRoot, label))
  }
  return identities
}

/**
 * Reports whether Node.js will resolve a module specifier through package lookup paths.
 *
 * @param {string} specifier Node.js module specifier
 * @returns {boolean} whether the specifier is a bare module name
 */
function isBareNodeModuleSpecifier (specifier) {
  return !BUILTIN_MODULES.has(specifier) && !specifier.startsWith('data:') && !specifier.startsWith('file:') &&
    !path.isAbsolute(specifier) && !specifier.startsWith('.')
}

/**
 * Resolves, contains, and fingerprints one execution-bearing file.
 *
 * @param {string} invocationPath path selected by the approved command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @param {string} [repositoryRoot] repository root containing the file
 * @param {string} label customer-facing file label
 * @returns {{invocationPath: string, path: string, sha256: string}} file identity
 */
function getContainedFileIdentity (invocationPath, identitiesByPath, repositoryRoot, label) {
  let canonicalPath
  try {
    canonicalPath = fs.realpathSync(invocationPath)
  } catch {
    throw new Error(`The ${label} is unavailable: ${invocationPath}`)
  }
  if (repositoryRoot) {
    const physicalRoot = fs.realpathSync(repositoryRoot)
    const relative = path.relative(physicalRoot, canonicalPath)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`The ${label} resolves outside the repository: ${invocationPath}`)
    }
  }

  const cached = identitiesByPath?.get(canonicalPath)
  if (cached) return { invocationPath, ...cached }
  const stat = fs.statSync(canonicalPath)
  if (!stat.isFile()) throw new Error(`The ${label} is not a regular file: ${invocationPath}`)
  const canonicalIdentity = {
    path: canonicalPath,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(canonicalPath)).digest('hex'),
  }
  identitiesByPath?.set(canonicalPath, canonicalIdentity)
  return { invocationPath, ...canonicalIdentity }
}

/**
 * Finds files selected by Node.js execution options without interpreting project code.
 *
 * @param {string[]} argv Node.js command arguments
 * @param {{nodeOptions?: boolean}} [options] parsing context
 * @returns {{entrypoint?: string, modules: {label: string, specifier: string}[]}} selected execution files
 */
function getNodeExecutionFiles (argv, options = {}) {
  const modules = []
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--') {
      if (options.nodeOptions) throw getUnsupportedNodeOptionError(argument, 'NODE_OPTIONS')
      return { entrypoint: getNodeEntrypoint(argv[index + 1]), modules }
    }
    if (argument === '-') {
      throw new Error('Cannot approve a Node.js command that reads its program from standard input.')
    }
    if (['-e', '--eval', '-p', '--print'].includes(argument)) {
      if (options.nodeOptions) throw getUnsupportedNodeOptionError(argument, 'NODE_OPTIONS')
      if (typeof argv[index + 1] !== 'string') throw getMissingNodeOptionValueError(argument)
      return { modules }
    }
    if (/^(?:--eval|--print)=/.test(argument) || /^-[ep].+/.test(argument)) {
      if (options.nodeOptions) throw getUnsupportedNodeOptionError(argument, 'NODE_OPTIONS')
      return { modules }
    }
    const equalsIndex = argument.indexOf('=')
    const rawOptionName = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    const optionName = normalizeClassifiedNodeOptionName(rawOptionName)
    if (NODE_EXECUTION_FILE_OPTIONS.has(optionName)) {
      if (equalsIndex !== -1) {
        const specifier = argument.slice(equalsIndex + 1)
        if (!specifier) throw getMissingNodeOptionValueError(rawOptionName)
        modules.push({ label: NODE_EXECUTION_FILE_OPTIONS.get(optionName), specifier })
        continue
      }
      const specifier = argv[++index]
      if (typeof specifier !== 'string' || !specifier) throw getMissingNodeOptionValueError(rawOptionName)
      modules.push({ label: NODE_EXECUTION_FILE_OPTIONS.get(optionName), specifier })
      continue
    }
    if (/^-r.+/.test(argument)) {
      modules.push({ label: NODE_EXECUTION_FILE_OPTIONS.get('-r'), specifier: argument.slice(2) })
      continue
    }
    if (REJECTED_NODE_FILE_OPTIONS.has(optionName) || optionName === '-C') {
      throw new Error(
        `Cannot approve Node.js option ${JSON.stringify(rawOptionName)} because it can load undisclosed ` +
        'environment, configuration, snapshot, package-script, or test-hook input. Use a direct Node.js or ' +
        'test-runner command without that option.'
      )
    }
    if (NODE_OPTIONAL_INLINE_VALUE_OPTIONS.has(optionName)) {
      if (equalsIndex === -1 || argument.slice(equalsIndex + 1)) continue
      throw getMissingNodeOptionValueError(rawOptionName)
    }
    if (NODE_INLINE_VALUE_OPTIONS.has(optionName)) {
      if (equalsIndex !== -1 && argument.slice(equalsIndex + 1)) continue
      throw new Error(
        `Cannot approve Node.js option ${JSON.stringify(rawOptionName)} without its value in --option=value form.`
      )
    }
    if (equalsIndex === -1 && NODE_FLAG_OPTIONS.has(optionName)) {
      continue
    }
    if (argument.startsWith('-')) throw getUnsupportedNodeOptionError(argument, 'the selected command')
    if (options.nodeOptions) {
      throw new Error(`Cannot approve NODE_OPTIONS containing non-option argument ${JSON.stringify(argument)}.`)
    }
    return { entrypoint: argument, modules }
  }
  return { modules }
}

/**
 * Normalizes Node.js underscore aliases only when their hyphenated form has an explicit approval classification.
 *
 * @param {string} optionName Node.js option name
 * @returns {string} classified canonical option name or the unchanged unknown name
 */
function normalizeClassifiedNodeOptionName (optionName) {
  if (!optionName.startsWith('--') || !optionName.includes('_')) return optionName
  const normalized = optionName.replaceAll('_', '-')
  if (NODE_EXECUTION_FILE_OPTIONS.has(normalized) || NODE_FLAG_OPTIONS.has(normalized) ||
    NODE_INLINE_VALUE_OPTIONS.has(normalized) || NODE_OPTIONAL_INLINE_VALUE_OPTIONS.has(normalized) ||
    REJECTED_NODE_FILE_OPTIONS.has(normalized)) {
    return normalized
  }
  return optionName
}

/**
 * Rejects a missing or empty required Node.js option value.
 *
 * @param {string} option Node.js option
 * @returns {Error} refusal error
 */
function getMissingNodeOptionValueError (option) {
  return new Error(`Cannot approve Node.js option ${JSON.stringify(option)} without its required value.`)
}

/**
 * Rejects Node.js options that have no explicit approval classification.
 *
 * @param {string} option Node.js option
 * @param {string} source option source
 * @returns {Error} refusal error
 */
function getUnsupportedNodeOptionError (option, source) {
  return new Error(
    `Cannot approve unsupported or unclassified Node.js option ${JSON.stringify(option)} from ${source}. ` +
    'Use a direct Node.js or test-runner command whose code-loading inputs can be fingerprinted.'
  )
}

/**
 * Returns a declared Node.js program entrypoint without accepting stdin or a missing value.
 *
 * @param {string|undefined} entrypoint selected entrypoint
 * @returns {string} entrypoint
 */
function getNodeEntrypoint (entrypoint) {
  if (!entrypoint || entrypoint === '-') {
    throw new Error('Cannot approve a Node.js command without a regular program entrypoint after "--".')
  }
  return entrypoint
}

/**
 * Resolves a Node.js preload, import, or loader specifier to a local file.
 *
 * @param {string} specifier Node.js module specifier
 * @param {string} cwd command working directory
 * @param {string} label execution role of the module
 * @returns {string|undefined} resolved local file, or undefined for code embedded in Node itself or the command
 */
function resolveNodeModuleFile (specifier, cwd, label) {
  if (BUILTIN_MODULES.has(specifier) || specifier.startsWith('data:')) return
  if (label !== 'Node.js preload module' && !specifier.startsWith('file:') &&
    !path.isAbsolute(specifier) && !specifier.startsWith('.')) {
    throw new Error(`The ${label} must use an explicit repository-contained file path: ${specifier}`)
  }
  try {
    if (specifier.startsWith('file:')) return fileURLToPath(specifier)
    if (label !== 'Node.js preload module') {
      return path.resolve(cwd, specifier)
    }
    return createRequire(path.join(cwd, '__dd_validation_resolve.js')).resolve(specifier)
  } catch {
    throw new Error(`The Node.js preload or loader module is unavailable: ${specifier}`)
  }
}

/**
 * Expands nested env wrappers into the commands whose executables they delegate to.
 *
 * @param {object} command manifest command
 * @returns {object[]} launcher followed by delegated commands
 */
function getExecutableCommands (command) {
  const commands = [command]
  let current = command
  while (!current.usesShell && isEnvExecutable(current.argv?.[0])) {
    current = getEnvDelegatedCommand(current)
    commands.push(current)
  }
  return commands
}

/**
 * Returns the command executed by an env wrapper with its effective PATH and working directory.
 *
 * @param {object} command env wrapper command
 * @returns {object} delegated command
 */
function getEnvDelegatedCommand (command) {
  const parsed = parseArgv(command.argv)
  if (parsed.unsupportedEnvOption) {
    throw new Error(
      `Cannot approve env-wrapped command because option "${parsed.unsupportedEnvOption}" prevents reliable ` +
      'executable fingerprinting.'
    )
  }
  if (parsed.commandIndex >= command.argv.length) {
    throw new Error('Cannot approve env-wrapped command because it does not identify a delegated executable.')
  }
  const delegatedExecutable = command.argv[parsed.commandIndex]
  const requiresPathLookup = !isExplicitExecutablePath(delegatedExecutable)
  if (requiresPathLookup && parsed.unsetEnvNames.some(name => name.toUpperCase() === 'PATH')) {
    throw new Error('Cannot approve env-wrapped command because it removes PATH before selecting its executable.')
  }

  const env = parsed.ignoreEnvironment ? { ...parsed.prefixEnv } : { ...command.env, ...parsed.prefixEnv }
  if (requiresPathLookup && parsed.ignoreEnvironment && !Object.hasOwn(env, 'PATH')) {
    throw new Error(
      'Cannot approve env-wrapped command because it clears the environment without declaring an explicit PATH.'
    )
  }

  return {
    ...command,
    argv: command.argv.slice(parsed.commandIndex),
    cwd: parsed.workingDirectory ? path.resolve(command.cwd, parsed.workingDirectory) : command.cwd,
    env,
  }
}

/**
 * Selects the verified path and invocation name used to launch an executable.
 *
 * @param {{invocationPath: string, path: string}} identity verified executable identity
 * @returns {{argv0: string, path: string}} executable launch identity
 */
function getLaunchIdentity (identity) {
  return {
    argv0: identity.invocationPath,
    // Windows package-manager shims rely on their invoked path. The canonical target is still verified above.
    path: process.platform === 'win32' ? identity.invocationPath : identity.path,
  }
}

/**
 * Resolves one command executable to a stable canonical path and content digest.
 *
 * @param {object} command manifest command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @returns {{invocationPath: string, path: string, sha256: string}|undefined} executable identity
 */
function getExecutableIdentity (command, identitiesByPath) {
  const resolved = getResolvedExecutable(command)
  if (!resolved) return
  const canonicalPath = fs.realpathSync(resolved)
  const cached = identitiesByPath?.get(canonicalPath)
  if (cached) return { invocationPath: resolved, ...cached }
  const stat = fs.statSync(canonicalPath)
  if (!stat.isFile()) return
  const canonicalIdentity = {
    path: canonicalPath,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(canonicalPath)).digest('hex'),
  }
  identitiesByPath?.set(canonicalPath, canonicalIdentity)
  return { invocationPath: resolved, ...canonicalIdentity }
}

/**
 * Enumerates every executable-bearing manifest command with a stable approval label.
 *
 * @param {object} manifest loaded manifest
 * @returns {Array<[string, object]>} labeled commands
 */
function getManifestCommands (manifest) {
  const commands = []
  for (const framework of manifest.frameworks || []) {
    const prefix = `framework:${framework.id}`
    const basicSource = framework.existingTestCommand
    if (basicSource) {
      commands.push([`${prefix}:basic-reporting`, getLocalValidationCommand(framework, basicSource), basicSource])
    }
    for (const [index, candidate] of (framework.localTestCandidates || []).entries()) {
      if (candidate?.command) {
        commands.push([
          `${prefix}:local-test-candidate:${index}`,
          getLocalValidationCommand(framework, candidate.command),
          candidate.command,
        ])
      }
    }
    for (const [index, candidate] of (framework.isolationTestCandidates || []).entries()) {
      commands.push([
        `${prefix}:isolation:${index}`,
        getLocalValidationCommand(framework, candidate.command),
        candidate.command,
      ])
    }
    if (!Array.isArray(framework.isolationTestCandidates) && framework.isolationTestCandidate?.command) {
      commands.push([
        `${prefix}:isolation`,
        getLocalValidationCommand(framework, framework.isolationTestCandidate.command),
        framework.isolationTestCandidate.command,
      ])
    }
    for (const [index, command] of (framework.setup?.commands || []).entries()) {
      commands.push([`${prefix}:setup:${index}`, command, command])
    }
    for (const [index, scenario] of (framework.generatedTestStrategy?.scenarios || []).entries()) {
      if (scenario.runCommand) {
        commands.push([
          `${prefix}:generated:${index}`,
          getLocalValidationCommand(framework, scenario.runCommand),
          scenario.runCommand,
        ])
      }
    }
  }
  return commands
}

/**
 * Detects explicit executable paths using platform path syntax.
 *
 * @param {string} executable executable name or path
 * @param {string} [platform] target platform
 * @returns {boolean} whether the value is a path rather than a PATH name
 */
function isExplicitExecutablePath (executable, platform = process.platform) {
  return path.isAbsolute(executable) || executable.includes('/') || (platform === 'win32' && executable.includes('\\'))
}

function getExecutableExtensions () {
  if (process.platform !== 'win32') return ['']
  return ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
}

/**
 * Checks whether a filesystem entry can be executed.
 *
 * @param {string} filename executable candidate
 * @returns {boolean} whether the candidate is executable
 */
function isExecutable (filename) {
  try {
    fs.accessSync(filename, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Parses structured env wrappers and runtime plumbing without executing them.
 *
 * @param {string[]} argv command arguments
 * @returns {object} parsed wrapper details
 */
function parseArgv (argv) {
  const result = {
    ignoreEnvironment: false,
    prefixAssignments: [],
    prefixEnv: {},
    unsetEnvNames: [],
    commandIndex: 0,
    corepackIndex: -1,
    pathAdjusted: false,
    unsupportedEnvOption: undefined,
    workingDirectory: undefined,
  }

  if (!Array.isArray(argv) || argv.length === 0) return result

  let index = 0
  if (isEnvExecutable(argv[index])) {
    index++
    while (index < argv.length) {
      const option = argv[index]
      if (option === '--') {
        index++
        break
      }
      if (option === '-' || option === '-i' || option === '--ignore-environment') {
        result.ignoreEnvironment = true
        index++
        continue
      }
      if (option === '-u' || option === '--unset') {
        if (typeof argv[index + 1] === 'string') result.unsetEnvNames.push(argv[index + 1])
        index += 2
        continue
      }
      const unsetMatch = /^(?:-u|--unset=)(.+)$/.exec(option)
      if (unsetMatch) {
        result.unsetEnvNames.push(unsetMatch[1])
        index++
        continue
      }
      if (option === '-C' || option === '--chdir') {
        if (typeof argv[index + 1] !== 'string') {
          result.unsupportedEnvOption = option
          break
        }
        result.workingDirectory = argv[index + 1]
        index += 2
        continue
      }
      const chdirMatch = /^(?:-C(.+)|--chdir=(.+))$/.exec(option)
      if (chdirMatch) {
        result.workingDirectory = chdirMatch[1] || chdirMatch[2]
        index++
        continue
      }
      if (option === '-S' || option === '--split-string' || /^(?:-S.+|--split-string=.+)$/.test(option)) {
        result.unsupportedEnvOption = option
        break
      }
      if (isSupportedEnvFlag(option)) {
        index++
        continue
      }
      if (option.startsWith('-')) {
        result.unsupportedEnvOption = option
        break
      }
      if (!isEnvAssignment(option)) break

      const assignment = argv[index]
      const equalsIndex = assignment.indexOf('=')
      const name = assignment.slice(0, equalsIndex)
      const value = assignment.slice(equalsIndex + 1)
      result.prefixEnv[name] = value

      if (environmentNamesEqual(name, 'PATH')) {
        result.pathAdjusted = true
      } else {
        result.prefixAssignments.push(assignment)
      }
      index++
    }
  }

  result.commandIndex = index

  if (isNodeExecutable(argv[index]) && isCorepackScript(argv[index + 1]) && argv[index + 2]) {
    result.corepackIndex = index + 1
  }

  return result
}

function isSupportedEnvFlag (option) {
  return /^(?:-0|-v|--null|--debug|--help|--version|--list-signal-handling)$/.test(option) ||
    /^--(?:block|default|ignore)-signal(?:=.*)?$/.test(option)
}

function isEnvExecutable (value) {
  const name = getExecutableName(value)
  return name === 'env' || name === 'env.exe'
}

function isEnvAssignment (value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
}

function isNodeExecutable (value = '') {
  const name = getExecutableName(value)
  return name === 'node' || name === 'node.exe'
}

function isCorepackScript (value = '') {
  const name = getExecutableName(value)
  return name === 'corepack' || name === 'corepack.exe' || name === 'corepack.js'
}

function getExecutableName (value = '') {
  return String(value).split(/[\\/]/).pop().toLowerCase()
}

module.exports = {
  bindManifestExecutables,
  getApprovedExecutable,
  getExecutableForSpawn,
  getManifestCommands,
  getResolvedExecutable,
  getUnavailableExecutable,
  isEnvExecutable,
  isExplicitExecutablePath,
  isNodeExecutable,
  parseArgv,
  splitNodeOptions,
}
