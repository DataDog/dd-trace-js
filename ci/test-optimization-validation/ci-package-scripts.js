'use strict'

const { parseLiteralEnvironmentPrefix } = require('./literal-environment')

const MAX_SCRIPT_EXPANSIONS = 16
const DYNAMIC_VALUE_PATTERN = /[$`\r\n]|%[^%\s]+%|![^!\s]+!/
const RESERVED_PACKAGE_MANAGER_COMMANDS = {
  pnpm: new Set([
    'add', 'audit', 'bin', 'c', 'config', 'create', 'deploy', 'dlx', 'env', 'exec', 'fetch', 'i', 'import', 'init',
    'install', 'link', 'list', 'ln', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'prune', 'publish', 'rebuild',
    'remove', 'rm', 'root', 'self-update', 'server', 'setup', 'store', 'uninstall', 'unlink', 'up', 'update', 'view',
    'why',
  ]),
  yarn: new Set([
    'add', 'audit', 'bin', 'cache', 'check', 'config', 'constraints', 'create', 'dedupe', 'dlx', 'exec', 'global',
    'help', 'import', 'info', 'init', 'install', 'link', 'list', 'node', 'npm', 'outdated', 'owner', 'pack', 'patch',
    'plugin', 'policies', 'publish', 'rebuild', 'remove', 'set', 'stage', 'tag', 'team', 'unlink', 'unplug', 'up',
    'upgrade', 'version', 'versions', 'why', 'workspace', 'workspaces',
  ]),
}

/**
 * Expands bounded local package-script references without executing them.
 *
 * @param {string} command selected CI command
 * @param {Record<string, string>} scripts package.json scripts
 * @returns {{error?: string, lifecycleScripts: string[], terminals: object[]}} expansion
 */
function expandLocalPackageScripts (command, scripts) {
  const state = { count: 0, lifecycleScripts: new Set() }
  const result = expandCommand(command, scripts || {}, [], new Set(), state)
  return {
    ...(result.error ? { error: result.error } : {}),
    lifecycleScripts: [...state.lifecycleScripts],
    terminals: result.terminals || [],
  }
}

function expandCommand (command, scripts, path, stack, state) {
  if (++state.count > MAX_SCRIPT_EXPANSIONS) {
    return { error: `local package-script expansion exceeded ${MAX_SCRIPT_EXPANSIONS} commands` }
  }
  const segments = splitLiteralAndChain(command)
  if (!segments) return { error: 'the command contains unsupported dynamic shell syntax' }

  const terminals = []
  for (const segment of segments) {
    if (hasStatefulShellSemantics(segment)) {
      return { error: 'the command contains unsupported stateful shell semantics' }
    }
    const invocation = getPackageScriptInvocation(segment)
    if (!invocation) {
      terminals.push({ command: segment, path: [...path, segment] })
      continue
    }
    if (typeof scripts[invocation.script] !== 'string') {
      return { error: `local package script ${invocation.script} is unavailable` }
    }
    if (stack.has(invocation.script)) {
      return { error: `local package-script cycle includes ${invocation.script}` }
    }
    const lifecycleNames = invocation.manager === 'npm' || invocation.manager === 'bun'
      ? [`pre${invocation.script}`, `post${invocation.script}`]
          .filter(name => typeof scripts[name] === 'string')
      : []
    for (const lifecycle of lifecycleNames) state.lifecycleScripts.add(lifecycle)

    for (const scriptName of [
      ...(lifecycleNames.includes(`pre${invocation.script}`) ? [`pre${invocation.script}`] : []),
      invocation.script,
      ...(lifecycleNames.includes(`post${invocation.script}`) ? [`post${invocation.script}`] : []),
    ]) {
      if (stack.has(scriptName)) return { error: `local package-script cycle includes ${scriptName}` }
      const nextStack = new Set(stack)
      nextStack.add(invocation.script)
      nextStack.add(scriptName)
      const scriptCommand = scriptName === invocation.script && invocation.arguments
        ? `${scripts[scriptName]} ${invocation.arguments}`
        : scripts[scriptName]
      const expanded = expandCommand(
        scriptCommand,
        scripts,
        [...path, segment],
        nextStack,
        state
      )
      if (expanded.error) return expanded
      terminals.push(...expanded.terminals)
    }
  }
  return { terminals }
}

/**
 * Splits only literal `&&` chains and rejects other shell control flow or expansion.
 *
 * @param {string} command command text
 * @returns {string[]|undefined} literal command segments
 */
function splitLiteralAndChain (command) {
  const source = String(command || '').trim()
  if (!source || DYNAMIC_VALUE_PATTERN.test(source)) return
  const segments = []
  let quote
  let start = 0

  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '\\') {
      index++
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '&' && source[index + 1] === '&') {
      const segment = source.slice(start, index).trim()
      if (!segment) return
      segments.push(segment)
      start = ++index + 1
      continue
    }
    if (';&|()'.includes(character)) return
  }
  if (quote) return
  const finalSegment = source.slice(start).trim()
  if (!finalSegment) return
  segments.push(finalSegment)
  return segments
}

function hasStatefulShellSemantics (command) {
  const prefix = parseLiteralEnvironmentPrefix(command)
  const executable = command.slice(prefix.length).trim()
  return !executable ||
    /^(?:cd|eval|exec|export|popd|pushd|set|source|unset)\b/.test(executable) ||
    /^\.(?:\s|$)/.test(executable)
}

function getPackageScriptInvocation (command) {
  const literalPrefix = parseLiteralEnvironmentPrefix(command)
  const source = command.slice(literalPrefix.length).trim()
    .replace(/^(?:c8|nyc)(?:\.cmd)?\s+/, '')
  const match = /^(bun|npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:pkg)?(?:\.cmd)?)\s+(?:(run|run-script)\s+)?([\w:-]+)(?:\s+(.+))?$/
    .exec(source)
  if (!match) return

  const manager = match[1].replace(/\.cmd$/i, '').replace(/^yarnpkg$/, 'yarn')
  if (manager === 'npm' && !match[2] && !['restart', 'start', 'stop', 'test'].includes(match[3])) return
  if (manager === 'bun' && match[2] !== 'run') return
  if (!match[2] && RESERVED_PACKAGE_MANAGER_COMMANDS[manager]?.has(match[3])) return
  const args = match[4]?.trim()
  const separatedArguments = args ? /^--(?:\s+(.+))?$/.exec(args) : undefined
  if (['npm', 'pnpm'].includes(manager) && args && !separatedArguments) return
  const scriptArguments = ['npm', 'pnpm'].includes(manager) ? separatedArguments?.[1]?.trim() : args
  if (scriptArguments && !splitLiteralAndChain(scriptArguments)) return
  return {
    ...(scriptArguments ? { arguments: scriptArguments } : {}),
    manager,
    script: match[3],
  }
}

module.exports = { expandLocalPackageScripts }
