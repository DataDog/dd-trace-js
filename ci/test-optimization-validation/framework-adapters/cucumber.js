'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { matchesLiteralGlob } = require('../literal-glob')

const CUCUMBER_PACKAGE = '@cucumber/cucumber'
const CONFIG_PATTERN = /^cucumber\.(?:[cm]?js|json|ya?ml)$/
const MAX_CONFIG_BYTES = 512 * 1024
const GENERATED_STEPS_FILENAME = 'dd-test-optimization-validation.steps.cjs'
const ISOLATION_CONFIG_PATH = path.join(__dirname, 'cucumber-validation.json')
const PROFILE_VALUE_OPTIONS = new Map([
  ['import', '--import'],
  ['language', '--language'],
  ['loader', '--loader'],
  ['parallel', '--parallel'],
  ['require', '--require'],
  ['requireModule', '--require-module'],
  ['worldParameters', '--world-parameters'],
])
const PROFILE_FLAG_OPTIONS = new Map([
  ['backtrace', '--backtrace'],
  ['failFast', '--fail-fast'],
  ['strict', '--strict'],
])
const OMITTED_PROFILE_KEYS = new Set([
  'dryRun',
  'forceExit',
  'format',
  'formatOptions',
  'name',
  'order',
  'paths',
  'publish',
  'publishQuiet',
  'retry',
  'retryTagFilter',
  'tags',
])
const OMITTED_PROFILE_OPTIONS = new Map([
  ['-f', true],
  ['--dry-run', false],
  ['--exit', false],
  ['--force-exit', false],
  ['--format', true],
  ['--format-options', true],
  ['--name', true],
  ['--order', true],
  ['--publish', false],
  ['--publish-quiet', false],
  ['--retry', true],
  ['--retry-tag-filter', true],
  ['--tags', true],
  ['-t', true],
])
const RETAINED_PROFILE_FLAGS = new Set(['--backtrace', '--fail-fast', '--no-strict', '--strict'])
const RETAINED_PROFILE_VALUES = new Set([
  '-i',
  '-r',
  '--import',
  '--language',
  '--loader',
  '--parallel',
  '--require',
  '--require-module',
  '--world-parameters',
])
const JAVASCRIPT_STRING_ESCAPES = Object.freeze({
  '"': '"',
  "'": "'",
  '/': '/',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
})

/**
 * Reports whether the installed Cucumber CLI can bypass customer profiles with a validator-owned config.
 *
 * Cucumber 7 always loads cucumber.js from its working directory and has no --config option. Changing the working
 * directory would alter project test semantics, so those versions remain a validator limitation.
 *
 * @param {string|null|undefined} version installed Cucumber version
 * @returns {boolean} whether validator-owned config isolation is supported
 */
function supportsConfigIsolation (version) {
  const match = /^[v=]?(\d+)(?:\.|$)/.exec(String(version || ''))
  return Boolean(match && Number(match[1]) >= 8)
}

/**
 * Reports whether a file follows the Cucumber feature convention.
 *
 * @param {string} filename candidate filename
 * @returns {boolean} whether the candidate can be selected by Cucumber
 */
function isTestFile (filename) {
  return filename.endsWith('.feature')
}

/**
 * Counts statically declared Cucumber scenarios in a feature.
 *
 * @param {string} source feature source
 * @returns {number} declared scenario count
 */
function getScenarioCount (source) {
  return [...source.matchAll(/^[ \t]*(?:Example|Scenario(?: Outline| Template)?):[ \t]*\S/gm)].length
}

/**
 * Returns validator-owned Cucumber feature source for one generated scenario.
 *
 * @param {object} input generated source input
 * @param {string} input.testName generated scenario name
 * @returns {string} canonical generated feature source
 */
function getGeneratedTestContent ({ testName }) {
  return [
    'Feature: Datadog Test Optimization validation',
    '',
    `  Scenario: ${testName}`,
    `    Given the Datadog validation scenario ${JSON.stringify(testName)}`,
  ].join('\n')
}

/**
 * Returns the validator-owned Cucumber step definitions shared by generated scenarios.
 *
 * @returns {string} canonical generated step-definition source
 */
function getGeneratedStepsContent () {
  return [
    "'use strict'",
    '',
    `const { Given } = require(${JSON.stringify(CUCUMBER_PACKAGE)})`,
    '',
    'let atrAttempt = 0',
    '',
    "Given('the Datadog validation scenario {string}', function (scenario) {",
    "  if (scenario === 'atr-fail-once' && atrAttempt++ === 0) {",
    "    throw new Error('dd-test-optimization-validation atr first failure')",
    '  }',
    '})',
  ].join('\n')
}

/**
 * Returns the generated Cucumber step-definition path for a feature directory.
 *
 * @param {string} testDirectory generated feature directory
 * @returns {string} generated step-definition path
 */
function getGeneratedStepsPath (testDirectory) {
  return path.join(testDirectory, GENERATED_STEPS_FILENAME)
}

/**
 * Returns Cucumber arguments that select one existing feature.
 *
 * @param {string} filename selected Cucumber feature
 * @param {string} cwd project working directory
 * @returns {string[]} focused Cucumber arguments
 */
function getFocusedTestArgs (filename, cwd) {
  return [...getIsolationArgs(cwd), filename, '--format', 'json']
}

/**
 * Returns Cucumber arguments for one isolated generated scenario.
 *
 * @param {string} filename generated Cucumber feature
 * @param {string} stepsFile generated Cucumber step definitions
 * @param {string} cwd project working directory
 * @returns {string[]} generated scenario arguments
 */
function getGeneratedTestArgs (filename, stepsFile, cwd) {
  return [...getIsolationArgs(cwd), '--require', stepsFile, '--format', 'json', filename]
}

/**
 * Extracts the executed-scenario count from the final Cucumber summary.
 *
 * @param {string} output Cucumber output without ANSI escapes
 * @returns {number|null} final scenario count when present
 */
function getObservedTestCount (output) {
  const jsonCount = getJsonScenarioCount(output)
  if (jsonCount !== null) return jsonCount

  let count = null
  for (const match of output.matchAll(/\b(\d+)\s+scenarios?\b/gi)) count = Number(match[1])
  return count
}

/**
 * Expands selected Cucumber profiles without loading customer JavaScript.
 *
 * Profile feature paths, filters, retries, publishing, and formatters are intentionally omitted. The validator
 * supplies one exact feature and a machine-readable formatter.
 *
 * @param {object} input profile inputs
 * @param {string[]} input.configFiles bounded Cucumber config files
 * @param {string} input.projectRoot project root
 * @param {string[]} input.projectFiles bounded project files
 * @param {string[]} input.runnerArgs retained command-line arguments
 * @returns {{error?: string, runnerArgs: string[]}} expanded profile arguments
 */
function expandProfiles ({ configFiles, projectFiles, projectRoot, runnerArgs }) {
  const selectedProfiles = getOptionValues(runnerArgs, new Set(['-p', '--profile']))
  const explicitConfig = getOptionValues(runnerArgs, new Set(['--config']))[0]
  const explicitConfigFile = explicitConfig && getPhysicalPath(path.resolve(projectRoot, explicitConfig))
  const physicalProjectRoot = getPhysicalDirectory(projectRoot)
  const configFile = explicitConfig
    ? configFiles.find(filename => path.resolve(filename) === explicitConfigFile)
    : configFiles.find(filename =>
      path.dirname(filename) === physicalProjectRoot && CONFIG_PATTERN.test(path.basename(filename)))
  const directArgs = omitOptions(runnerArgs, new Set(['-p', '--config', '--profile']))

  if (explicitConfig && !configFile) {
    return {
      error: `explicit Cucumber config ${JSON.stringify(explicitConfig)} is not an approval-bound regular file`,
      runnerArgs: [],
    }
  }
  if (!configFile) return expandSupportPaths(directArgs, projectFiles, projectRoot)

  let definitions
  try {
    definitions = readProfileDefinitions(configFile)
  } catch (error) {
    return { error: `Cucumber configuration could not be expanded statically: ${error.message}`, runnerArgs: [] }
  }

  const profiles = selectedProfiles.length > 0 ? selectedProfiles : ['default']
  const expanded = []
  for (const profile of profiles) {
    const definition = definitions.get(profile)
    if (definition === undefined) {
      return {
        error: `Cucumber profile ${JSON.stringify(profile)} is not a static literal in ${path.basename(configFile)}`,
        runnerArgs: [],
      }
    }
    const parsed = getProfileArgs(definition)
    if (parsed.error) {
      return {
        error: `Cucumber profile ${JSON.stringify(profile)} ${parsed.error}`,
        runnerArgs: [],
      }
    }
    expanded.push(...parsed.args)
  }
  return expandSupportPaths([...expanded, ...directArgs], projectFiles, projectRoot)
}

function getIsolationArgs (cwd) {
  return ['--config', path.relative(cwd, ISOLATION_CONFIG_PATH)]
}

function readProfileDefinitions (filename) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('configuration must be a regular non-symbolic-link file')
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit`)
  }
  const source = fs.readFileSync(filename, 'utf8')
  const extension = path.extname(filename)
  if (extension === '.json') return getDataProfileDefinitions(JSON.parse(source))
  if (extension === '.yaml' || extension === '.yml') {
    return getYamlStringProfileDefinitions(source)
  }
  return getJavascriptProfileDefinitions(source)
}

function getJavascriptProfileDefinitions (source) {
  const syntax = maskJavascriptCommentsAndStrings(source)
  const exports = [...syntax.matchAll(/^\s*(?:module\s*\.\s*exports\s*=|export\s+default)\s*\{/gm)]
  if (exports.length === 0) return new Map()
  if (exports.length !== 1) throw new Error('configuration must export one literal profile object')

  const objectStart = exports[0].index + exports[0][0].lastIndexOf('{')
  const objectEnd = findClosingBrace(syntax, objectStart)
  if (objectEnd === -1) throw new Error('configuration contains an unterminated profile object')
  const definitions = new Map()
  let index = objectStart + 1
  while (index < objectEnd) {
    index = skipWhitespace(syntax, index)
    if (syntax[index] === ',') {
      index++
      continue
    }
    if (index >= objectEnd) break

    let name
    const quotedName = readQuotedString(source, index)
    if (quotedName) {
      name = quotedName.value
      index = quotedName.end
    } else {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(syntax.slice(index))
      if (!identifier) throw new Error('profile names must be static literal properties')
      name = identifier[0]
      index += identifier[0].length
    }

    index = skipWhitespace(syntax, index)
    if (syntax[index] !== ':') throw new Error(`profile ${JSON.stringify(name)} must have a literal value`)
    index = skipWhitespace(syntax, index + 1)
    const definition = readJavascriptLiteral(source, syntax, index)
    if (!definition || (typeof definition.value !== 'string' &&
      (!definition.value || typeof definition.value !== 'object' || Array.isArray(definition.value)))) {
      throw new Error(`profile ${JSON.stringify(name)} must be a literal string or object`)
    }
    definitions.set(name, definition.value)
    index = skipWhitespace(syntax, definition.end)
    if (index < objectEnd && syntax[index] !== ',') {
      throw new Error(`profile ${JSON.stringify(name)} must be followed by a comma`)
    }
  }
  if (!/^[\s;]*$/.test(syntax.slice(objectEnd + 1))) {
    throw new Error('configuration contains code after the exported profile object')
  }
  return definitions
}

function maskJavascriptCommentsAndStrings (source) {
  const syntax = [...source]
  let quote
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      else syntax[index] = ' '
      continue
    }
    if (blockComment) {
      syntax[index] = ' '
      if (character === '*' && next === '/') {
        syntax[++index] = ' '
        blockComment = false
      }
      continue
    }
    if (quote) {
      if (character === '\\') {
        syntax[index] = ' '
        if (index + 1 < source.length) syntax[++index] = ' '
      } else if (character === quote) {
        quote = undefined
      } else {
        syntax[index] = ' '
      }
      continue
    }
    if (character === '/' && next === '/') {
      syntax[index] = syntax[++index] = ' '
      lineComment = true
    } else if (character === '/' && next === '*') {
      syntax[index] = syntax[++index] = ' '
      blockComment = true
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    }
  }
  return syntax.join('')
}

function findClosingBrace (source, start) {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0) return index
  }
  return -1
}

function skipWhitespace (source, start) {
  let index = start
  while (/\s/.test(source[index] || '')) index++
  return index
}

/**
 * Reads a bounded JSON-shaped JavaScript literal without evaluating customer code.
 *
 * @param {string} source original JavaScript source
 * @param {string} syntax source with comments and string contents masked
 * @param {number} start literal start offset
 * @param {number} [depth] current literal nesting depth
 * @returns {{end: number, value: unknown}|undefined} parsed literal and ending offset
 */
function readJavascriptLiteral (source, syntax, start, depth = 0) {
  if (depth > 16) return
  let index = skipWhitespace(syntax, start)
  const quoted = readQuotedString(source, index)
  if (quoted) return quoted

  const primitive = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$.])/.exec(
    syntax.slice(index)
  )
  if (primitive) {
    const values = { false: false, null: null, true: true }
    const value = Object.hasOwn(values, primitive[1]) ? values[primitive[1]] : Number(primitive[1])
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return
    return {
      end: index + primitive[0].length,
      value,
    }
  }

  const open = syntax[index]
  if (open !== '[' && open !== '{') return
  const close = open === '[' ? ']' : '}'
  const value = open === '[' ? [] : Object.create(null)
  index++
  while (index < syntax.length) {
    index = skipWhitespace(syntax, index)
    if (syntax[index] === close) return { end: index + 1, value }

    let item
    if (open === '[') {
      item = readJavascriptLiteral(source, syntax, index, depth + 1)
      if (!item) return
      value.push(item.value)
    } else {
      const property = readJavascriptPropertyName(source, syntax, index)
      if (!property || property.value === '__proto__' || Object.hasOwn(value, property.value)) return
      index = skipWhitespace(syntax, property.end)
      if (syntax[index] !== ':') return
      item = readJavascriptLiteral(source, syntax, index + 1, depth + 1)
      if (!item) return
      value[property.value] = item.value
    }
    index = item.end

    index = skipWhitespace(syntax, index)
    if (syntax[index] === close) return { end: index + 1, value }
    if (syntax[index] !== ',') return
    index++
  }
}

/**
 * Reads one static quoted or identifier JavaScript object property name.
 *
 * @param {string} source original JavaScript source
 * @param {string} syntax source with comments and string contents masked
 * @param {number} start property start offset
 * @returns {{end: number, value: string}|undefined} property name and ending offset
 */
function readJavascriptPropertyName (source, syntax, start) {
  const index = skipWhitespace(syntax, start)
  const quoted = readQuotedString(source, index)
  if (quoted) return quoted
  const identifier = /^[A-Za-z_$][\w$]*/.exec(syntax.slice(index))
  if (identifier) return { end: index + identifier[0].length, value: identifier[0] }
}

function getDataProfileDefinitions (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('configuration must contain a profile object')
  }
  return new Map(Object.entries(value))
}

function getYamlStringProfileDefinitions (source) {
  const definitions = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    const definition = match && !/^\s/.test(line) ? getYamlStringProfileDefinition(match[2]) : undefined
    if (definition === undefined) {
      throw new Error('YAML profiles must be literal one-line command strings')
    }
    definitions.set(match[1], definition)
  }
  return definitions
}

function getYamlStringProfileDefinition (source) {
  const value = source.trimStart()
  const quote = value[0]
  if (quote !== '"' && quote !== "'") {
    const comment = /\s+#/.exec(value)
    const definition = value.slice(0, comment?.index ?? value.length).trimEnd()
    return definition || undefined
  }

  let definition = ''
  for (let index = 1; index < value.length; index++) {
    const character = value[index]
    if (quote === '"' && character === '\\') {
      return
    }
    if (quote === "'" && character === quote && value[index + 1] === quote) {
      definition += quote
      index++
      continue
    }
    if (character !== quote) {
      definition += character
      continue
    }
    const remainder = value.slice(index + 1)
    if (!remainder.trim() || /^\s+#/.test(remainder)) return definition
    return
  }
}

function readQuotedString (source, start) {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") return
  let value = ''
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (character === quote) return { end: index + 1, value }
    if (character === '\r' || character === '\n') return
    if (character !== '\\') {
      value += character
      index++
      continue
    }
    const escaped = readJavascriptStringEscape(source, index + 1)
    if (!escaped) return
    value += escaped.value
    index = escaped.end
  }
}

/**
 * Decodes one bounded JavaScript string escape without evaluating source.
 *
 * @param {string} source original JavaScript source
 * @param {number} start first character after the backslash
 * @returns {{end: number, value: string}|undefined} decoded character and ending offset
 */
function readJavascriptStringEscape (source, start) {
  const escaped = source[start]
  if (Object.hasOwn(JAVASCRIPT_STRING_ESCAPES, escaped)) {
    return { end: start + 1, value: JAVASCRIPT_STRING_ESCAPES[escaped] }
  }
  if (escaped === '\n') return { end: start + 1, value: '' }
  if (escaped === '\r') {
    return { end: source[start + 1] === '\n' ? start + 2 : start + 1, value: '' }
  }

  if (escaped === 'x') {
    const hexadecimal = source.slice(start + 1, start + 3)
    if (/^[\da-fA-F]{2}$/.test(hexadecimal)) {
      return { end: start + 3, value: String.fromCharCode(Number.parseInt(hexadecimal, 16)) }
    }
    return
  }
  if (escaped !== 'u') return

  if (source[start + 1] === '{') {
    const match = /^\{([\da-fA-F]{1,6})\}/.exec(source.slice(start + 1))
    if (!match) return
    const codePoint = Number.parseInt(match[1], 16)
    if (codePoint > 1_114_111) return
    return { end: start + 1 + match[0].length, value: String.fromCodePoint(codePoint) }
  }

  const hexadecimal = source.slice(start + 1, start + 5)
  if (/^[\da-fA-F]{4}$/.test(hexadecimal)) {
    return { end: start + 5, value: String.fromCharCode(Number.parseInt(hexadecimal, 16)) }
  }
}

function getProfileArgs (definition) {
  if (typeof definition === 'string') return getStringProfileArgs(definition)
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { error: 'must be a literal string or object', args: [] }
  }

  const args = []
  for (const [key, value] of Object.entries(definition)) {
    if (OMITTED_PROFILE_KEYS.has(key)) continue
    const flag = PROFILE_FLAG_OPTIONS.get(key)
    if (flag) {
      if (typeof value !== 'boolean') return { error: `contains non-boolean ${key}`, args: [] }
      if (key === 'strict') args.push(value ? '--strict' : '--no-strict')
      else if (value) args.push(flag)
      continue
    }
    const option = PROFILE_VALUE_OPTIONS.get(key)
    if (!option) return { error: `contains unsupported option ${key}`, args: [] }

    if (key === 'worldParameters') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'contains non-object worldParameters', args: [] }
      }
      args.push(option, JSON.stringify(value))
      continue
    }

    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (item !== null && typeof item === 'object') {
        return { error: `contains unsupported object value for ${key}`, args: [] }
      }
      args.push(option, String(item))
    }
  }
  return { args }
}

function getStringProfileArgs (definition) {
  const tokens = tokenizeProfile(definition)
  if (!tokens) return { error: 'contains shell control syntax or unbalanced quoting', args: [] }

  const args = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) continue
    const option = token.split('=', 1)[0]
    if (RETAINED_PROFILE_FLAGS.has(option)) {
      args.push(token)
      continue
    }
    if (RETAINED_PROFILE_VALUES.has(option)) {
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[++index]
      if (!value || value.startsWith('-')) return { error: `has a missing value for ${option}`, args: [] }
      args.push(option, value)
      continue
    }
    if (OMITTED_PROFILE_OPTIONS.has(option)) {
      if (OMITTED_PROFILE_OPTIONS.get(option) && !token.includes('=')) index++
      continue
    }
    return { error: `contains unsupported option ${option}`, args: [] }
  }
  return { args }
}

function tokenizeProfile (source) {
  if (/[\0\r\n;&|`]|\$\(|\$\{/.test(source)) return
  const tokens = []
  const pattern = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/g
  let consumed = 0
  for (const match of source.matchAll(pattern)) {
    if (source.slice(consumed, match.index).trim()) return
    tokens.push(match[1] ?? match[2] ?? match[3])
    consumed = match.index + match[0].length
  }
  if (source.slice(consumed).trim()) return
  return tokens
}

function getOptionValues (args, options) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    const option = args[index].split('=', 1)[0]
    if (!options.has(option)) continue
    values.push(args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : args[++index])
  }
  return values.filter(Boolean)
}

function getPhysicalPath (filename) {
  try {
    return fs.realpathSync(filename)
  } catch {}
}

function omitOptions (args, options) {
  const retained = []
  for (let index = 0; index < args.length; index++) {
    const option = args[index].split('=', 1)[0]
    if (!options.has(option)) {
      retained.push(args[index])
      continue
    }
    if (!args[index].includes('=')) index++
  }
  return retained
}

function expandSupportPaths (args, projectFiles, projectRoot) {
  const expanded = []
  const pathOptions = new Set(['-i', '-r', '--import', '--require'])
  const aliases = { '-i': '--import', '-r': '--require' }
  for (let index = 0; index < args.length; index++) {
    const option = args[index].split('=', 1)[0]
    if (!pathOptions.has(option)) {
      expanded.push(args[index])
      continue
    }

    const value = args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : args[++index]
    const matches = getSupportPathMatches(value, projectFiles, projectRoot)
    if (matches.length === 0) {
      return {
        error: `Cucumber support path ${JSON.stringify(value)} does not match a repository-contained file`,
        runnerArgs: [],
      }
    }
    for (const filename of matches) expanded.push(aliases[option] || option, filename)
  }
  return { runnerArgs: expanded }
}

function getSupportPathMatches (value, projectFiles, projectRoot) {
  const normalized = String(value || '').replaceAll('\\', '/')
  const candidate = path.resolve(projectRoot, value)
  try {
    if (fs.statSync(candidate).isFile()) return [candidate]
    if (fs.statSync(candidate).isDirectory()) {
      return projectFiles.filter(filename => {
        const relative = path.relative(candidate, filename)
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative) &&
          /\.[cm]?[jt]s$/.test(filename)
      }).sort()
    }
  } catch {}
  if (!/[*?[\]{}]/.test(normalized)) return []
  return projectFiles.filter(filename => {
    return matchesLiteralGlob(path.relative(projectRoot, filename), normalized)
  }).sort()
}

function getJsonScenarioCount (output) {
  const source = output.trim()
  const end = source.lastIndexOf(']')
  if (end === -1) return null
  let attempts = 0
  for (let start = source.indexOf('['); start !== -1 && start < end && attempts < 20;
    start = source.indexOf('[', start + 1), attempts++) {
    try {
      const features = JSON.parse(source.slice(start, end + 1))
      if (!Array.isArray(features)) continue
      return features.reduce((count, feature) => {
        return count + (feature.elements || []).filter(element => element.type === 'scenario').length
      }, 0)
    } catch {}
  }
  return null
}

function getPhysicalDirectory (directory) {
  try {
    const physical = fs.realpathSync(directory)
    if (fs.statSync(physical).isDirectory()) return physical
  } catch {}
}

module.exports = {
  CONFIG_PATTERN,
  expandProfiles,
  getFocusedTestArgs,
  getGeneratedStepsContent,
  getGeneratedStepsPath,
  getGeneratedTestArgs,
  getGeneratedTestContent,
  getObservedTestCount,
  getScenarioCount,
  isTestFile,
  supportsConfigIsolation,
}
