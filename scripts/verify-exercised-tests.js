'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const { globSync } = require('glob')
const YAML = require('yaml')

const DEFAULT_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.nyc_output/**',
  '**/.junit-tmp/**',
  'vendor/dist/**',
]

const GLOB_CACHE_MAX = 2000
/** @type {Map<string, string[]>} */
const globCache = new Map()
let globCacheHits = 0
let globCacheMisses = 0

const COVERAGE_UPLOAD_ACTION_FILES = new Set([
  path.join('.github', 'actions', 'upload-coverage-artifact', 'action.yml'),
  path.join('.github', 'actions', 'upload-coverage-artifact', 'action.yaml'),
])
const COVERAGE_COLLECTORS = new Set([
  'integration-tests/coverage/run-suite.js',
  'scripts/c8-ci.js',
])
const COVERAGE_UPLOAD_ACTION_PATTERN = /^actions\/upload-artifact@/
const COVERAGE_UPLOAD_CONDITION =
  "github.actor != 'dependabot[bot]' && steps.check.outputs.has_coverage == 'true'"
const COVERAGE_REPORT_DIR_EXPRESSION = '$' + '{{ inputs.report-dir }}'
const COVERAGE_UPLOAD_PATHS = new Set([
  `${COVERAGE_REPORT_DIR_EXPRESSION}/**/lcov.info`,
  `${COVERAGE_REPORT_DIR_EXPRESSION}/**/coverage-final.json`,
])
const RETRY_ACTION_PATTERN = /^nick-fields\/retry@/
const SUCCESS_CONDITION = '\0success()'

/**
 * @typedef {{
 *   expression: string,
 *   scope: string
 * }} WorkflowCondition
 */

/**
 * @typedef {{
 *   tool: 'yarn'|'npm',
 *   script: string,
 *   explicit: boolean
 * }} ScriptInvocation
 */

/**
 * @typedef {ScriptInvocation & {
 *   env: Record<string, string|undefined>
 * }} ScriptInvocationWithEnvironment
 */

/**
 * @typedef {{
 *   run: string,
 *   env: Record<string, string|undefined>,
 *   conditions: WorkflowCondition[]
 * } | {
 *   uploadsCoverage: true,
 *   conditions: WorkflowCondition[]
 * } | {
 *   unsupportedLocalAction: string,
 *   conditions: WorkflowCondition[]
 * }} LocalActionEvent
 */

/**
 * @typedef {{
 *   workflowFile: string,
 *   jobId: string,
 *   matrixKey: string
 * } & LocalActionEvent} WorkflowEvent
 */

/**
 * @param {string} pattern
 * @param {{cwd: string, nodir: boolean, windowsPathsNoEscape: boolean, ignore?: string[]}} opts
 * @returns {string[]}
 */
function globSyncCached (pattern, opts) {
  const ignoreKey = Array.isArray(opts.ignore) ? opts.ignore.join('\n') : ''
  const key = `${opts.cwd}\0${pattern}\0${opts.nodir ? 1 : 0}\0${opts.windowsPathsNoEscape ? 1 : 0}\0${ignoreKey}`

  const cached = globCache.get(key)
  if (cached) {
    globCacheHits++
    // Basic LRU: refresh insertion order.
    globCache.delete(key)
    globCache.set(key, cached)
    return cached
  }

  globCacheMisses++
  const res = globSync(pattern, opts)

  globCache.set(key, res)
  if (globCache.size > GLOB_CACHE_MAX) {
    const first = globCache.keys().next().value
    if (first !== undefined) globCache.delete(first)
  }

  return res
}

/**
 * @param {string} s
 * @returns {string}
 */
function stripOuterQuotes (s) {
  if (s.length < 2) return s
  const first = s[0]
  const last = s[s.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Minimal shell-ish tokenizer for our package.json scripts. Handles single/double quotes.
 * @param {string} s
 * @returns {string[]}
 */
function shellSplit (s) {
  /** @type {string[]} */
  const out = []
  let cur = ''
  /** @type {'"'|"'"|null} */
  let quote = null

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]

    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }

      // Allow escaping within double quotes.
      if (quote === '"' && ch === '\\') {
        const next = s[i + 1]
        if (next) {
          cur += next
          i++
          continue
        }
      }

      cur += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur) out.push(cur)
      cur = ''
      continue
    }

    cur += ch
  }

  if (cur) out.push(cur)
  return out
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function splitRequiredShellCommands (line) {
  /** @type {string[]} */
  const commands = []
  /** @type {'"'|"'"|null} */
  let quote = null
  let command = ''

  for (let i = 0; i < line.length; i++) {
    const character = line[i]
    if (quote) {
      command += character
      if (quote === '"' && character === '\\' && i + 1 < line.length) {
        command += line[++i]
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      command += character
      continue
    }

    const next = line[i + 1]
    if (character === ';' || (character === '&' && next === '&') || (character === '|' && next !== '|')) {
      if (command.trim()) commands.push(command)
      command = ''
      if (character === '&') i++
      continue
    }
    command += character
  }

  if (command.trim()) commands.push(command)
  return commands
}

/**
 * @param {string} line
 * @returns {string|undefined}
 */
function getHeredocDelimiter (line) {
  const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
  return match?.[2]
}

/**
 * Removes shell branches whose commands are not guaranteed to execute when the step succeeds.
 * @param {string} command
 * @returns {string[]}
 */
function getAnalyzableShellCommands (command) {
  /** @type {{ text: string, optional: boolean }[]} */
  const lines = []
  /** @type {'"'|"'"|null} */
  let quote = null
  let line = ''
  let optional = false
  let comment = false
  let wordStart = true
  let heredocDelimiter

  for (let i = 0; i < command.length; i++) {
    const character = command[i]

    if (heredocDelimiter !== undefined) {
      if (character !== '\n') {
        line += character
        continue
      }
      if (line.trim() === heredocDelimiter) heredocDelimiter = undefined
      line = ''
      wordStart = true
      continue
    }

    if (comment) {
      if (character !== '\n') continue
      lines.push({ text: line, optional })
      heredocDelimiter = getHeredocDelimiter(line)
      line = ''
      optional = false
      comment = false
      wordStart = true
      continue
    }

    if (quote) {
      line += character
      if (quote === '"' && character === '\\' && i + 1 < command.length) {
        line += command[++i]
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      line += character
      wordStart = false
      continue
    }

    if (character === '#' && wordStart) {
      comment = true
      continue
    }

    if (character === '|' && command[i + 1] === '|') {
      optional = true
      line += '||'
      i++
      wordStart = true
      continue
    }

    if (character === '&' && command[i + 1] === '&') {
      line += '&&'
      i++
      wordStart = true
      continue
    }

    if (character === '&' && command[i + 1] !== '&') {
      optional = true
    }

    if (character === '\n') {
      lines.push({ text: line, optional })
      heredocDelimiter = getHeredocDelimiter(line)
      line = ''
      optional = false
      wordStart = true
      continue
    }

    line += character
    wordStart = /\s|[;&|()]/.test(character)
  }
  if (heredocDelimiter === undefined) lines.push({ text: line, optional })

  /** @type {{ text: string, optional: boolean }[]} */
  const logicalLines = []
  let pending
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i]
    pending = pending === undefined
      ? entry
      : { text: `${pending.text}\n${entry.text}`, optional: pending.optional || entry.optional }

    const next = lines[i + 1]
    const continues = /(?:\\|&&|\|\||\|)\s*$/.test(pending.text) ||
      (next !== undefined && /^(?:&&|\|\||\|)/.test(next.text.trim()))
    if (!continues) {
      logicalLines.push(pending)
      pending = undefined
    }
  }

  /** @type {string[]} */
  const analyzable = []
  let controlDepth = 0
  let stopped = false
  for (const entry of logicalLines) {
    const trimmed = entry.text.trim()
    if (!trimmed) continue

    if (/^(?:fi|esac|done)\b|^\}/.test(trimmed)) {
      if (controlDepth > 0) controlDepth--
      continue
    }
    if (controlDepth > 0) {
      if (
        /^(?:if|case|for|select|until|while)\b/.test(trimmed) ||
        /^(?:function\s+[A-Za-z_]|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))/.test(trimmed)
      ) {
        controlDepth++
      }
      continue
    }
    if (
      /^(?:if|case|for|select|until|while)\b/.test(trimmed) ||
      /^(?:function\s+[A-Za-z_]|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))/.test(trimmed)
    ) {
      controlDepth++
      continue
    }
    if (entry.optional) continue

    for (const requiredCommand of splitRequiredShellCommands(entry.text)) {
      if (/^\s*(?:exit|return)(?:\s|$)/.test(requiredCommand)) {
        stopped = true
        break
      }
      analyzable.push(requiredCommand)
      if (/^\s*exec(?:\s|$)/.test(requiredCommand)) {
        stopped = true
        break
      }
    }
    if (stopped) break
  }

  return analyzable
}

/**
 * @param {string} command
 * @returns {string}
 */
function getAnalyzableShell (command) {
  return getAnalyzableShellCommands(command).join('\n')
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeFileGlob (token) {
  // We only care about globs that can match paths in the repo.
  if (!token.includes('/') && !token.startsWith('**')) return false

  // Avoid env assignments like SERVICES=*.
  if (!token.includes('/') && token.includes('=')) return false

  // Typical glob metacharacters and brace expansion.
  return /[*?[\]{}()]/.test(token)
}

/**
 * Converts some shell-specific patterns in scripts into a conservative file glob.
 * @param {string} raw
 * @param {{ preserveEnv?: boolean }} [opts]
 * @returns {string}
 */
function normalizeScriptGlob (raw, opts = {}) {
  const preserveEnv = Boolean(opts.preserveEnv)
  let p = stripOuterQuotes(raw.trim())

  // Strip quotes that are meant for bash extglob options inside double-quoted strings.
  p = p.replaceAll('\'', '')

  // Convert bash extglob + command substitution patterns used in this repo into plain env vars.
  // Example: @($(echo $PLUGINS)) -> $PLUGINS
  // Example: @($(echo ${SPEC:-'*'})) -> ${SPEC:-*}
  p = p.replaceAll(/@\(\$\(\s*echo\s+([^)]+?)\s*\)\)/g, '$1')

  // For global analysis we treat env vars as wildcards, but when evaluating a specific CI run
  // we need to preserve them so they can be expanded with the provided env.
  if (preserveEnv) {
    // Unwrap extglob constructs that wrap a single env var so the env-aware expansion
    // below still sees the variable. Without this, every glob of the form
    // `@(${PLUGINS}).spec.js` would degrade to `*.spec.js` and a single-plugin CI job
    // (e.g. `PLUGINS=bluebird`) would falsely appear to exercise every spec in the
    // same directory.
    p = p.replaceAll(/@\((\$\{[^}]+\})\)/g, '$1')
    p = p.replaceAll(/@\((\$[A-Za-z_][A-Za-z0-9_]*)\)/g, '$1')
  } else {
    // Replace shell variable expansion with a wildcard for our analysis.
    // Examples:
    // - ${PLUGINS} -> *
    // - ${SPEC:-*} -> *
    // - $PLUGINS -> *
    p = p.replaceAll(/\$\{[^}]+\}/g, '*')
    p = p.replaceAll(/\$[A-Za-z_][A-Za-z0-9_]*/g, '*')
  }

  // Replace remaining bash extglob constructs with a conservative wildcard to avoid
  // parsing issues. Examples: @(...), +(...), ?(...), !(...).
  p = p.replaceAll(/[@+?!]\([^)]*\)/g, '*')

  // Normalize leading './' which appears sometimes in scripts.
  if (p.startsWith('./')) p = p.slice(2)

  return p
}

/**
 * @param {string} s
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function expandEnvInString (s, env) {
  // ${NAME} / ${NAME:-default}
  s = s.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}/g, (_m, name, defaultValue) => {
    return formatEnvValue(name, env[name], defaultValue)
  })

  // $NAME
  s = s.replaceAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => {
    return formatEnvValue(name, env[name])
  })

  return s
}

/**
 * @param {string} name
 * @param {string|undefined} value
 * @param {string|undefined} [defaultValue]
 * @returns {string}
 */
function formatEnvValue (name, value, defaultValue) {
  const val = typeof value === 'string' && value.length ? value : ''
  if (!val) {
    if (defaultValue !== undefined) return stripOuterQuotes(defaultValue)
    return `__UNRESOLVED_${name}__`
  }
  if (val.includes('${{')) return `__UNRESOLVED_${name}__`

  if (name === 'PLUGINS') {
    const items = val.split(/[,\s|]+/g).map(x => x.trim()).filter(Boolean)
    if (items.length > 1) return `{${items.join(',')}}`
    return items[0] || `__UNRESOLVED_${name}__`
  }

  return val
}

/**
 * @param {string} maybe
 * @returns {string|null}
 */
function unwrapLiteralEnvValue (maybe) {
  const s = String(maybe ?? '').trim()
  if (!s) return null
  if (s.includes('${{')) return null
  return stripOuterQuotes(s)
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitPlugins (value) {
  const raw = unwrapLiteralEnvValue(value)
  if (!raw) return []
  return raw
    .split(/[,\s|]+/g)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject (v) {
  return Boolean(v) && v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Parse `NAME=value` assignments in front of a command (e.g. `PLUGINS=foo SERVICES=bar npm run ...`).
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
function parseInlineAssignments (prefix) {
  /** @type {Record<string, string>} */
  const out = {}
  const tokens = shellSplit(prefix)
  let index = 0

  while (isShellAssignment(tokens[index])) {
    const token = tokens[index++]
    const equalsIndex = token.indexOf('=')
    out[token.slice(0, equalsIndex)] = stripOuterQuotes(token.slice(equalsIndex + 1))
  }
  while (tokens[index] === 'command' || tokens[index] === 'exec') index++
  if (tokens[index] === 'env') {
    index++
    while (isShellAssignment(tokens[index])) {
      const token = tokens[index++]
      const equalsIndex = token.indexOf('=')
      out[token.slice(0, equalsIndex)] = stripOuterQuotes(token.slice(equalsIndex + 1))
    }
  }
  return out
}

/**
 * Find `**` occurrences in a script string that are NOT inside quotes.
 *
 * POSIX sh (which is what `npm run`/`yarn run` invokes) does NOT support globstar, so an
 * unquoted `**` collapses to `*` (single directory level). For recursive glob matching to
 * reach mocha/glob intact, the pattern must be quoted so the shell passes it through as a
 * literal string. This analyzer cannot rely on `globSync` alone for the check because it
 * expands `**` recursively regardless of quoting — hiding the bug that the shell actually
 * breaks unquoted patterns.
 *
 * @param {string} script
 * @returns {{ column: number, context: string }[]}
 */
function findUnquotedGlobstar (script) {
  /** @type {{ column: number, context: string }[]} */
  const out = []
  /** @type {'"'|"'"|null} */
  let quote = null

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]

    if (quote) {
      // In double-quoted strings, `\` escapes the next character.
      if (quote === '"' && ch === '\\' && i + 1 < script.length) {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (ch === '*' && script[i + 1] === '*') {
      // Capture a short context window so the error message points to the offending token.
      const start = Math.max(0, i - 20)
      const end = Math.min(script.length, i + 25)
      out.push({ column: i, context: script.slice(start, end) })
      // Skip the second `*` to avoid double-reporting.
      i++
    }
  }

  return out
}

/**
 * Extract `export NAME=value` assignments from a multi-line `run:` string.
 * @param {string} run
 * @returns {Record<string, string>}
 */
function parseExportAssignments (run) {
  /** @type {Record<string, string>} */
  const out = {}
  const lines = String(run).split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/)
    if (!m) continue
    out[m[1]] = stripOuterQuotes(m[2].trim())
  }
  return out
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function findTestFiles (repoRoot) {
  const commonGlobOpts = { cwd: repoRoot, nodir: true, windowsPathsNoEscape: true, ignore: DEFAULT_IGNORE_GLOBS }

  // Collect every test-file naming convention used in the repo so an unrun spec
  // can never slip through untracked. Kept deliberately wide (js/mjs/cjs) even
  // where no file currently uses an extension, so a future one is caught.
  const files = globSyncCached('**/*.@(spec|test).@(js|mjs|cjs)', commonGlobOpts)

  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string>} scripts
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ globs: string[], matchedFiles: Set<string> }}
 */
function expandScriptGlobs (repoRoot, scripts, env = {}) {
  const ignore = DEFAULT_IGNORE_GLOBS

  /** @type {string[]} */
  const allGlobs = []
  const matchedFiles = new Set()

  const scriptNames = Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))
  for (const scriptName of scriptNames) {
    const script = scripts[scriptName]
    if (typeof script !== 'string') continue

    const tokens = shellSplit(getAnalyzableShell(script))
    for (const token of tokens) {
      if (!looksLikeFileGlob(token)) continue

      const normalized = expandEnvInString(normalizeScriptGlob(token), env)
      allGlobs.push(normalized)

      let expanded
      try {
        expanded = globSyncCached(normalized, { cwd: repoRoot, nodir: true, windowsPathsNoEscape: true, ignore })
      } catch {
        // If a pattern can't be parsed by glob, skip expanding it. It still counts as an extracted glob.
        continue
      }

      for (const file of expanded) {
        matchedFiles.add(file)
      }
    }
  }

  return { globs: allGlobs, matchedFiles }
}

/**
 * @param {string|undefined} token
 * @returns {boolean}
 */
function isShellAssignment (token) {
  if (token === undefined) return false
  const equalsIndex = token.indexOf('=')
  return equalsIndex > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, equalsIndex))
}

/**
 * @param {string[]} tokens
 * @returns {number}
 */
function getExecutableTokenIndex (tokens) {
  let index = 0
  while (isShellAssignment(tokens[index])) index++

  while (tokens[index] === 'command' || tokens[index] === 'exec') index++
  if (tokens[index] === 'env') {
    index++
    while (isShellAssignment(tokens[index])) index++
  }
  return index
}

/**
 * Find `yarn run <script>` / `npm run <script>` and `yarn <script>` (only when it looks like a script)
 * in a `run:` block.
 * @param {string} run
 * @param {Set<string>} knownScripts
 * @returns {ScriptInvocation[]}
 */
function extractScriptInvocations (run, knownScripts) {
  /** @type {ScriptInvocation[]} */
  const out = []

  for (const command of getAnalyzableShellCommands(String(run))) {
    const tokens = shellSplit(command)
    const i = getExecutableTokenIndex(tokens)
    const t = tokens[i]

    if (t === 'yarn') {
      let j = i + 1
      const isExplicitRun = tokens[j] === 'run'
      if (isExplicitRun) j++
      const script = tokens[j]
      if (!script || !/^[A-Za-z0-9:_-]+$/.test(script)) continue

      // `yarn run <name>` is unambiguously a package script.
      if (isExplicitRun) {
        out.push({ tool: 'yarn', script, explicit: true })
        continue
      }

      // `yarn <name>` is ambiguous (could be built-in like `yarn config`).
      // Only treat it as a script when it is known (or looks like a script name by convention).
      if (knownScripts.has(script) || script.includes(':')) {
        out.push({ tool: 'yarn', script, explicit: false })
      }
      continue
    }

    if (t === 'npm' && tokens[i + 1] === 'run') {
      const script = tokens[i + 2]
      if (script && /^[A-Za-z0-9:_-]+$/.test(script)) {
        out.push({ tool: 'npm', script, explicit: true })
      }
      continue
    }

    // `node scripts/c8-ci.js <script>` runs an in-process suite under V8 coverage; its first
    // argument names the package script whose glob actually selects the specs. Treat it like
    // `npm run <script>` so the chain from a `:ci` script to its underlying glob stays traceable.
    if (t === 'node' && /(^|\/)scripts\/c8-ci\.js$/.test(String(tokens[i + 1] ?? ''))) {
      const script = tokens[i + 2]
      if (script && /^[A-Za-z0-9:_-]+$/.test(script)) {
        out.push({ tool: 'npm', script, explicit: true })
      }
    }
  }

  return out
}

/**
 * @param {string} run
 * @param {Set<string>} knownScripts
 * @param {Record<string, string|undefined>} environment
 * @returns {ScriptInvocationWithEnvironment[]}
 */
function extractScriptInvocationsWithEnvironment (run, knownScripts, environment) {
  /** @type {ScriptInvocationWithEnvironment[]} */
  const out = []
  const currentEnvironment = { ...environment }

  for (const command of getAnalyzableShellCommands(run)) {
    const exports = parseExportAssignments(command)
    for (const [name, value] of Object.entries(exports)) currentEnvironment[name] = value

    const invocations = extractScriptInvocations(command, knownScripts)
    if (invocations.length === 0) continue

    const commandEnvironment = { ...currentEnvironment, ...parseInlineAssignments(command) }
    for (const invocation of invocations) {
      out.push({ ...invocation, env: commandEnvironment })
    }
  }

  return out
}

/**
 * @param {string} name
 * @param {Record<string, string|undefined>} environment
 * @returns {string}
 */
function getScriptEnvironmentKey (name, environment) {
  const values = Object.keys(environment)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(key => `${key}=${JSON.stringify(environment[key])}`)
    .join(',')
  return `${name}\0${values}`
}

/**
 * Expand a script and any nested `npm run`/`yarn <script>` calls into matched files.
 * @param {string} repoRoot
 * @param {Record<string, string>} scripts
 * @param {Set<string>} knownScripts
 * @param {string} scriptName
 * @param {Record<string, string|undefined>} env
 * @returns {{ files: Set<string>, globs: string[], visited: string[] }}
 */
function expandInvokedScript (repoRoot, scripts, knownScripts, scriptName, env) {
  /** @type {string[]} */
  const visited = []
  /** @type {string[]} */
  const allGlobs = []
  const files = new Set()

  /** @type {{ name: string, env: Record<string, string|undefined> }[]} */
  const queue = [{ name: scriptName, env }]
  const seen = new Set()

  const ignore = DEFAULT_IGNORE_GLOBS

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const entry = queue[queueIndex]
    const { name, env: scriptEnvironment } = entry
    const environmentKey = getScriptEnvironmentKey(name, scriptEnvironment)
    if (seen.has(environmentKey)) continue
    seen.add(environmentKey)
    visited.push(name)

    const cmd = scripts[name]
    if (typeof cmd !== 'string') continue

    // Extract and expand glob tokens from the script command.
    const tokens = shellSplit(getAnalyzableShell(cmd))
    for (const token of tokens) {
      if (!looksLikeFileGlob(token)) continue
      const normalized = expandEnvInString(normalizeScriptGlob(token, { preserveEnv: true }), scriptEnvironment)
      allGlobs.push(normalized)
      let expanded
      try {
        expanded = globSyncCached(normalized, { cwd: repoRoot, nodir: true, windowsPathsNoEscape: true, ignore })
      } catch {
        continue
      }
      for (const f of expanded) files.add(f)
    }

    // Follow nested script invocations.
    const nested = extractScriptInvocationsWithEnvironment(cmd, knownScripts, scriptEnvironment)
    for (const invocation of nested) queue.push({ name: invocation.script, env: invocation.env })
  }

  return { files, globs: allGlobs, visited }
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function findWorkflowFiles (repoRoot) {
  const files = globSyncCached('.github/workflows/*.{yml,yaml}', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
  })
  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/**
 * @param {string} repoRoot
 * @returns {unknown|null}
 */
/** @type {Map<string, unknown|null>} */
const yamlFileCache = new Map()

function parseYamlFile (repoRoot, file) {
  const cached = yamlFileCache.get(file)
  if (cached !== undefined) return cached

  /** @type {unknown|null} */
  let doc
  try {
    const raw = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    doc = YAML.parse(raw)
  } catch {
    doc = null
  }

  yamlFileCache.set(file, doc)
  return doc
}

/** @type {Map<string, string|null>} */
const localActionFileCache = new Map()

/**
 * @param {string} repoRoot
 * @param {string} uses
 * @returns {string|null}
 */
function resolveLocalActionFile (repoRoot, uses) {
  if (typeof uses !== 'string') return null
  if (!uses.startsWith('./')) return null

  const cached = localActionFileCache.get(uses)
  if (cached !== undefined) return cached

  const rel = uses.replace(/^\.\//, '')
  const dir = path.join(repoRoot, rel)
  const yml = path.join(dir, 'action.yml')
  const yamlFile = path.join(dir, 'action.yaml')

  let resolved = null
  if (fs.existsSync(yml)) resolved = path.join(rel, 'action.yml')
  else if (fs.existsSync(yamlFile)) resolved = path.join(rel, 'action.yaml')

  localActionFileCache.set(uses, resolved)
  return resolved
}

/**
 * @param {unknown} step
 * @returns {step is { run: string, env?: Record<string, unknown>, id?: unknown, if?: unknown }}
 */
function isRunStep (step) {
  return isPlainObject(step) && typeof step.run === 'string'
}

/**
 * @param {unknown} step
 * @returns {step is {
 *   uses: string,
 *   env?: Record<string, unknown>,
 *   if?: unknown,
 *   with?: Record<string, unknown>
 * }}
 */
function isUsesStep (step) {
  return isPlainObject(step) && typeof step.uses === 'string'
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {unknown} additional
 * @returns {Record<string, string|undefined>}
 */
function mergeEnvironment (env, additional) {
  const merged = { ...env }
  if (isPlainObject(additional)) {
    for (const [name, value] of Object.entries(additional)) {
      merged[name] = typeof value === 'string' ? value : String(value)
    }
  }
  return merged
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function normalizeStepCondition (value) {
  if (value === undefined) return

  let condition = String(value).trim()
  if (condition.startsWith('${{') && condition.endsWith('}}')) {
    condition = condition.slice(3, -2).trim()
  }
  if (condition === '' || condition === 'false' || condition === 'null' || condition === '0' || condition === '-0') {
    return 'false'
  }
  return condition
}

/**
 * @param {string} condition
 * @returns {boolean}
 */
function hasStatusCheckFunction (condition) {
  let expression = ''
  let quoted = false

  for (let i = 0; i < condition.length; i++) {
    const character = condition[i]
    if (quoted) {
      if (character === "'" && condition[i + 1] === "'") {
        i++
      } else if (character === "'") {
        quoted = false
      }
      continue
    }
    if (character === "'") {
      quoted = true
      continue
    }
    expression += character
  }

  return /\b(?:always|cancelled|failure|success)\s*\(/.test(expression)
}

/**
 * @param {WorkflowCondition[]} conditions
 * @param {string} expression
 * @param {string} scope
 * @returns {WorkflowCondition[]}
 */
function appendCondition (conditions, expression, scope) {
  if (conditions.some(condition => condition.expression === expression && condition.scope === scope)) {
    return conditions
  }
  return [...conditions, { expression, scope }]
}

/**
 * @param {WorkflowCondition[]} conditions
 * @param {unknown} value
 * @param {string} scope
 * @returns {WorkflowCondition[]}
 */
function appendStepCondition (conditions, value, scope) {
  const condition = normalizeStepCondition(value)
  if (condition === 'false') return appendCondition(conditions, condition, '')
  if (condition === 'always()') return conditions
  if (condition === undefined || condition === 'true' || condition === 'success()') {
    return appendCondition(conditions, 'success()', SUCCESS_CONDITION)
  }

  let next = conditions
  if (!hasStatusCheckFunction(condition)) {
    next = appendCondition(next, 'success()', SUCCESS_CONDITION)
  }
  return appendCondition(next, condition, scope)
}

/**
 * @param {WorkflowCondition[]} conditions
 * @param {unknown} value
 * @param {string} scope
 * @returns {WorkflowCondition[]}
 */
function appendJobCondition (conditions, value, scope) {
  const condition = normalizeStepCondition(value)
  if (condition === undefined || condition === 'true' || condition === 'always()' || condition === 'success()') {
    return conditions
  }
  return appendCondition(conditions, condition, condition === 'false' ? '' : scope)
}

/**
 * @param {WorkflowCondition[]} conditions
 * @returns {boolean}
 */
function conditionsCanRun (conditions) {
  return !conditions.some(condition => condition.expression === 'false')
}

/**
 * @param {unknown} value
 * @param {string} scope
 * @param {number} stepIndex
 * @returns {string}
 */
function getStepConditionScope (value, scope, stepIndex) {
  const condition = normalizeStepCondition(value)
  return condition?.includes('env.') ? `${scope}:step:${stepIndex}` : scope
}

/**
 * @param {string} repoRoot
 * @param {string} actionFile
 * @returns {boolean}
 */
function isCoverageUploadAction (repoRoot, actionFile) {
  const doc = parseYamlFile(repoRoot, actionFile)
  if (!isPlainObject(doc) || !isPlainObject(doc.runs) || doc.runs.using !== 'composite') return false

  const steps = Array.isArray(doc.runs.steps) ? doc.runs.steps : []
  let hasCoverageCheck = false
  for (const step of steps) {
    if (!isRunStep(step) || step.id !== 'check') continue
    const command = getAnalyzableShell(step.run)
    if (command.includes('has_coverage=') && command.includes('GITHUB_OUTPUT')) {
      hasCoverageCheck = true
      break
    }
  }
  for (const step of steps) {
    if (!isUsesStep(step) || !COVERAGE_UPLOAD_ACTION_PATTERN.test(step.uses)) continue

    const condition = normalizeStepCondition(step.if)
    if (
      condition !== undefined &&
      condition !== 'always()' &&
      condition !== 'true' &&
      condition !== COVERAGE_UPLOAD_CONDITION
    ) {
      continue
    }
    if (condition === COVERAGE_UPLOAD_CONDITION && !hasCoverageCheck) continue

    const uploadPaths = isPlainObject(step.with) && typeof step.with.path === 'string' ? step.with.path : ''
    const pathSet = new Set(uploadPaths.split('\n').map(uploadPath => uploadPath.trim()).filter(Boolean))
    if ([...COVERAGE_UPLOAD_PATHS].every(uploadPath => pathSet.has(uploadPath))) return true
  }
  return false
}

/**
 * @param {string} repoRoot
 * @param {{ uses: string, with?: Record<string, unknown> }} step
 * @param {Record<string, string|undefined>} env
 * @param {WorkflowCondition[]} conditions
 * @param {Set<string>} visiting
 * @param {string} scope
 * @returns {LocalActionEvent[]}
 */
function expandUsesStepEvents (repoRoot, step, env, conditions, visiting, scope) {
  const actionFile = resolveLocalActionFile(repoRoot, step.uses)
  if (actionFile) {
    if (COVERAGE_UPLOAD_ACTION_FILES.has(actionFile)) {
      return isCoverageUploadAction(repoRoot, actionFile) ? [{ uploadsCoverage: true, conditions }] : []
    }
    return expandLocalCompositeActionEvents(repoRoot, actionFile, env, conditions, visiting, scope)
  }

  if (RETRY_ACTION_PATTERN.test(step.uses)) {
    const command = isPlainObject(step.with) && typeof step.with.command === 'string'
      ? step.with.command
      : undefined
    if (command !== undefined) {
      return [{ run: command, env, conditions }]
    }
  }

  return []
}

/**
 * @param {string} repoRoot
 * @param {string} actionFile
 * @param {Record<string, string|undefined>} env
 * @param {WorkflowCondition[]} conditions
 * @param {Set<string>} visiting
 * @param {string} scope
 * @returns {LocalActionEvent[]}
 */
function expandLocalCompositeActionEvents (repoRoot, actionFile, env, conditions, visiting, scope) {
  if (visiting.has(actionFile)) return []

  const doc = parseYamlFile(repoRoot, actionFile)
  if (!isPlainObject(doc)) return [{ unsupportedLocalAction: actionFile, conditions }]

  const runs = doc.runs
  if (!isPlainObject(runs)) return [{ unsupportedLocalAction: actionFile, conditions }]
  if (runs.using !== 'composite') return [{ unsupportedLocalAction: actionFile, conditions }]
  const steps = Array.isArray(runs.steps) ? runs.steps : []
  visiting.add(actionFile)

  /** @type {LocalActionEvent[]} */
  const out = []

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const s = steps[stepIndex]
    if (!isPlainObject(s)) continue
    const stepEnv = mergeEnvironment(env, s.env)
    const conditionScope = getStepConditionScope(s.if, scope, stepIndex)
    const stepConditions = appendStepCondition(conditions, s.if, conditionScope)
    if (!conditionsCanRun(stepConditions)) continue

    if (isRunStep(s)) {
      out.push({ run: s.run, env: stepEnv, conditions: stepConditions })
      continue
    }

    if (isUsesStep(s)) {
      const nestedScope = `${scope}>${actionFile}:${stepIndex}`
      const nested = expandUsesStepEvents(repoRoot, s, stepEnv, stepConditions, visiting, nestedScope)
      for (const n of nested) out.push(n)
    }
  }

  visiting.delete(actionFile)
  return out
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function invokesCoverageCollector (command) {
  const tokens = shellSplit(getAnalyzableShell(command))
  for (const token of tokens) {
    const normalized = token.startsWith('./') ? token.slice(2) : token
    if (COVERAGE_COLLECTORS.has(normalized)) return true
  }
  return false
}

/**
 * @param {Record<string, string>} scripts
 * @param {Set<string>} knownScripts
 * @returns {Set<string>}
 */
function findCoverageScripts (scripts, knownScripts) {
  const coverageScripts = new Set()
  let foundCoverage

  do {
    foundCoverage = false
    for (const [name, command] of Object.entries(scripts)) {
      if (coverageScripts.has(name)) continue

      if (
        invokesCoverageCollector(command) ||
        extractScriptInvocations(command, knownScripts).some(invocation => coverageScripts.has(invocation.script))
      ) {
        coverageScripts.add(name)
        foundCoverage = true
      }
    }
  } while (foundCoverage)

  return coverageScripts
}

/**
 * @param {string} command
 * @param {Set<string>} knownScripts
 * @param {Set<string>} coverageScripts
 * @returns {boolean}
 */
function commandProducesCoverage (command, knownScripts, coverageScripts) {
  if (invokesCoverageCollector(command)) return true

  return extractScriptInvocations(command, knownScripts)
    .some(invocation => coverageScripts.has(invocation.script))
}

/**
 * @param {WorkflowCondition[]} uploadConditions
 * @param {WorkflowCondition[]} producerConditions
 * @returns {boolean}
 */
function uploadCoversProducer (uploadConditions, producerConditions) {
  // Fail closed on conditions whose implication would require evaluating the full Actions expression language.
  for (const condition of uploadConditions) {
    if (!producerConditions.some(producerCondition => (
      producerCondition.expression === condition.expression && producerCondition.scope === condition.scope
    ))) {
      return false
    }
  }
  return true
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyMatrixValue (value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * @param {Record<string, unknown>} values
 * @param {Record<string, unknown>} pattern
 * @returns {boolean}
 */
function matrixValuesMatch (values, pattern) {
  for (const [name, value] of Object.entries(pattern)) {
    if (!isDeepStrictEqual(values[name], value)) return false
  }
  return true
}

/**
 * Returns the matrix jobs produced by scalar arrays, include, and exclude.
 * @param {Record<string, unknown>} matrix
 * @returns {Record<string, unknown>[]}
 */
function getMatrixCombinations (matrix) {
  const keys = Object.keys(matrix).filter(key => key !== 'include' && key !== 'exclude' && Array.isArray(matrix[key]))

  /** @type {Record<string, unknown>[]} */
  let combinations = [{}]
  for (const key of keys) {
    const values = /** @type {unknown[]} */ (matrix[key])
    /** @type {Record<string, unknown>[]} */
    const next = []
    for (const combo of combinations) {
      for (const val of values) {
        next.push({ ...combo, [key]: val })
      }
    }
    combinations = next
  }

  const exclude = Array.isArray(matrix.exclude)
    ? matrix.exclude.filter(isPlainObject)
    : []
  if (exclude.length > 0) {
    combinations = combinations.filter(combination => (
      !exclude.some(valuesToExclude => matrixValuesMatch(combination, valuesToExclude))
    ))
  }

  const include = Array.isArray(matrix.include)
    ? matrix.include.filter(isPlainObject)
    : []
  if (keys.length === 0) {
    combinations = include.length > 0 ? include : [{}]
  } else {
    const keySet = new Set(keys)
    const originalCombinations = combinations.map(values => ({ values, original: values, canInclude: true }))
    for (const valuesToInclude of include) {
      let matched = false
      for (const combination of originalCombinations) {
        if (!combination.canInclude) continue

        let canMerge = true
        for (const [name, value] of Object.entries(valuesToInclude)) {
          if (keySet.has(name) && !isDeepStrictEqual(combination.original[name], value)) {
            canMerge = false
            break
          }
        }
        if (!canMerge) continue

        combination.values = { ...combination.values, ...valuesToInclude }
        matched = true
      }
      if (!matched) originalCombinations.push({ values: valuesToInclude, original: {}, canInclude: false })
    }
    combinations = originalCombinations.map(combination => combination.values)
  }

  const seen = new Set()
  return combinations.filter(combination => {
    const key = getMatrixKey(combination)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
function getMatrixKey (values) {
  return Object.keys(values)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(name => `${name}=${JSON.stringify(values[name])}`)
    .join(',')
}

/**
 * @template {Record<string, unknown>} Values
 * @param {Values} values
 * @param {Record<string, unknown>} matrixValues
 * @returns {Values}
 */
function expandMatrixExpressionsInRecord (values, matrixValues) {
  /** @type {Record<string, unknown>} */
  const expanded = {}
  for (const [name, value] of Object.entries(values)) {
    expanded[name] = typeof value === 'string' ? expandMatrixExpressions(value, matrixValues) : value
  }
  return /** @type {Values} */ (expanded)
}

/**
 * Expands `${{ matrix.X }}` expressions in a string using the given matrix values.
 * @param {string} s
 * @param {Record<string, unknown>} matrixValues
 * @returns {string}
 */
function expandMatrixExpressions (s, matrixValues) {
  return s.replaceAll(/\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_m, pathExpression) => {
    const names = String(pathExpression).split('.')
    /** @type {unknown} */
    let value = matrixValues
    for (const name of names) {
      if (!isPlainObject(value) || !Object.hasOwn(value, name)) return _m
      value = value[name]
    }
    return stringifyMatrixValue(value)
  })
}

/**
 * @param {string} repoRoot
 * @returns {WorkflowEvent[]}
 */
function collectWorkflowEvents (repoRoot) {
  /** @type {WorkflowEvent[]} */
  const out = []

  const files = findWorkflowFiles(repoRoot)
  for (const wf of files) {
    const doc = parseYamlFile(repoRoot, wf)
    if (!isPlainObject(doc)) continue

    const topEnv = isPlainObject(doc.env) ? doc.env : {}
    const jobs = isPlainObject(doc.jobs) ? doc.jobs : {}

    for (const [jobId, jobVal] of Object.entries(jobs)) {
      const job = isPlainObject(jobVal) ? jobVal : {}
      const jobEnv = isPlainObject(job.env) ? job.env : {}
      const steps = Array.isArray(job.steps) ? job.steps : []

      const matrixData = isPlainObject(job.strategy) && isPlainObject(job.strategy.matrix)
        ? /** @type {Record<string, unknown>} */ (job.strategy.matrix)
        : {}
      const matrixCombinations = getMatrixCombinations(matrixData)

      const jobEnvironment = mergeEnvironment(mergeEnvironment({}, topEnv), jobEnv)
      for (const combination of matrixCombinations) {
        const matrixKey = getMatrixKey(combination)
        const jobScope = `${wf}#${jobId}[${matrixKey}]`
        const jobConditions = appendJobCondition([], job.if, jobScope)
        if (!conditionsCanRun(jobConditions)) continue

        const env = expandMatrixExpressionsInRecord(jobEnvironment, combination)
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
          const stepVal = steps[stepIndex]
          const step = isPlainObject(stepVal) ? stepVal : {}
          const stepEnv = expandMatrixExpressionsInRecord(mergeEnvironment(env, step.env), combination)
          const conditionScope = getStepConditionScope(step.if, jobScope, stepIndex)
          const conditions = appendStepCondition(jobConditions, step.if, conditionScope)
          if (!conditionsCanRun(conditions)) continue

          if (typeof step.run === 'string') {
            const run = expandMatrixExpressions(step.run, combination)
            out.push({
              workflowFile: wf,
              jobId,
              matrixKey,
              run,
              env: stepEnv,
              conditions,
            })
            continue
          }

          if (isUsesStep(step)) {
            const expandedStep = {
              ...step,
              with: isPlainObject(step.with)
                ? expandMatrixExpressionsInRecord(step.with, combination)
                : step.with,
            }
            const actionScope = `${jobScope}:action:${stepIndex}`
            const expanded = expandUsesStepEvents(
              repoRoot,
              expandedStep,
              stepEnv,
              conditions,
              new Set(),
              actionScope
            )
            for (const event of expanded) {
              out.push({ workflowFile: wf, jobId, matrixKey, ...event })
            }
          }
        }
      }
    }
  }

  return out
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function listPluginPackages (repoRoot) {
  const entries = globSyncCached('packages/datadog-plugin-*', {
    cwd: repoRoot,
    nodir: false,
    windowsPathsNoEscape: true,
  })

  const out = new Set()
  for (const p of entries) {
    const full = path.join(repoRoot, p)
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    const name = path.basename(p).slice('datadog-plugin-'.length)
    if (name) out.add(name)
  }
  return out
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function loadUpstreamPluginNames (repoRoot) {
  const file = path.join(repoRoot, 'packages', 'dd-trace', 'test', 'plugins', 'versions', 'package.json')
  try {
    /** @type {unknown} */
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const deps = isPlainObject(pkg) && isPlainObject(pkg.dependencies) ? pkg.dependencies : {}
    return new Set(Object.keys(deps))
  } catch {
    return new Set()
  }
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, Array<{ name?: string }>>}
 */
function loadUpstreamExternals (repoRoot) {
  const file = path.join(repoRoot, 'packages', 'dd-trace', 'test', 'plugins', 'externals.js')
  try {
    /** @type {unknown} */
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(doc) ? /** @type {Record<string, Array<{ name?: string }>>} */ (doc) : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, string>} scripts
 * @returns {Set<string>}
 */
function buildScriptPrefixSet (scripts) {
  /** @type {Set<string>} */
  const out = new Set()

  for (const name of Object.keys(scripts)) {
    if (!name.startsWith('test:')) continue
    const parts = name.split(':')
    for (let i = 2; i <= parts.length; i++) {
      out.add(parts.slice(0, i).join(':'))
    }
  }

  return out
}

/**
 * @param {Record<string, string>} scripts
 * @returns {Set<string>}
 */
function getTraceCoreCategoriesFromScripts (scripts) {
  const cmd = scripts['test:trace:core']
  if (typeof cmd !== 'string') return new Set()

  // Extract the {a,b,c} part from:
  // packages/dd-trace/test/{a,b,c}/**/*.spec.js
  const m = cmd.match(/packages\/dd-trace\/test\/\{([^}]+)\}\/\*\*\/\*\.spec\.js/)
  if (!m) return new Set()

  const cats = m[1].split(',').map(s => s.trim()).filter(Boolean)
  return new Set(cats)
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function findDdTraceTestCategories (repoRoot) {
  const files = globSyncCached('packages/dd-trace/test/*/**/*.@(spec|test).@(js|mjs|cjs)', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: [
      '**/node_modules/**',
    ],
  })

  /** @type {Set<string>} */
  const out = new Set()
  const prefix = 'packages/dd-trace/test/'
  for (const f of files) {
    // packages/dd-trace/test/<cat>/...
    if (!f.startsWith(prefix)) continue
    const rest = f.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) out.add(rest.slice(0, slash))
  }

  return out
}

/**
 * @param {string} repoRoot
 * @param {string} category
 * @returns {string[]}
 */
function listDdTraceCategorySpecFiles (repoRoot, category) {
  const files = globSyncCached(`packages/dd-trace/test/${category}/**/*.@(spec|test).@(js|mjs|cjs)`, {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: [
      '**/node_modules/**',
    ],
  })
  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/**
 * @param {Set<string>} scriptPrefixes
 * @param {string} category
 * @returns {boolean}
 */
function isCategoryCoveredByOtherScript (scriptPrefixes, category) {
  const aliases = {
    // Historical naming mismatch: tests live in `test/profiling/` but scripts use `profiler`.
    profiling: ['profiler'],
  }

  const keys = [category]
  const extra = aliases[category]
  if (Array.isArray(extra)) keys.push(...extra)

  for (const key of keys) {
    if (scriptPrefixes.has(`test:${key}`)) return true
    if (scriptPrefixes.has(`test:trace:${key}`)) return true
    if (scriptPrefixes.has(`test:integration:${key}`)) return true
  }

  return false
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function buildAppsecPluginTestSet (repoRoot) {
  const files = globSyncCached('packages/dd-trace/test/appsec/**/*.plugin.@(spec|test).@(js|mjs|cjs)', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: DEFAULT_IGNORE_GLOBS,
  })

  /** @type {Set<string>} */
  const out = new Set()
  for (const f of files) {
    const base = path.basename(f)
    // e.g. graphql.apollo-server-express.plugin.spec.js -> apollo-server-express
    const m = base.match(/\.([^.]+)\.plugin\.(?:spec|test)\.[mc]?js$/)
    if (m && m[1]) out.add(m[1])
  }
  return out
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function buildLlmobsPluginTestSet (repoRoot) {
  const files = globSyncCached('packages/dd-trace/test/llmobs/plugins/*/*.@(spec|test).@(js|mjs|cjs)', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: DEFAULT_IGNORE_GLOBS,
  })

  /** @type {Set<string>} */
  const out = new Set()
  const prefix = 'packages/dd-trace/test/llmobs/plugins/'
  for (const f of files) {
    if (!f.startsWith(prefix)) continue
    const rest = f.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) out.add(rest.slice(0, slash))
  }
  return out
}

/**
 * @param {string} workflowFile
 * @param {string} jobId
 * @param {string} matrixKey
 * @returns {string}
 */
function getWorkflowJobKey (workflowFile, jobId, matrixKey) {
  const matrixSuffix = matrixKey ? `[${matrixKey}]` : ''
  return `${workflowFile}#${jobId}${matrixSuffix}`
}

/**
 * @param {string} repoRoot
 * @returns {void}
 */
function main (repoRoot) {
  const startNs = process.hrtime.bigint()

  const packageJsonPath = path.join(repoRoot, 'package.json')
  const pluginsVar = '$' + '{PLUGINS}'
  const bracePluginsVar = '{' + pluginsVar + '}'
  const ghaExprStart = '$' + '{{'

  /** @type {{ scripts?: Record<string, string> }} */
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const scripts = pkg.scripts || {}
  const knownScripts = new Set(Object.keys(scripts))
  const scriptPrefixes = buildScriptPrefixSet(scripts)

  // Detect `**` globs in scripts that are not wrapped in quotes. POSIX sh drops globstar, so
  // unquoted `**` degrades to `*` and only a single directory level is passed through to
  // mocha/globSync — silently missing any spec file deeper than one subdirectory.
  /** @type {string[]} */
  const unquotedGlobstar = []
  for (const scriptName of Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))) {
    const cmd = scripts[scriptName]
    if (typeof cmd !== 'string') continue

    for (const hit of findUnquotedGlobstar(getAnalyzableShell(cmd))) {
      unquotedGlobstar.push(
        `package.json: script "${scriptName}" contains an unquoted "**" at column ${hit.column} ` +
        `(near "${hit.context.trim()}"). Wrap the glob in double quotes so POSIX sh passes ` +
        'it through to mocha/glob as a literal; otherwise `**` collapses to `*` and specs ' +
        'deeper than one subdirectory are silently skipped.'
      )
    }
  }

  if (unquotedGlobstar.length) {
    process.stderr.write('Unquoted `**` globs detected in package.json scripts:\n')
    for (const msg of unquotedGlobstar) process.stderr.write(`- ${msg}\n`)
    process.exit(1)
  }

  const testFiles = findTestFiles(repoRoot)
  const { globs, matchedFiles } = expandScriptGlobs(repoRoot, scripts)

  /** @type {string[]} */
  const missing = []
  for (const file of testFiles) {
    if (!matchedFiles.has(file)) missing.push(file)
  }

  if (missing.length) {
    process.stderr.write('Test files not covered by any package.json script glob.\n')
    process.stderr.write(`Found test files: ${testFiles.length}\n`)
    process.stderr.write(`Extracted globs: ${globs.length}\n\n`)
    for (const file of missing) {
      process.stderr.write(`- ${file}\n`)
    }
    process.exit(1)
  }

  const workflowEvents = collectWorkflowEvents(repoRoot)
  /**
   * @type {{
   *   workflowFile: string,
   *   jobId: string,
   *   run: string,
   *   env: Record<string, string|undefined>,
   *   conditions: WorkflowCondition[]
   * }[]}
   */
  const workflowRuns = []
  /** @type {Map<string, WorkflowCondition[][]>} */
  const coverageJobsPendingUpload = new Map()
  /** @type {Map<string, Set<string>>} */
  const unsupportedLocalActions = new Map()
  const coverageScripts = findCoverageScripts(scripts, knownScripts)
  for (const event of workflowEvents) {
    const job = getWorkflowJobKey(event.workflowFile, event.jobId, event.matrixKey)
    if ('uploadsCoverage' in event) {
      const pendingConditions = coverageJobsPendingUpload.get(job)
      if (pendingConditions === undefined) continue

      let remaining = 0
      for (const producerConditions of pendingConditions) {
        if (!uploadCoversProducer(event.conditions, producerConditions)) {
          pendingConditions[remaining++] = producerConditions
        }
      }
      pendingConditions.length = remaining
      if (remaining === 0) coverageJobsPendingUpload.delete(job)
    } else if ('unsupportedLocalAction' in event) {
      let actions = unsupportedLocalActions.get(job)
      if (actions === undefined) {
        actions = new Set()
        unsupportedLocalActions.set(job, actions)
      }
      actions.add(event.unsupportedLocalAction)
    } else {
      workflowRuns.push(event)
      if (commandProducesCoverage(event.run, knownScripts, coverageScripts)) {
        const pendingConditions = coverageJobsPendingUpload.get(job)
        if (pendingConditions === undefined) {
          coverageJobsPendingUpload.set(job, [event.conditions])
        } else {
          pendingConditions.push(event.conditions)
        }
      }
    }
  }

  /** @type {{ workflowFile: string, jobId: string, script: string, env: Record<string, string|undefined> }[]} */
  const invoked = []
  for (const r of workflowRuns) {
    for (const invocation of extractScriptInvocationsWithEnvironment(r.run, knownScripts, r.env)) {
      invoked.push({
        workflowFile: r.workflowFile,
        jobId: r.jobId,
        script: invocation.script,
        env: invocation.env,
      })
    }
  }

  const uniqueErrors = new Set()
  /** @param {string} msg */
  const pushError = (msg) => {
    if (!uniqueErrors.has(msg)) uniqueErrors.add(msg)
  }

  for (const job of coverageJobsPendingUpload.keys()) {
    pushError(`${job}: generates coverage but does not upload it`)
  }
  for (const [job, actions] of unsupportedLocalActions) {
    for (const action of actions) {
      pushError(`${job}: cannot inspect non-composite local action "${action}"`)
    }
  }

  // Transitive closure: a script counts as "invoked" when CI either runs it directly or runs
  // another script that calls it via `npm run X` / `yarn X`. Without this, chaining a `:ci`
  // script into the body of a parent script (e.g. `lint` -> `npm run lint:codeowners:ci`)
  // looks orphaned to the coverage check below even though the parent's CI step exercises it.
  const invokedScripts = new Set(invoked.map(i => i.script))
  const closureQueue = [...invokedScripts]
  while (closureQueue.length) {
    const name = closureQueue.shift()
    if (name === undefined) continue
    const cmd = scripts[name]
    if (typeof cmd !== 'string') continue
    for (const inv of extractScriptInvocations(cmd, knownScripts)) {
      if (!invokedScripts.has(inv.script)) {
        invokedScripts.add(inv.script)
        closureQueue.push(inv.script)
      }
    }
  }

  /**
   * A script counts as "invoked" when either itself or its `:coverage` sibling (or base, if the
   * script is the `:coverage` variant) is referenced by CI. Pair-matching keeps duplicate
   * coverage/non-coverage definitions from each forcing their own CI step.
   *
   * @param {string} scriptName
   * @returns {boolean}
   */
  const isInvokedOrCoverageSibling = (scriptName) => {
    if (invokedScripts.has(scriptName)) return true
    if (scriptName.endsWith(':coverage')) {
      return invokedScripts.has(scriptName.slice(0, -':coverage'.length))
    }
    return invokedScripts.has(`${scriptName}:coverage`)
  }

  // CI must not invoke missing scripts.
  for (const i of invoked) {
    if (!scripts[i.script]) {
      // Any entry in `invoked` already passed our "looks like a script" filter in extractScriptInvocations.
      pushError(`${i.workflowFile}#${i.jobId}: invokes missing script "${i.script}"`)
    }
  }

  // All :ci scripts should be referenced by CI.
  for (const name of Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))) {
    if (!name.endsWith(':ci')) continue
    if (!isInvokedOrCoverageSibling(name)) {
      pushError(`package.json: script "${name}" is not invoked by any GitHub Actions workflow`)
    }
  }

  // All test:integration* scripts should be referenced by CI (except test:integration:plugins).
  for (const name of Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))) {
    if (!name.startsWith('test:integration')) continue
    // Skip test:integration:plugins (and its coverage sibling) - it's a convenience script for
    // running only plugin integration tests locally, but in CI these are already covered by
    // test:plugins:ci (which runs all plugin tests including integration tests).
    if (name === 'test:integration:plugins' || name === 'test:integration:plugins:coverage') continue
    if (!isInvokedOrCoverageSibling(name)) {
      pushError(`package.json: script "${name}" is not invoked by any GitHub Actions workflow`)
    }
  }

  // Validate plugin setup (domain-specific):
  // - test:plugins* expects packages/datadog-plugin-<name>
  // - test:appsec:plugins* expects matching *.plugin.spec.js files
  // - test:llmobs:plugins* expects llmobs plugin test directories
  // - test:plugins:upstream expects the module name listed in packages/dd-trace/test/plugins/versions/package.json
  const pluginPkgs = listPluginPackages(repoRoot)
  const versionsDeps = loadUpstreamPluginNames(repoRoot)
  const pluginExternals = loadUpstreamExternals(repoRoot)
  const appsecPluginTests = buildAppsecPluginTestSet(repoRoot)
  const llmobsPluginTests = buildLlmobsPluginTestSet(repoRoot)

  // Detect CI steps that will match no tests due to env/script mismatches.
  const testFileSet = new Set(testFiles)
  // Spec files reached by at least one CI invocation. Paired with the per-step
  // `matchedTestCount` check below to flag the inverse failure: a spec that is matched
  // by some script glob but no workflow ever sets the env (typically PLUGINS) that
  // would expand the glob to reach it. Without this, a new `<name>.spec.js` under
  // `packages/datadog-instrumentations/test/` looks covered by `test:instrumentations`'
  // glob and slips into the tree with no CI job actually running it.
  const ciExercisedFiles = new Set()
  for (const i of invoked) {
    if (!i.script.startsWith('test:')) continue

    /** @type {Record<string, string|undefined>} */
    const env = { ...i.env }

    // Only use literal PLUGINS for matching; expressions are unknown.
    if (env.PLUGINS && env.PLUGINS.includes(ghaExprStart)) env.PLUGINS = undefined

    const { files, globs: invokedGlobs } = expandInvokedScript(repoRoot, scripts, knownScripts, i.script, env)

    // Only enforce "matches test files" when the (expanded) script actually contains globs.
    // Some scripts (e.g. `test:plugins:upstream`) run a suite runner and do not directly
    // enumerate files via globs.
    if (invokedGlobs.length) {
      let matchedTestCount = 0
      for (const f of files) {
        if (testFileSet.has(f)) {
          matchedTestCount++
          ciExercisedFiles.add(f)
        }
      }

      if (matchedTestCount === 0) {
        const pluginsRaw = unwrapLiteralEnvValue(i.env.PLUGINS || '')
        const hint = pluginsRaw && /[,|]/.test(pluginsRaw) && scripts[`${i.script}:multi`]
          ? ` (PLUGINS="${pluginsRaw}" looks multi-valued; did you mean "${i.script}:multi"?)`
          : ''
        pushError(`${i.workflowFile}#${i.jobId}: "${i.script}" would match 0 test files${hint}`)
      }
    }

    // Validate each plugin name individually when PLUGINS is present
    // (avoid "one matches, one doesn't" hiding mistakes).
    const pluginsRaw = unwrapLiteralEnvValue(i.env.PLUGINS || '')
    const pluginList = pluginsRaw ? splitPlugins(pluginsRaw) : []

    if (pluginList.length) {
      if (i.script === 'test:plugins:upstream') {
        for (const p of pluginList) {
          const externals = pluginExternals[p]
          if (!Array.isArray(externals) || externals.length === 0) continue

          for (const ext of externals) {
            const dep = ext && typeof ext === 'object' ? ext.name : undefined
            if (!dep || typeof dep !== 'string') continue
            if (!versionsDeps.has(dep)) {
              pushError(
                `${i.workflowFile}#${i.jobId}: upstream dependency "${dep}" (from externals.js "${p}") ` +
                'is not listed in packages/dd-trace/test/plugins/versions/package.json'
              )
            }
          }
        }
      } else if (i.script.startsWith('test:appsec:plugins')) {
        for (const p of pluginList) {
          // In AppSec workflows, PLUGINS often includes "setup" dependencies that are used by a test
          // (e.g. express + multer) without necessarily having a dedicated `*.${plugin}.plugin.spec.js`
          // file. We only fail when the plugin is not:
          // - referenced by an AppSec plugin test file, AND
          // - a real dd-trace plugin package, AND
          // - an upstream test dependency in versions/package.json (e.g. apollo-server-core)
          const hasAppsecTests = appsecPluginTests.has(p)
          const isPluginPkg = pluginPkgs.has(p)
          const isUpstreamDep = versionsDeps.has(p)

          if (!hasAppsecTests && !isPluginPkg && !isUpstreamDep) {
            pushError(
              `${i.workflowFile}#${i.jobId}: PLUGINS includes "${p}" but no appsec plugin tests match ` +
              `"packages/dd-trace/test/appsec/**/*.${p}.plugin.spec.js" and it is not a plugin package ` +
              'or an upstream dependency in packages/dd-trace/test/plugins/versions/package.json'
            )
          }
        }
      } else if (i.script.startsWith('test:llmobs:plugins')) {
        for (const p of pluginList) {
          if (!llmobsPluginTests.has(p)) {
            pushError(
              `${i.workflowFile}#${i.jobId}: PLUGINS includes "${p}" but no llmobs plugin tests match ` +
              `'packages/dd-trace/test/llmobs/plugins/${p}/*.spec.js'`
            )
          }
        }
      } else if (i.script.startsWith('test:plugins') || i.script.includes(':plugins')) {
        for (const p of pluginList) {
          if (!pluginPkgs.has(p)) {
            pushError(
              `${i.workflowFile}#${i.jobId}: PLUGINS includes "${p}" but packages/datadog-plugin-${p} does not exist`
            )
          }
        }
      }
    }

    // If PLUGINS is multi-valued and we have a matching :multi script, enforce using it.
    if (pluginsRaw && /[,|]/.test(pluginsRaw)) {
      const cmd = scripts[i.script]
      if (
        typeof cmd === 'string' &&
        cmd.includes(pluginsVar) &&
        !cmd.includes(bracePluginsVar) &&
        scripts[`${i.script}:multi`]
      ) {
        pushError(
            `${i.workflowFile}#${i.jobId}: PLUGINS="${pluginsRaw}" but CI runs "${i.script}" ` +
            `which is single-plugin; use "${i.script}:multi" instead`
        )
      }
    }
  }

  // Spec files that pass the "matched by some script glob" check but no CI invocation
  // actually expands to reach them. Common cause: a `<name>.spec.js` added under
  // `packages/datadog-instrumentations/test/` (or any other PLUGINS-templated location)
  // without a matching `PLUGINS=<name>` job in the corresponding workflow.
  /** @type {string[]} */
  const ciOrphans = []
  for (const file of testFiles) {
    if (!ciExercisedFiles.has(file)) ciOrphans.push(file)
  }
  if (ciOrphans.length) {
    for (const file of ciOrphans) {
      pushError(`No CI workflow invocation expands a glob to exercise ${file}`)
    }
  }

  // NOTE: We intentionally do NOT require every datadog-plugin-* package to appear in CI here.
  // Some plugins are intentionally excluded (platform/service constraints) and are tracked elsewhere.

  if (uniqueErrors.size) {
    process.stderr.write('CI / script coverage checks failed:\n')
    for (const e of uniqueErrors) process.stderr.write(`- ${e}\n`)
    process.exit(1)
  }

  // Warn about dd-trace test categories not covered by test:trace:core.
  // This helps prevent "silent" test directories that are never run by the core suite.
  let hasCategoryWarnings = false
  const traceCoreCats = getTraceCoreCategoriesFromScripts(scripts)
  if (traceCoreCats.size) {
    const ddTraceCats = findDdTraceTestCategories(repoRoot)
    /** @type {string[]} */
    const missingFromTraceCore = []

    for (const cat of ddTraceCats) {
      if (!traceCoreCats.has(cat)) missingFromTraceCore.push(cat)
    }

    missingFromTraceCore.sort((a, b) => a.localeCompare(b, 'en'))

    /** @type {string[]} */
    const warnLines = []
    for (const cat of missingFromTraceCore) {
      const covered = isCategoryCoveredByOtherScript(scriptPrefixes, cat)
      // Only warn when the category is excluded from core AND we can't find any dedicated script
      // that appears to cover it. If it is covered elsewhere, it should not produce warnings.
      if (!covered) {
        const files = listDdTraceCategorySpecFiles(repoRoot, cat)
        const maxList = 25
        warnLines.push(`test:trace:core excludes "${cat}" (no dedicated test script found; files: ${files.length})`)
        for (let i = 0; i < files.length && i < maxList; i++) {
          warnLines.push(`  - ${files[i]}`)
        }
        if (files.length > maxList) {
          warnLines.push(`  - ... ${files.length - maxList} more`)
        }
      }
    }

    if (warnLines.length) {
      hasCategoryWarnings = true
      process.stdout.write('\nWarnings:\n')
      for (const w of warnLines) {
        if (w.startsWith('  ')) process.stdout.write(w + '\n')
        else process.stdout.write(`- ${w}\n`)
      }
    }
  } else if (typeof scripts['test:trace:core'] === 'string') {
    hasCategoryWarnings = true
    process.stdout.write('\nWarnings:\n')
    process.stdout.write('- Could not parse categories from scripts["test:trace:core"]\n')
  }

  if (hasCategoryWarnings) {
    process.stdout.write(
      'Some dd-trace test files are not covered by test:trace:core and no dedicated test script was found.\n'
    )
  } else {
    process.stdout.write('All test files are covered by at least one package.json script glob.\n')
  }
  process.stdout.write('All CI workflows reference valid scripts, and plugin setup looks consistent.\n')
  process.stdout.write(`Test files: ${testFiles.length}\n`)
  process.stdout.write(`Extracted globs: ${globs.length}\n`)

  const durMs = Number(process.hrtime.bigint() - startNs) / 1e6
  process.stdout.write(`Runtime(ms): ${durMs.toFixed(1)}\n`)
  process.stdout.write(`Glob cache: size=${globCache.size} hits=${globCacheHits} misses=${globCacheMisses}\n`)

  process.exit(hasCategoryWarnings ? 1 : 0)
}

main(process.argv[2] === undefined ? path.resolve(__dirname, '..') : path.resolve(process.argv[2]))
