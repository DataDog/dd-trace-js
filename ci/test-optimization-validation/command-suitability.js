'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_CONFIG_BYTES = 512 * 1024
const MAX_STATIC_CONFIG_ARRAY_BYTES = 4096
const MAX_STATIC_CONFIG_PATTERNS = 32
const MAX_STATIC_CONFIG_PATTERN_BYTES = 256
const JEST_LOCAL_PATH_PATTERN = /(['"])(<rootDir>\/[^'"\r\n]+)\1/g
const JEST_ROOT_DIR_PATTERN = /\brootDir\s*:\s*(['"])([^'"]+)\1/
const TYPECHECK_ENABLED_PATTERN = /typecheck\s*:\s*\{[\s\S]{0,2000}?enabled\s*:\s*true/
const VITEST_CONFIG_FILENAMES = [
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
]

/**
 * Returns why a planned command is unsuitable for deterministic validation.
 *
 * @param {object} input suitability input
 * @param {object} input.command manifest command
 * @param {object} input.framework manifest framework
 * @param {string} input.label planned command label
 * @param {string} input.repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getCommandSuitabilityError ({ command, framework, label, repositoryRoot }) {
  const yarnError = getRepositoryYarnError(command, repositoryRoot)
  if (yarnError) return yarnError

  if (framework.framework === 'jest') {
    const missingInputError = getJestMissingLocalInputError(framework)
    if (missingInputError) return missingInputError
  }

  if (framework.framework === 'vitest' &&
    (label === 'the selected test command' || label.includes('advanced-feature'))) {
    if (label.includes('advanced-feature')) {
      const generatedPathError = getVitestGeneratedPathError(command, framework, repositoryRoot)
      if (generatedPathError) return generatedPathError
    }
    return getVitestTypecheckError(command, label.includes('advanced-feature'), repositoryRoot)
  }
}

/**
 * Returns an error for an exact local file referenced by Jest config but absent before execution.
 *
 * @param {object} framework manifest framework entry
 * @returns {string|undefined} suitability error
 */
function getJestMissingLocalInputError (framework) {
  for (const configFile of framework.project?.configFiles || []) {
    const config = readConfig(configFile)
    if (!config) continue

    const rootDirMatch = config.match(JEST_ROOT_DIR_PATTERN)
    const rootDir = rootDirMatch
      ? path.resolve(path.dirname(configFile), rootDirMatch[2])
      : path.dirname(configFile)

    for (const match of config.matchAll(JEST_LOCAL_PATH_PATTERN)) {
      const configuredPath = match[2]
      if (/[$*?{}[\]]/.test(configuredPath) || !/\.(?:[cm]?[jt]sx?|json)$/.test(configuredPath)) continue

      const localPath = path.resolve(rootDir, configuredPath.slice('<rootDir>/'.length))
      if (fs.existsSync(localPath) || isProducedBySetup(framework, localPath)) continue

      return `uses Jest config ${configFile}, which references missing local input ${localPath}. ` +
        'Choose a representative whose config inputs already exist, or declare the reviewed setup command and ' +
        'its output path before marking this framework runnable.'
    }
  }
}

/**
 * Checks whether an approved setup command declares the missing input as an output.
 *
 * @param {object} framework manifest framework entry
 * @param {string} localPath missing local input
 * @returns {boolean} whether setup declares the input
 */
function isProducedBySetup (framework, localPath) {
  for (const command of framework.setup?.commands || []) {
    for (const outputPath of command.outputPaths || []) {
      const relative = path.relative(path.resolve(outputPath), localPath)
      if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return true
    }
  }
  return false
}

function getRepositoryYarnError (command, repositoryRoot) {
  if (command.usesShell || path.basename(command.argv?.[0] || '') !== 'yarn') return

  const releaseDirectory = path.join(repositoryRoot, '.yarn', 'releases')
  let releases
  try {
    releases = fs.readdirSync(releaseDirectory)
      .filter(filename => /^yarn-[^/]+\.cjs$/.test(filename))
      .sort()
  } catch {
    return
  }
  if (releases.length === 0) return

  const release = path.posix.join('.yarn', 'releases', releases[releases.length - 1])
  return `uses bare "yarn", but this repository pins ${release}. Use the structured command ` +
    `argv [process.execPath, "${release}", ...] so validation does not depend on an ambient Yarn shim.`
}

function getVitestTypecheckError (command, generatedTest, repositoryRoot) {
  const commandText = command.usesShell ? command.shellCommand || '' : (command.argv || []).join(' ')
  if (/(^|\s)--typecheck\.enabled=false(?:\s|$)/.test(commandText)) return
  if (/(^|\s)--typecheck(?:\s|$|=)/.test(commandText)) {
    return getTypecheckError('runs Vitest with --typecheck', generatedTest)
  }

  const configFile = getVitestConfigFile(command, repositoryRoot)
  if (!configFile || !configEnablesTypecheck(configFile, repositoryRoot)) return

  return getTypecheckError(`uses typecheck-enabled Vitest config ${configFile}`, generatedTest)
}

function getTypecheckError (prefix, generatedTest) {
  if (generatedTest) {
    return `${prefix} for generated runtime tests. Typecheck projects can count each generated test twice; use ` +
      'an existing typecheck-disabled config, or create a declared temporary config for advanced checks.'
  }
  return `${prefix} for the selected direct test command. Typecheck can duplicate runtime tests and make ` +
    'unrelated source errors fail Basic Reporting; use an existing runtime-only config or append ' +
    '`--typecheck.enabled=false`.'
}

function getVitestGeneratedPathError (command, framework, repositoryRoot) {
  const configFile = getVitestConfigFile(command, repositoryRoot)
  if (!configFile) return
  const config = readRepositoryConfig(configFile, repositoryRoot)
  if (!config) return

  const includes = getLiteralTestConfigPatterns(config, 'include')
  const excludes = getLiteralTestConfigPatterns(config, 'exclude')
  if (includes.length === 0 && excludes.length === 0) return

  for (const file of framework.generatedTestStrategy?.files || []) {
    const relative = path.relative(path.dirname(configFile), file.path).split(path.sep).join('/')
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue

    if (includes.length > 0 && !includes.some(pattern => matchesGlob(relative, pattern))) {
      return `uses temporary test path ${file.path}, which does not match the literal test.include patterns in ` +
        `${configFile}: ${includes.join(', ')}. Choose a temporary test path accepted by the selected Vitest ` +
        'config ' +
        'before asking for approval.'
    }
    if (excludes.some(pattern => matchesGlob(relative, pattern))) {
      return `uses temporary test path ${file.path}, which matches a literal test.exclude pattern in ` +
        `${configFile}. Choose a temporary test path accepted by the selected Vitest config before asking for ` +
        'approval.'
    }
  }
}

function getLiteralTestConfigPatterns (config, property) {
  const candidates = []
  for (const objectStart of getLiteralObjectStarts(config, 'test')) {
    const patterns = getDirectLiteralArrayPatterns(config, objectStart, property)
    if (patterns.length > 0) candidates.push(patterns)
  }
  if (candidates.length === 0) return []

  const first = JSON.stringify(candidates[0])
  return candidates.every(candidate => JSON.stringify(candidate) === first) ? candidates[0] : []
}

function getLiteralObjectStarts (config, property) {
  const starts = []
  visitConfigSource(config, ({ index }) => {
    if (!isPropertyAt(config, index, property)) return
    const match = new RegExp(String.raw`^${property}\s*:\s*\{`).exec(config.slice(index))
    if (match) starts.push(index + match[0].lastIndexOf('{'))
  })
  return starts
}

function getDirectLiteralArrayPatterns (config, objectStart, property) {
  let patterns = []
  visitConfigSource(config, ({ index, depth }) => {
    if (patterns.length > 0 || depth !== 1 || !isPropertyAt(config, index, property)) return
    const match = new RegExp(String.raw`^${property}\s*:\s*\[`).exec(config.slice(index))
    if (match) patterns = readLiteralStringArray(config, index + match[0].length)
  }, objectStart)
  return patterns
}

function readLiteralStringArray (config, offset) {
  const patterns = []
  let quote = ''
  let value = ''
  let closed = false
  const end = Math.min(config.length, offset + MAX_STATIC_CONFIG_ARRAY_BYTES)
  for (let index = offset; index < end; index++) {
    const character = config[index]
    if (!quote) {
      if (character === ']') {
        closed = true
        break
      }
      if (character === '"' || character === '\'') {
        quote = character
        value = ''
      } else if (character !== ',' && !/\s/.test(character)) {
        return []
      }
      continue
    }

    if (character === quote) {
      if (value.length > MAX_STATIC_CONFIG_PATTERN_BYTES || patterns.length === MAX_STATIC_CONFIG_PATTERNS) {
        return []
      }
      patterns.push(value)
      quote = ''
    } else if (character.charCodeAt(0) === 92) {
      return []
    } else if (character === '\r' || character === '\n') {
      return []
    } else {
      value += character
    }
  }
  return closed && !quote ? patterns : []
}

function visitConfigSource (config, visitor, objectStart = -1) {
  let blockComment = false
  let depth = objectStart === -1 ? 0 : 1
  let lineComment = false
  let quote = ''
  const start = objectStart === -1 ? 0 : objectStart + 1

  for (let index = start; index < config.length; index++) {
    const character = config[index]
    const next = config[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (character.charCodeAt(0) === 92) {
        index++
      } else if (character === quote) {
        quote = ''
      }
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (character === '"' || character === '\'' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') {
      depth++
      continue
    }
    if (character === '}') {
      depth--
      if (objectStart !== -1 && depth === 0) break
      continue
    }
    visitor({ index, depth })
  }
}

function isPropertyAt (config, index, property) {
  if (!config.startsWith(property, index)) return false
  const before = config[index - 1]
  const after = config[index + property.length]
  return !isIdentifierCharacter(before) && !isIdentifierCharacter(after)
}

function isIdentifierCharacter (character) {
  return Boolean(character && /[A-Za-z0-9_$]/.test(character))
}

function matchesGlob (filename, pattern) {
  const normalized = pattern.replace(/^\.\//, '')
  let source = '^'
  let index = 0

  while (index < normalized.length) {
    const character = normalized[index]
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:[^/]+/)*'
        index += 3
      } else {
        source += '.*'
        index += 2
      }
      continue
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?' && normalized[index + 1] === '(') {
      const end = normalized.indexOf(')', index + 2)
      const value = end === -1 ? '' : normalized.slice(index + 2, end)
      if (/^[A-Za-z0-9._-]+$/.test(value)) {
        source += `(?:${escapeRegex(value)})?`
        index = end + 1
        continue
      } else {
        source += '[^/]'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else if (character === '[') {
      const end = normalized.indexOf(']', index + 1)
      const value = end === -1 ? '' : normalized.slice(index + 1, end)
      if (/^!?[A-Za-z0-9_-]+$/.test(value)) {
        source += `[${value.startsWith('!') ? `^${value.slice(1)}` : value}]`
        index = end + 1
        continue
      } else {
        source += String.raw`\[`
      }
    } else if (character === '{') {
      const end = normalized.indexOf('}', index + 1)
      const values = end === -1 ? [] : normalized.slice(index + 1, end).split(',')
      if (values.length > 1 && values.every(value => /^[A-Za-z0-9._-]+$/.test(value))) {
        source += `(?:${values.map(escapeRegex).join('|')})`
        index = end + 1
        continue
      } else {
        source += String.raw`\{`
      }
    } else {
      source += escapeRegex(character)
    }
    index++
  }

  return new RegExp(`${source}$`).test(filename)
}

function escapeRegex (value) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`)
}

function getVitestConfigFile (command, repositoryRoot) {
  if (command.usesShell) {
    const match = String(command.shellCommand || '').match(/(?:^|\s)--config(?:=|\s+)([^\s]+)/)
    return match ? path.resolve(command.cwd, unquote(match[1])) : undefined
  }

  const argv = command.argv || []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--config' && argv[index + 1]) return path.resolve(command.cwd, argv[index + 1])
    if (argv[index].startsWith('--config=')) return path.resolve(command.cwd, argv[index].slice('--config='.length))
  }

  for (const filename of VITEST_CONFIG_FILENAMES) {
    const configFile = path.resolve(command.cwd, filename)
    if (isRepositoryFile(configFile, repositoryRoot)) return configFile
  }
}

function isRepositoryFile (filename, repositoryRoot) {
  return Boolean(getRepositoryFile(filename, repositoryRoot))
}

function getRepositoryFile (filename, repositoryRoot) {
  try {
    const entry = fs.lstatSync(filename)
    if (!entry.isFile() && !entry.isSymbolicLink()) return

    const physicalRoot = fs.realpathSync(repositoryRoot)
    const physicalFilename = fs.realpathSync(filename)
    const relative = path.relative(physicalRoot, physicalFilename)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return

    const stat = fs.statSync(physicalFilename)
    if (!stat.isFile()) return
    return { filename: physicalFilename, stat }
  } catch {}
}

function configEnablesTypecheck (filename, repositoryRoot) {
  const config = readRepositoryConfig(filename, repositoryRoot)
  return config ? TYPECHECK_ENABLED_PATTERN.test(config) : false
}

function readRepositoryConfig (filename, repositoryRoot) {
  const file = getRepositoryFile(filename, repositoryRoot)
  if (!file || file.stat.size > MAX_CONFIG_BYTES) return

  try {
    return fs.readFileSync(file.filename, 'utf8')
  } catch {}
}

/**
 * Reads a bounded test-runner config file.
 *
 * @param {string} filename config path
 * @returns {string|undefined} config text
 */
function readConfig (filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

function unquote (value) {
  return value.replaceAll(/^['"]|['"]$/g, '')
}

module.exports = { getCommandSuitabilityError }
