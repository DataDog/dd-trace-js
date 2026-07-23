'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')

const { getEnvironmentValue } = require('./environment')
const { sanitizeString } = require('./redaction')

const MAX_CONFIG_BYTES = 512 * 1024
const DIRECT_RUNNER_COMMANDS = new Set([
  'cucumber', 'cucumber-js', 'cypress', 'jest', 'mocha', 'node', 'node.exe', 'playwright', 'vitest',
])
const SHELL_COMMANDS = new Set([
  'bash', 'cmd', 'cmd.exe', 'cross-env-shell', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh',
])
const PACKAGE_MANAGER_BUILTINS = {
  npm: new Set(['access', 'adduser', 'audit', 'cache', 'ci', 'config', 'dedupe', 'deprecate', 'diff', 'dist-tag',
    'docs', 'doctor', 'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'help', 'hook', 'init', 'install',
    'link', 'll', 'login', 'logout', 'ls', 'org', 'outdated', 'owner', 'pack', 'ping', 'prefix', 'profile', 'prune',
    'publish', 'query', 'rebuild', 'repo', 'root', 'search', 'set', 'shrinkwrap', 'star', 'stars', 'team', 'token',
    'uninstall', 'unpublish', 'unstar', 'update', 'version', 'view', 'whoami']),
  pnpm: new Set(['add', 'audit', 'config', 'create', 'deploy', 'dlx', 'env', 'exec', 'fetch', 'import', 'init',
    'install', 'link', 'list', 'outdated', 'pack', 'patch', 'prune', 'publish', 'rebuild', 'remove', 'root', 'server',
    'setup', 'store', 'unlink', 'update']),
  yarn: new Set(['add', 'cache', 'config', 'create', 'dlx', 'exec', 'import', 'info', 'init', 'install', 'link', 'npm',
    'pack', 'patch', 'plugin', 'remove', 'set', 'stage', 'unlink', 'unplug', 'up', 'upgrade', 'version', 'why',
    'workspace', 'workspaces']),
}
const NODE_SEPARATE_VALUE_OPTIONS = new Set([
  '-e', '-p', '-r', '--eval', '--experimental-loader', '--import', '--loader', '--print', '--require',
])
const NODE_SOURCE_OPTIONS = new Set(['-e', '-p', '--eval', '--print'])
const NODE_OUTPUT_ENV = new Map([
  ['NODE_COMPILE_CACHE', 'creates an undeclared compile-cache directory'],
  ['NODE_REDIRECT_WARNINGS', 'redirects warnings to an undeclared file'],
  ['NODE_V8_COVERAGE', 'creates undeclared coverage output'],
])
const RUNNER_ENTRYPOINT_PATTERNS = {
  cucumber: /(?:^|[/_.-])cucumber(?:-js)?(?:[/_.-]|$)/i,
  cypress: /(?:^|[/_.-])cypress(?:[/_.-]|$)/i,
  jest: /(?:^|[/_.-])jest(?:[/_.-]|$)/i,
  mocha: /(?:^|[/_.-])mocha(?:[/_.-]|$)/i,
  playwright: /(?:^|[/@_.-])playwright(?:[/_.-]|$)/i,
  vitest: /(?:^|[/_.-])vitest(?:[/_.-]|$)/i,
}

/**
 * Returns why a planned command cannot reliably start the selected runner.
 * Project dependency and test-collection behavior belongs to the approved clean preflight.
 *
 * @param {object} input suitability input
 * @param {object} input.command manifest command
 * @param {object} input.framework manifest framework
 * @param {string} input.repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getCommandSuitabilityError ({ command, framework, repositoryRoot }) {
  const shellError = getShellCommandError(command, framework.framework)
  if (shellError) return shellError

  const yarnError = getRepositoryYarnError(command, repositoryRoot)
  if (yarnError) return yarnError

  const packageScriptError = getPackageScriptForwardingError(command, repositoryRoot)
  if (packageScriptError) return packageScriptError
  const lifecycleError = getPackageScriptLifecycleError(command, framework.framework, repositoryRoot)
  if (lifecycleError) return lifecycleError

  const directCommand = getValidatedDirectCommand(command, repositoryRoot)
  const directCommandError = getStructuredDirectCommandError(directCommand, framework.framework, repositoryRoot)
  if (directCommandError) return directCommandError

  const runtimeModeError = getUnsuitableNodeRuntimeError(directCommand)
  if (runtimeModeError) return runtimeModeError
}

/**
 * Reduces an accepted shell or package-script command to the direct invocation it discloses.
 *
 * @param {object} command manifest command
 * @param {string} repositoryRoot repository root
 * @returns {object} direct command
 */
function getValidatedDirectCommand (command, repositoryRoot) {
  if (command.usesShell) return getShellDirectCommand(command) || command
  return getPackageScriptDirectCommand(command, repositoryRoot) || command
}

/**
 * Rejects structured commands that do not directly select Node.js or the matching installed test runner.
 *
 * @param {object} command direct structured command
 * @param {string} framework selected framework
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getStructuredDirectCommandError (command, framework, repositoryRoot) {
  const invocation = unwrapStructuredEnvironmentCommand(command)
  if (invocation.error) return invocation.error
  const [executable, ...args] = invocation.argv
  const commandName = getCommandName(executable)
  if (commandName === 'node' || commandName === 'node.exe') {
    const entrypoint = getNodeProgramEntrypoint(args)
    if (!entrypoint || !isRunnerEntrypoint(entrypoint, framework, command.cwd, repositoryRoot)) {
      return `uses Node.js program ${JSON.stringify(entrypoint || '')}, which is not a repository-contained ` +
        `${framework} runner entrypoint. Use the selected installed ${framework} runner directly.`
    }
    return
  }
  if (isDirectRunnerCommand(commandName, framework)) return

  return `uses unsupported command ${JSON.stringify(executable || '')}. Use the selected installed ${framework} ` +
    'runner directly instead of a downloader, package-manager exec command, nested shell, or unrelated executable.'
}

/**
 * Removes supported structured env prefixes without evaluating variables or changing the command.
 *
 * @param {object} command structured command
 * @returns {{argv: string[], env: object, error?: string}} direct invocation
 */
function unwrapStructuredEnvironmentCommand (command) {
  let argv = [...(command.argv || [])]
  const env = { ...command.env }
  while (getCommandName(argv[0]) === 'env') {
    let index = 1
    while (index < argv.length) {
      const word = argv[index]
      if (word === '--') {
        index++
        break
      }
      if (['-u', '--unset'].includes(word)) {
        index += 2
        continue
      }
      if (/^(?:-u.+|--unset=)/.test(word) || ['-i', '--ignore-environment'].includes(word)) {
        index++
        continue
      }
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word)
      if (match) {
        env[match[1]] = match[2]
        index++
        continue
      }
      if (word.startsWith('-')) {
        return {
          argv,
          env,
          error: `uses unsupported env wrapper option ${JSON.stringify(word)}. Use a structured direct runner command`,
        }
      }
      break
    }
    argv = argv.slice(index)
  }
  return { argv, env }
}

/**
 * Finds the Node.js program without interpreting application arguments after it.
 *
 * @param {string[]} args Node.js arguments after the executable
 * @returns {string|undefined} selected program
 */
function getNodeProgramEntrypoint (args) {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--') return args[index + 1]
    const option = normalizeNodeOptionName(argument.split('=', 1)[0])
    if (NODE_SOURCE_OPTIONS.has(option)) return
    if (NODE_SEPARATE_VALUE_OPTIONS.has(option) && !argument.includes('=')) {
      index++
      continue
    }
    if (argument.startsWith('-')) continue
    return argument
  }
}

/**
 * Confirms that a Node.js program is a contained entrypoint associated with the selected runner.
 *
 * @param {string} entrypoint selected Node.js program
 * @param {string} framework selected framework
 * @param {string} cwd command working directory
 * @param {string} repositoryRoot repository root
 * @returns {boolean} whether the entrypoint is suitable
 */
function isRunnerEntrypoint (entrypoint, framework, cwd, repositoryRoot) {
  if (typeof entrypoint !== 'string' || !entrypoint || entrypoint.startsWith('-')) return false
  const filename = path.resolve(cwd, entrypoint)
  const source = readRepositoryFile(filename, repositoryRoot)
  if (source === undefined) return false
  const pattern = RUNNER_ENTRYPOINT_PATTERNS[framework]
  return Boolean(pattern?.test(filename.replaceAll('\\', '/')) || pattern?.test(source))
}

/**
 * Rejects Node.js modes that open listeners, wait for changes, or create undeclared files.
 *
 * @param {object} command direct structured command
 * @returns {string|undefined} suitability error
 */
function getUnsuitableNodeRuntimeError (command) {
  const invocation = unwrapStructuredEnvironmentCommand(command)
  if (invocation.error) return invocation.error
  for (const [name, reason] of NODE_OUTPUT_ENV) {
    if (getEnvironmentValue(invocation.env, name)) {
      return `sets ${name}, which ${reason}. Remove it from the focused validation command.`
    }
  }

  const [executable, ...args] = invocation.argv
  const nodeOptions = getEnvironmentValue(invocation.env, 'NODE_OPTIONS')
  if (typeof nodeOptions === 'string') {
    const optionError = getUnsuitableNodeOptionError(tokenizeStaticShellCommand(nodeOptions), true)
    if (optionError) return optionError
  }
  if (!['node', 'node.exe'].includes(getCommandName(executable))) return
  return getUnsuitableNodeOptionError(args, false)
}

/**
 * Reports an unsuitable Node.js option before the program entrypoint.
 *
 * @param {string[]} args Node.js arguments or NODE_OPTIONS tokens
 * @param {boolean} nodeOptions whether every token belongs to NODE_OPTIONS
 * @returns {string|undefined} suitability error
 */
function getUnsuitableNodeOptionError (args, nodeOptions) {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (!nodeOptions && argument === '--') break
    if (!nodeOptions && !argument.startsWith('-')) break
    const optionName = normalizeNodeOptionName(argument.split('=', 1)[0])
    const reason = getUnsuitableNodeOptionReason(optionName, argument)
    if (reason) {
      return `uses Node.js option ${JSON.stringify(optionName)}, which ${reason}. Remove it from the focused ` +
        'validation command.'
    }
    if (NODE_SEPARATE_VALUE_OPTIONS.has(optionName) && !argument.includes('=')) index++
  }
}

/**
 * Describes why a Node.js runtime mode is unsuitable for focused validation.
 *
 * @param {string} optionName normalized Node.js option
 * @param {string} argument original argument
 * @returns {string|undefined} refusal reason
 */
function getUnsuitableNodeOptionReason (optionName, argument) {
  if (/inspect/.test(optionName)) return 'opens or configures an inspector listener'
  if (optionName.startsWith('--watch') && !/=false$/i.test(argument)) return 'waits for file changes instead of exiting'
  if (/^--(?:cpu-prof|heap-prof|prof(?:-process)?|track-heap-objects)(?:-|$)/.test(optionName)) {
    return 'enables profiling or heap tracking and can create undeclared output'
  }
  if (/^--(?:heapsnapshot|diagnostic-dir|report-)/.test(optionName)) {
    return 'creates heap snapshot or diagnostic report output'
  }
  if (optionName === '--redirect-warnings') return 'redirects warnings to an undeclared file'
  if (optionName === '--tls-keylog') return 'writes TLS key material to a file'
  if (optionName.startsWith('--trace-event')) return 'creates undeclared trace-event output'
}

/**
 * Normalizes documented Node.js underscore aliases for suitability checks.
 *
 * @param {string} optionName Node.js option
 * @returns {string} normalized option name
 */
function normalizeNodeOptionName (optionName) {
  return optionName.startsWith('--') ? optionName.replaceAll('_', '-') : optionName
}

/**
 * Rejects package scripts whose complete lifecycle cannot be represented by the approved command.
 *
 * @param {object} command structured command
 * @param {string} framework selected framework
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} lifecycle error
 */
function getPackageScriptLifecycleError (command, framework, repositoryRoot) {
  const expansion = getPackageScriptExpansion(command, repositoryRoot)
  if (!expansion) return

  const packageJsonSource = readRepositoryFile(path.join(command.cwd, 'package.json'), repositoryRoot)
  if (!packageJsonSource) return
  let scripts
  try {
    scripts = JSON.parse(packageJsonSource).scripts || {}
  } catch {
    return
  }

  const lifecycle = [`pre${expansion.scriptName}`, `post${expansion.scriptName}`]
    .find(name => typeof scripts[name] === 'string' && scripts[name].trim())
  if (lifecycle) {
    return `would automatically run undisclosed lifecycle script ${JSON.stringify(lifecycle)}. Use an installed ` +
      'runner command that does not trigger package lifecycle scripts.'
  }
  if (!isSingleStaticShellCommand(expansion.script)) {
    return `expands package script ${JSON.stringify(expansion.scriptName)} to a compound shell command or dynamic ` +
      'shell evaluation. The validator does not execute undisclosed setup or follow-up commands; use a direct ' +
      'focused runner command instead.'
  }
  if (/(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?[A-Za-z0-9:_-]+(?:\s|$)/.test(expansion.script)) {
    return `expands package script ${JSON.stringify(expansion.scriptName)} through another package script whose ` +
      'lifecycle is not represented in the approval plan. Use a direct focused runner command instead.'
  }
  const { error } = parseDirectPackageScriptCommand(command, expansion, framework, repositoryRoot)
  if (error) {
    return `expands package script ${JSON.stringify(expansion.scriptName)} ${error}. The validator accepts only ` +
      'direct Node.js or supported test-runner commands; use a direct focused runner command instead.'
  }
}

/**
 * Converts an accepted package script into the structured command whose executable files must be approval-bound.
 *
 * @param {object} command structured package-manager command
 * @param {string} repositoryRoot repository root
 * @returns {object|undefined} direct structured command
 */
function getPackageScriptDirectCommand (command, repositoryRoot) {
  const expansion = getPackageScriptExpansion(command, repositoryRoot)
  if (!expansion || !isSingleStaticShellCommand(expansion.script)) return
  return parseDirectPackageScriptCommand(command, expansion, undefined, repositoryRoot).command
}

/**
 * Converts an accepted shell command into the direct command whose executable must be approval-bound.
 *
 * @param {object} command shell command
 * @returns {object|undefined} direct structured command
 */
function getShellDirectCommand (command) {
  if (!command?.usesShell) return
  return parseDirectShellCommand(command).command
}

/**
 * Rejects shell commands that cannot be reduced to one literal supported runner invocation.
 *
 * @param {object} command shell command
 * @param {string} framework selected framework
 * @returns {string|undefined} suitability error
 */
function getShellCommandError (command, framework) {
  if (!command.usesShell) return
  const { error } = parseDirectShellCommand(command, framework)
  if (!error) return
  return `${error}. Shell commands must reduce to one literal Node.js or matching test-runner command. ` +
    'Use a structured direct command with an argv array instead.'
}

/**
 * Parses a shell command without expanding aliases, variables, wrappers, or lifecycle scripts.
 *
 * @param {object} command shell command
 * @param {string|undefined} framework selected framework, when known
 * @returns {{command?: object, error?: string}} direct command or refusal reason
 */
function parseDirectShellCommand (command, framework) {
  const source = command.shellCommand || ''
  if (!isSingleStaticShellCommand(source)) {
    return { error: 'uses compound or dynamic shell evaluation' }
  }
  const words = tokenizeStaticShellCommand(source)
  const env = { ...command.env }
  const directIndex = consumeEnvironmentAssignments(words, 0, env)
  const directCommand = words[directIndex]
  if (!directCommand || hasDynamicCommandWord(directCommand)) {
    return { error: `uses dynamic command word ${JSON.stringify(directCommand || '')}` }
  }
  const dynamicArgument = words.slice(directIndex + 1).find(hasDynamicCommandWord)
  if (dynamicArgument) return { error: `uses dynamic shell argument ${JSON.stringify(dynamicArgument)}` }
  const directName = getCommandName(directCommand)
  if (!isDirectRunnerCommand(directName, framework)) {
    return { error: `uses unsupported wrapper, package manager, shell, or command ${JSON.stringify(directCommand)}` }
  }

  return {
    command: {
      ...command,
      argv: words.slice(directIndex),
      env,
      usesShell: false,
    },
  }
}

/**
 * Parses the narrow package-script grammar accepted for local execution.
 *
 * @param {object} command structured package-manager command
 * @param {object} expansion package-script expansion
 * @param {string|undefined} framework selected framework, when known
 * @param {string} repositoryRoot repository root
 * @returns {{command?: object, error?: string}} direct command or refusal reason
 */
function parseDirectPackageScriptCommand (command, expansion, framework, repositoryRoot) {
  const words = tokenizeStaticShellCommand(expansion.script)
  const env = { ...command.env }
  const start = consumeEnvironmentAssignments(words, 0, env)
  let directIndex = start

  while (getCommandName(words[directIndex]) === 'env') {
    directIndex = skipEnvOptions(words, directIndex + 1)
    directIndex = consumeEnvironmentAssignments(words, directIndex, {})
  }

  const directCommand = words[directIndex]
  if (!directCommand || hasDynamicCommandWord(directCommand)) {
    return { error: `through dynamic command word ${JSON.stringify(directCommand || '')}` }
  }
  const dynamicArgument = words.slice(directIndex + 1).find(hasDynamicCommandWord)
  if (dynamicArgument) return { error: `through dynamic shell argument ${JSON.stringify(dynamicArgument)}` }
  const directName = getCommandName(directCommand)
  if (SHELL_COMMANDS.has(directName)) {
    return { error: `through nested shell interpreter ${JSON.stringify(directCommand)}` }
  }
  if (!isDirectRunnerCommand(directName, framework)) {
    return { error: `through unsupported wrapper or command ${JSON.stringify(directCommand)}` }
  }

  const argv = [...words.slice(start), ...expansion.forwardedArgs]
  return {
    command: {
      ...command,
      argv,
      env: {
        ...env,
        PATH: getPackageScriptPath(command.cwd, repositoryRoot, env.PATH),
      },
      usesShell: false,
    },
  }
}

/**
 * Tokenizes an already validated single shell command without evaluating expansions.
 *
 * @param {string} source package script source
 * @returns {string[]} static command words
 */
function tokenizeStaticShellCommand (source) {
  const words = []
  let word = ''
  let wordStarted = false
  let quote
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (!quote && /\s/.test(character)) {
      if (wordStarted) words.push(word)
      word = ''
      wordStarted = false
      continue
    }
    if (character === "'" || character === '"') {
      if (!quote) {
        quote = character
        wordStarted = true
        continue
      }
      if (quote === character) {
        quote = undefined
        continue
      }
    }
    if (character === '\\' && source[index + 1] && quote !== "'") {
      word += source[++index]
      wordStarted = true
      continue
    }
    word += character
    wordStarted = true
  }
  if (wordStarted) words.push(word)
  return words
}

/**
 * Skips leading NAME=value assignments.
 *
 * @param {string[]} words static command words
 * @param {number} start first word to inspect
 * @returns {number} first non-assignment word
 */
function consumeEnvironmentAssignments (words, start, env) {
  let index = start
  let match
  while ((match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(words[index] || ''))) {
    env[match[1]] = match[2]
    index++
  }
  return index
}

/**
 * Skips statically represented env options before its delegated command.
 *
 * @param {string[]} words static command words
 * @param {number} start first env argument
 * @returns {number} first possible delegated command word
 */
function skipEnvOptions (words, start) {
  let index = start
  for (; index < words.length; index++) {
    const word = words[index]
    if (word === '--') return index + 1
    if (['-u', '--unset', '-C', '--chdir'].includes(word)) {
      index++
      continue
    }
    if (/^(?:-u.+|--unset=|--chdir=)/.test(word) || ['-0', '-i', '--ignore-environment', '--null'].includes(word)) {
      continue
    }
    if (!word.startsWith('-')) return index
    return words.length
  }
  return index
}

/**
 * Returns the normalized command basename.
 *
 * @param {string|undefined} command command word
 * @returns {string} normalized command name
 */
function getCommandName (command) {
  return String(command || '').split(/[\\/]/).pop().replace(/\.cmd$/i, '').toLowerCase()
}

/**
 * Checks whether the shell selects the command through variable expansion.
 *
 * @param {string} command command word
 * @returns {boolean} whether the command is dynamic
 */
function hasDynamicCommandWord (command) {
  return command.includes('$') || /%[A-Za-z_][A-Za-z0-9_]*%/.test(command)
}

/**
 * Checks whether a command directly starts Node.js or the selected supported test runner.
 *
 * @param {string} commandName normalized command name
 * @param {string|undefined} framework selected framework, when known
 * @returns {boolean} whether the command shape is accepted
 */
function isDirectRunnerCommand (commandName, framework) {
  if (!DIRECT_RUNNER_COMMANDS.has(commandName)) return false
  if (!framework || commandName === 'node' || commandName === 'node.exe') return true
  if (framework === 'cucumber') return commandName === 'cucumber' || commandName === 'cucumber-js'
  return commandName === framework
}

/**
 * Reproduces the local node_modules/.bin search path added by package managers for script execution.
 *
 * @param {string} cwd package script working directory
 * @param {string} repositoryRoot repository root
 * @param {string|undefined} configuredPath explicitly configured PATH
 * @returns {string} package-script PATH
 */
function getPackageScriptPath (cwd, repositoryRoot, configuredPath) {
  const directories = []
  let directory = path.resolve(cwd)
  const root = path.resolve(repositoryRoot)
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    directories.push(path.join(directory, 'node_modules', '.bin'))
    if (directory === root) break
    directory = path.dirname(directory)
  }
  return [...directories, configuredPath ?? process.env.PATH ?? ''].filter(Boolean).join(path.delimiter)
}

/**
 * Accepts one statically readable shell command while respecting quoted and escaped literal characters.
 *
 * @param {string} source package script source
 * @returns {boolean} whether the shell can only evaluate one disclosed command
 */
function isSingleStaticShellCommand (source) {
  let quote
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '\n' || character === '\r') return false
    if (quote === "'") {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '\\') {
      if (++index >= source.length) return false
      continue
    }
    if (quote === '"') {
      if (character === quote) {
        quote = undefined
      } else if (character === '`' || (character === '$' && source[index + 1] === '(')) {
        return false
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (';&|<>`()'.includes(character) || (character === '$' && source[index + 1] === '(')) return false
  }
  return quote === undefined
}

/**
 * Rejects package-manager separators that become a literal runner argument.
 *
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} forwarding error
 */
function getPackageScriptForwardingError (command, repositoryRoot) {
  const expansion = getPackageScriptExpansion(command, repositoryRoot)
  if (!expansion || !['pnpm', 'yarn'].includes(expansion.packageManager)) return
  if (expansion.forwardedArgs[0] !== '--') return

  return `expands package script ${JSON.stringify(expansion.scriptName)} to ` +
    `${JSON.stringify(sanitizeString(expansion.effectiveCommand))}, including a literal extra "--" before the ` +
    'runner arguments. Append focused runner arguments directly after the script name.'
}

/**
 * Returns a bounded readable package-script expansion for a structured command.
 *
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @returns {object|undefined} package script expansion
 */
function getPackageScriptExpansion (command, repositoryRoot) {
  let argv = command.argv
  if (command.usesShell) {
    if (!isSingleStaticShellCommand(command.shellCommand || '')) return
    const words = tokenizeStaticShellCommand(command.shellCommand)
    const directIndex = consumeEnvironmentAssignments(words, 0, {})
    argv = words.slice(directIndex)
  }
  if (!Array.isArray(argv)) return
  let packageManager = path.basename(argv[0] || '').replace(/\.cmd$/i, '').toLowerCase()
  let runIndex = 1
  if (packageManager === 'corepack' && ['pnpm', 'yarn'].includes(argv[1])) {
    packageManager = argv[1]
    runIndex = 2
  }
  if (path.resolve(argv[0] || '') === path.resolve(process.execPath) && /yarn-[^/]+\.cjs$/.test(argv[1] || '')) {
    packageManager = 'yarn'
    runIndex = 2
  }
  if (!['npm', 'pnpm', 'yarn'].includes(packageManager)) return

  const invocation = argv[runIndex]
  const explicitRun = invocation === 'run' || (packageManager === 'npm' && invocation === 'run-script')
  const scriptIndex = explicitRun
    ? runIndex + 1
    : ['pnpm', 'yarn'].includes(packageManager) ||
      (packageManager === 'npm' && ['test', 't', 'tst', 'start', 'stop', 'restart'].includes(invocation))
        ? runIndex
        : -1
  const scriptName = packageManager === 'npm' && ['t', 'tst'].includes(argv[scriptIndex])
    ? 'test'
    : argv[scriptIndex]
  if (typeof scriptName !== 'string') return
  if (!explicitRun && PACKAGE_MANAGER_BUILTINS[packageManager].has(invocation) &&
    !(packageManager === 'npm' && ['test', 't', 'tst', 'start', 'stop', 'restart'].includes(invocation))) {
    return
  }

  const packageJsonSource = readRepositoryFile(path.join(command.cwd, 'package.json'), repositoryRoot)
  if (!packageJsonSource) return
  let packageJson
  try {
    packageJson = JSON.parse(packageJsonSource)
  } catch {
    return
  }
  const script = packageJson.scripts?.[scriptName]
  if (typeof script !== 'string' || script.length > MAX_CONFIG_BYTES) return

  let forwardedArgs = argv.slice(scriptIndex + 1)
  if (packageManager === 'npm' && forwardedArgs[0] === '--') forwardedArgs = forwardedArgs.slice(1)
  const lifecycle = [`pre${scriptName}`, `post${scriptName}`].flatMap(name => {
    const command = packageJson.scripts?.[name]
    return typeof command === 'string' && command.trim() ? [{ command, name }] : []
  })
  return {
    effectiveCommand: [script, ...forwardedArgs].join(' '),
    forwardedArgs,
    lifecycle,
    packageManager,
    script,
    scriptName,
  }
}

/**
 * @param {{ usesShell?: boolean, argv?: string[] }} command
 * @param {string} repositoryRoot
 */
function getRepositoryYarnError (command, repositoryRoot) {
  if (command.usesShell || path.basename(command.argv?.[0] || '') !== 'yarn') return

  const { releases, unsafeRelease } = getRepositoryYarnReleases(repositoryRoot)
  if (unsafeRelease) {
    return `references checked-in Yarn release ${unsafeRelease}, but it is a symlink or resolves outside the ` +
      'repository. Use a regular repository-contained release file or complete the repository package-manager ' +
      'setup before validation.'
  }
  if (releases.length > 0) {
    const release = path.posix.join('.yarn', 'releases', releases.at(-1))
    return `uses bare "yarn", but this repository pins ${release}. Use the structured command ` +
      `argv [process.execPath, "${release}", ...] so validation does not depend on an ambient Yarn shim.`
  }

  const packageJsonSource = readRepositoryFile(path.join(repositoryRoot, 'package.json'), repositoryRoot)
  if (!packageJsonSource) return
  try {
    const packageManager = JSON.parse(packageJsonSource).packageManager
    const match = /^yarn@(\d+)(?:\.|$)/.exec(packageManager || '')
    if (match && Number(match[1]) > 1) {
      return `uses bare "yarn", but package.json requires ${packageManager}. Use the repository-configured ` +
        '`yarnPath` or complete the matching package-manager setup before validation.'
    }
  } catch {}
}

/**
 * Finds bounded, regular, repository-contained Yarn release files.
 *
 * @param {string} repositoryRoot repository root
 * @returns {{releases: string[], unsafeRelease?: string}} release names and unsafe evidence
 */
function getRepositoryYarnReleases (repositoryRoot) {
  const directory = path.join(repositoryRoot, '.yarn', 'releases')
  const releases = []
  let unsafeRelease
  let handle
  try {
    const physicalRoot = fs.realpathSync(repositoryRoot)
    handle = fs.opendirSync(directory)
    for (let count = 0; count < 64; count++) {
      const entry = handle.readSync()
      if (!entry) break
      if (!/^yarn-[^/]+\.cjs$/.test(entry.name)) continue
      const filename = path.join(directory, entry.name)
      const stat = fs.lstatSync(filename)
      const physicalFile = fs.realpathSync(filename)
      const relative = path.relative(physicalRoot, physicalFile)
      const contained = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      if (!stat.isFile() || stat.isSymbolicLink() || !contained) {
        unsafeRelease ||= path.posix.join('.yarn', 'releases', entry.name)
        continue
      }
      releases.push(entry.name)
    }
  } catch {} finally {
    handle?.closeSync()
  }
  releases.sort()
  return { releases, unsafeRelease }
}

function readRepositoryFile (filename, repositoryRoot) {
  try {
    const entry = fs.lstatSync(filename)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CONFIG_BYTES) return

    const physicalRoot = fs.realpathSync(repositoryRoot)
    const physicalFilename = fs.realpathSync(filename)
    const relative = path.relative(physicalRoot, physicalFilename)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return

    return fs.readFileSync(physicalFilename, 'utf8')
  } catch {}
}

module.exports = {
  getCommandSuitabilityError,
  getPackageScriptDirectCommand,
  getPackageScriptExpansion,
  getShellDirectCommand,
}
