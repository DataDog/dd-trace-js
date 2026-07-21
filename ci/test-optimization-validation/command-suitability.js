'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { sanitizeString } = require('./redaction')
const { maskJavaScriptComments } = require('./source-text')

const MAX_CONFIG_BYTES = 512 * 1024
const MAX_STATIC_CONFIG_ARRAY_BYTES = 4096
const MAX_STATIC_CONFIG_PATTERNS = 32
const MAX_STATIC_CONFIG_PATTERN_BYTES = 256
const MAX_LOCAL_IMPORT_DEPTH = 4
const MAX_LOCAL_IMPORT_FILES = 24
const JEST_LOCAL_PATH_PATTERN = /(['"])(<rootDir>\/[^'"\r\n]+)\1/g
const JEST_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '--config',
  '--env',
  '--filter',
  '--globalSetup',
  '--globalTeardown',
  '--outputFile',
  '--reporters',
  '--resolver',
  '--runner',
  '--testEnvironment',
  '--testRegex',
])
const JEST_ROOT_DIR_PATTERN = /\brootDir\s*:\s*(['"])([^'"]+)\1/
const COMMON_NODE_EXPORT_CONDITIONS = new Set(['default', 'module-sync', 'node', 'node-addons'])
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
  const packageScriptError = getPackageScriptForwardingError(command, repositoryRoot)
  if (packageScriptError) return packageScriptError

  if (framework.framework === 'jest') {
    const missingInputError = getJestMissingLocalInputError(framework, repositoryRoot)
    if (missingInputError) return missingInputError
    if (label.includes('advanced-feature')) {
      const generatedPathError = getJestGeneratedPathError(command, framework, repositoryRoot)
      if (generatedPathError) return generatedPathError
    }
  }

  if (label === 'the selected test command') {
    const missingBuildError = getMissingSelfPackageBuildError(command, framework, repositoryRoot)
    if (missingBuildError) return missingBuildError
    const missingLocalModuleError = getMissingLocalModuleError(command, framework, repositoryRoot)
    if (missingLocalModuleError) return missingLocalModuleError
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
 * Identifies a selected source test whose own package entrypoint still requires a build.
 *
 * @param {object} command manifest command
 * @param {object} framework manifest framework
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getMissingSelfPackageBuildError (command, framework, repositoryRoot) {
  const packageJsonPath = framework.project?.packageJson
  const packageJsonSource = packageJsonPath && readRepositoryConfig(packageJsonPath, repositoryRoot)
  if (!packageJsonSource) return

  let packageJson
  try {
    packageJson = JSON.parse(packageJsonSource)
  } catch {
    return
  }
  if (typeof packageJson.name !== 'string') return

  const testFile = getSelectedTestFile(command, framework.project.root, repositoryRoot)
  if (!testFile) return
  const pending = [{ filename: testFile, chain: [testFile], depth: 0 }]
  const visited = new Set()
  while (pending.length > 0 && visited.size < MAX_LOCAL_IMPORT_FILES) {
    const current = pending.shift()
    if (visited.has(current.filename)) continue
    visited.add(current.filename)

    const source = readRepositoryConfig(current.filename, repositoryRoot)
    if (!source) continue
    for (const reference of getPackageModuleReferences(source, packageJson.name)) {
      const { condition, specifier } = reference
      const exportTargets = getPackageEntryTargets(packageJson, specifier, condition)
      if (exportTargets.length === 0) continue
      const entrypoints = exportTargets.map(target => path.resolve(path.dirname(packageJsonPath), target))
      const usableEntrypoints = entrypoints.filter(entrypoint => {
        return isPathInside(repositoryRoot, entrypoint) &&
          (isRepositoryFile(entrypoint, repositoryRoot) || isProducedBySetup(framework, entrypoint))
      })
      if (usableEntrypoints.length === 0) {
        const entrypoint = entrypoints[0]
        const chain = current.chain.map(filename => path.relative(repositoryRoot, filename) || '.').join(' -> ')
        if (!isPathInside(repositoryRoot, entrypoint)) {
          return `selects ${testFile}, whose bounded import chain ${chain} imports its own package subpath ` +
            `${JSON.stringify(specifier)}, but its entrypoint resolves outside the repository. Choose a source-based ` +
            'representative or correct the package export before asking for approval.'
        }
        return `selects ${testFile}, whose bounded import chain ${chain} imports its own package subpath ` +
          `${JSON.stringify(specifier)}, but entrypoint ${entrypoint} does not exist. Declare the reviewed build ` +
          `command and ${entrypoint} as its output, or choose a representative that runs from source before ` +
          'asking for approval.'
      }
      if (current.depth < MAX_LOCAL_IMPORT_DEPTH) {
        for (const entrypoint of usableEntrypoints) {
          if (isRepositoryFile(entrypoint, repositoryRoot)) {
            pending.push({
              filename: entrypoint,
              chain: [...current.chain, entrypoint],
              depth: current.depth + 1,
            })
          }
        }
      }
    }
    if (current.depth < MAX_LOCAL_IMPORT_DEPTH) {
      for (const { condition, specifier } of getRelativeModuleReferences(source)) {
        const resolution = resolveLocalModule(current.filename, specifier, condition, repositoryRoot)
        if (resolution.filename) {
          pending.push({
            filename: resolution.filename,
            chain: [...current.chain, resolution.filename],
            depth: current.depth + 1,
          })
        }
      }
    }
  }
}

/**
 * Returns the bounded selected test file from a structured command.
 *
 * @param {object} command manifest command
 * @param {string} projectRoot project root
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} selected test file
 */
function getSelectedTestFile (command, projectRoot, repositoryRoot) {
  if (command.usesShell) return
  const argv = command.argv || []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (JEST_OPTIONS_WITH_VALUE.has(value)) {
      index++
      continue
    }
    if (typeof value === 'string' && value.startsWith('-')) continue
    if (typeof value !== 'string') continue
    const filename = path.resolve(command.cwd || projectRoot, value)
    const inTestsDirectory = path.relative(projectRoot, filename).split(path.sep).includes('__tests__')
    if (!/(?:test|spec)\.[cm]?[jt]sx?$/.test(value) &&
      !(inTestsDirectory && /\.[cm]?[jt]sx?$/.test(value))) continue
    if (!isPathInside(repositoryRoot, filename)) continue
    try {
      const stat = fs.lstatSync(filename)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_CONFIG_BYTES) return filename
    } catch {}
  }
}

/**
 * Extracts self-package module specifiers from test source.
 *
 * @param {string} source test source
 * @param {string} packageName package name
 * @returns {{condition: 'import'|'require', specifier: string}[]} self-package module references
 */
function getPackageModuleReferences (source, packageName) {
  return getStaticModuleReferences(source).filter(({ specifier }) => {
    return specifier === packageName || specifier.startsWith(`${packageName}/`)
  })
}

/**
 * Returns a representative package entrypoint target.
 *
 * @param {object} packageJson parsed package metadata
 * @param {string} specifier self-package module specifier
 * @param {'import'|'require'} condition runtime module condition
 * @returns {string[]} entrypoint targets
 */
function getPackageEntryTargets (packageJson, specifier, condition) {
  const targets = []
  const subpath = specifier === packageJson.name ? '.' : `.${specifier.slice(packageJson.name.length)}`
  if (subpath === '.') {
    if (packageJson.exports === undefined) {
      collectRuntimeExportTargets(packageJson.main, targets, condition)
    } else {
      collectRuntimeExportTargets(packageJson.exports?.['.'] ?? packageJson.exports, targets, condition)
    }
  } else {
    const exportMatch = getPackageSubpathExport(packageJson.exports, subpath)
    if (exportMatch) {
      collectRuntimeExportTargets(exportMatch.value, targets, condition, exportMatch.wildcard)
    }
  }
  return [...new Set(targets)]
}

/**
 * Selects the most specific exact or wildcard package subpath export.
 *
 * @param {unknown} packageExports package exports map
 * @param {string} subpath requested package subpath
 * @returns {{value: unknown, wildcard?: string}|undefined} matching export and wildcard substitution
 */
function getPackageSubpathExport (packageExports, subpath) {
  if (!packageExports || typeof packageExports !== 'object' || Array.isArray(packageExports)) return
  if (Object.hasOwn(packageExports, subpath)) return { value: packageExports[subpath] }

  let selected
  for (const [key, value] of Object.entries(packageExports).slice(0, 32)) {
    const wildcardIndex = key.indexOf('*')
    if (wildcardIndex === -1 || key.includes('*', wildcardIndex + 1)) continue
    const prefix = key.slice(0, wildcardIndex)
    const suffix = key.slice(wildcardIndex + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) {
      continue
    }
    if (selected && (prefix.length < selected.prefixLength ||
      (prefix.length === selected.prefixLength && key.length <= selected.keyLength))) continue
    selected = {
      keyLength: key.length,
      prefixLength: prefix.length,
      value,
      wildcard: subpath.slice(prefix.length, subpath.length - suffix.length),
    }
  }
  return selected && { value: selected.value, wildcard: selected.wildcard }
}

/**
 * Collects a bounded set of strings from a package export condition tree.
 *
 * @param {unknown} value package export value
 * @param {string[]} targets collected package targets
 * @param {'import'|'require'} condition runtime module condition
 * @param {string} [wildcard] wildcard subpath substitution
 * @param {number} [depth] current nesting depth
 * @returns {void}
 */
function collectRuntimeExportTargets (value, targets, condition, wildcard, depth = 0) {
  if (targets.length >= 32 || depth > 6) return
  if (typeof value === 'string') {
    targets.push(wildcard === undefined ? value : value.replaceAll('*', wildcard))
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const nested of value.slice(0, 32)) {
      collectRuntimeExportTargets(nested, targets, condition, wildcard, depth + 1)
    }
    return
  }
  for (const [exportCondition, nested] of Object.entries(value).slice(0, 32)) {
    if (exportCondition === condition || COMMON_NODE_EXPORT_CONDITIONS.has(exportCondition)) {
      collectRuntimeExportTargets(nested, targets, condition, wildcard, depth + 1)
      break
    }
  }
}

/**
 * Identifies a bounded relative-import chain that reaches a missing local build artifact.
 *
 * @param {object} command manifest command
 * @param {object} framework manifest framework
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getMissingLocalModuleError (command, framework, repositoryRoot) {
  const testFile = getSelectedTestFile(command, framework.project.root, repositoryRoot)
  if (!testFile) return

  const pending = [{ filename: testFile, chain: [testFile], depth: 0 }]
  const visited = new Set()
  while (pending.length > 0 && visited.size < MAX_LOCAL_IMPORT_FILES) {
    const current = pending.shift()
    if (visited.has(current.filename)) continue
    visited.add(current.filename)

    const source = readRepositoryConfig(current.filename, repositoryRoot)
    if (!source) continue
    for (const { condition, specifier } of getRelativeModuleReferences(source)) {
      const resolution = resolveLocalModule(current.filename, specifier, condition, repositoryRoot)
      if (resolution.external || resolution.resolved) continue
      if (!resolution.filename) {
        if (isProducedBySetup(framework, resolution.target)) continue
        const chain = [...current.chain, resolution.target]
          .map(filename => path.relative(repositoryRoot, filename) || '.')
          .join(' -> ')
        return `selects ${testFile}, whose bounded local import chain ${chain} reaches missing module ` +
          `${resolution.target}. Declare the reviewed build command and its output, or choose a representative ` +
          'whose local module prerequisites already exist before asking for approval.'
      }
      if (current.depth < MAX_LOCAL_IMPORT_DEPTH) {
        pending.push({
          filename: resolution.filename,
          chain: [...current.chain, resolution.filename],
          depth: current.depth + 1,
        })
      }
    }
  }
}

/**
 * Extracts literal relative JavaScript module references.
 *
 * @param {string} source JavaScript or TypeScript source
 * @returns {{condition: 'import'|'require', specifier: string}[]} relative module references
 */
function getRelativeModuleReferences (source) {
  return getStaticModuleReferences(source)
    .filter(({ specifier }) => /^\.\.?\//.test(specifier))
}

/**
 * Extracts bounded literal module specifiers while skipping comments and unrelated strings.
 *
 * @param {string} source JavaScript or TypeScript source
 * @returns {{condition: 'import'|'require', specifier: string}[]} runtime module references
 */
function getStaticModuleReferences (source) {
  source = maskJavaScriptComments(source)
  const references = []
  visitConfigSource(source, ({ index }) => {
    let condition
    let match
    if (isTokenAt(source, index, 'require')) {
      condition = 'require'
      match = /^require\s*\(\s*(['"])([^'"\r\n]{1,512})\1/.exec(source.slice(index))
    } else if (isTokenAt(source, index, 'import')) {
      condition = 'import'
      const statement = source.slice(index, index + 1024)
      if (/^import\s+type\b/.test(statement)) return
      match = /^import\s*(?:\(\s*)?(['"])([^'"\r\n]{1,512})\1/.exec(statement) ||
        /^import\s+[^;]{0,900}?\bfrom\s*(['"])([^'"\r\n]{1,512})\1/.exec(statement)
    } else if (isTokenAt(source, index, 'export')) {
      condition = 'import'
      const statement = source.slice(index, index + 1024)
      if (/^export\s+type\b/.test(statement)) return
      match = /^export\s+[*{][^;]{0,900}?\bfrom\s*(['"])([^'"\r\n]{1,512})\1/.exec(statement)
    }
    if (!match) return
    const reference = { condition, specifier: match[2] }
    if (!references.some(entry => entry.condition === condition && entry.specifier === match[2])) {
      references.push(reference)
    }
  })
  return references
}

/**
 * Checks for an identifier token at one source offset.
 *
 * @param {string} source source text
 * @param {number} index candidate offset
 * @param {string} token token text
 * @returns {boolean} whether the token is present
 */
function isTokenAt (source, index, token) {
  return source.startsWith(token, index) &&
    !isIdentifierCharacter(source[index - 1]) &&
    !isIdentifierCharacter(source[index + token.length])
}

/**
 * Resolves one relative module without executing project resolution hooks.
 *
 * @param {string} importer importing source file
 * @param {string} specifier relative module specifier
 * @param {'import'|'require'} condition runtime module condition
 * @param {string} repositoryRoot repository root
 * @returns {{filename?: string, target: string, external?: boolean, resolved?: boolean}} bounded resolution
 */
function resolveLocalModule (importer, specifier, condition, repositoryRoot) {
  const target = path.resolve(path.dirname(importer), specifier)
  if (!isPathInside(repositoryRoot, target)) return { target, external: true }

  const extension = path.extname(target)
  if (extension && !/\.(?:[cm]?[jt]s|tsx|jsx|json)$/.test(extension)) {
    return isRepositoryFile(target, repositoryRoot) ? { target, resolved: true } : { target }
  }

  for (const candidate of getLocalModuleCandidates(target)) {
    if (!isPathInside(repositoryRoot, candidate)) continue
    if (path.extname(candidate) === '.node' && isRepositoryFile(candidate, repositoryRoot)) {
      return { target, resolved: true }
    }
    const source = readRepositoryConfig(candidate, repositoryRoot)
    if (source !== undefined) return { filename: candidate, target }
  }
  const packageResolution = resolveLocalPackageDirectory(target, condition, repositoryRoot)
  if (packageResolution) return packageResolution
  return { target }
}

/**
 * Resolves a bounded local package directory through package.json main or runtime exports.
 *
 * @param {string} target local directory target
 * @param {'import'|'require'} condition runtime module condition
 * @param {string} repositoryRoot repository root
 * @returns {{filename?: string, target: string, resolved?: boolean}|undefined} bounded resolution
 */
function resolveLocalPackageDirectory (target, condition, repositoryRoot) {
  const packageSource = readRepositoryConfig(path.join(target, 'package.json'), repositoryRoot)
  if (!packageSource) return

  let packageJson
  try {
    packageJson = JSON.parse(packageSource)
  } catch {
    return
  }
  const entryTargets = []
  if (packageJson.exports === undefined) {
    collectRuntimeExportTargets(packageJson.main, entryTargets, condition)
  } else {
    collectRuntimeExportTargets(packageJson.exports?.['.'] ?? packageJson.exports, entryTargets, condition)
  }
  for (const entryTarget of entryTargets) {
    const entrypoint = path.resolve(target, entryTarget)
    for (const candidate of getLocalModuleCandidates(entrypoint)) {
      if (!isPathInside(repositoryRoot, candidate)) continue
      if (path.extname(candidate) === '.node' && isRepositoryFile(candidate, repositoryRoot)) {
        return { target, resolved: true }
      }
      if (readRepositoryConfig(candidate, repositoryRoot) !== undefined) return { filename: candidate, target }
    }
  }
  if (entryTargets.length > 0) return { target: path.resolve(target, entryTargets[0]) }
}

/**
 * Returns conservative Node.js and TypeScript file candidates for a local module.
 *
 * @param {string} target unresolved module target
 * @returns {string[]} candidate files
 */
function getLocalModuleCandidates (target) {
  const extension = path.extname(target)
  const candidates = [target]
  if (!extension) {
    for (const suffix of ['.js', '.cjs', '.mjs', '.node', '.ts', '.cts', '.mts', '.tsx', '.jsx', '.json']) {
      candidates.push(`${target}${suffix}`, path.join(target, `index${suffix}`))
    }
  } else if (/\.[cm]?js$/.test(extension)) {
    const base = target.slice(0, -extension.length)
    for (const suffix of extension === '.mjs' ? ['.mts'] : extension === '.cjs' ? ['.cts'] : ['.ts', '.tsx']) {
      candidates.push(`${base}${suffix}`)
    }
  } else if (!/\.(?:[cm]?ts|tsx|jsx|json)$/.test(extension)) {
    return []
  }
  return candidates
}

/**
 * Returns an error for an exact local file referenced by Jest config but absent before execution.
 *
 * @param {object} framework manifest framework entry
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getJestMissingLocalInputError (framework, repositoryRoot) {
  for (const configFile of framework.project?.configFiles || []) {
    const config = readRepositoryConfig(configFile, repositoryRoot)
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

/**
 * Rejects Yarn separators that become a literal runner argument.
 *
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} forwarding error
 */
function getPackageScriptForwardingError (command, repositoryRoot) {
  const expansion = getPackageScriptExpansion(command, repositoryRoot)
  if (!expansion || expansion.packageManager !== 'yarn') return
  if (expansion.forwardedArgs[0] !== '--') return

  return `expands package script ${JSON.stringify(expansion.scriptName)} to ` +
    `${JSON.stringify(sanitizeString(expansion.effectiveCommand))}, including a literal extra "--" before the ` +
    'runner arguments. ' +
    `For ${expansion.packageManager}, append focused runner arguments directly after the script name, then render ` +
    'a fresh plan. Preserve the original package-manager wrapper for CI replay.'
}

/**
 * Returns a bounded readable package-script expansion for a structured command.
 *
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @returns {object|undefined} package script expansion
 */
function getPackageScriptExpansion (command, repositoryRoot) {
  if (command.usesShell || !Array.isArray(command.argv)) return
  const argv = command.argv
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
  if (!['npm', 'pnpm', 'yarn'].includes(packageManager) || argv[runIndex] !== 'run') return

  const scriptName = argv[runIndex + 1]
  if (typeof scriptName !== 'string') return
  const packageJsonSource = readRepositoryConfig(path.join(command.cwd, 'package.json'), repositoryRoot)
  if (!packageJsonSource) return
  let packageJson
  try {
    packageJson = JSON.parse(packageJsonSource)
  } catch {
    return
  }
  const script = packageJson.scripts?.[scriptName]
  if (typeof script !== 'string' || script.length > MAX_CONFIG_BYTES) return
  let forwardedArgs = argv.slice(runIndex + 2)
  if (packageManager === 'pnpm' && forwardedArgs[0] === '--') forwardedArgs = forwardedArgs.slice(1)
  return {
    effectiveCommand: [script, ...forwardedArgs].join(' '),
    forwardedArgs,
    packageManager,
    script,
    scriptName,
  }
}

/**
 * Rejects generated Jest paths excluded by statically readable collection rules.
 *
 * @param {object} framework manifest framework entry
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} generated path error
 */
function getJestGeneratedPathError (command, framework, repositoryRoot) {
  const rules = getJestCollectionRules(command, framework, repositoryRoot)
  if (!rules) return

  for (const file of framework.generatedTestStrategy?.files || []) {
    const relative = path.relative(rules.rootDir, file.path).split(path.sep).join('/')
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue
    const absolute = file.path.split(path.sep).join('/')
    if (rules.testMatch.length > 0 && !rules.testMatch.some(pattern => {
      return matchesGlob(relative, pattern.replaceAll('<rootDir>/', '')) ||
        matchesGlob(absolute, pattern.replaceAll('<rootDir>', rules.rootDir.split(path.sep).join('/')))
    })) {
      return `uses temporary test path ${file.path}, which does not match the literal Jest testMatch patterns in ` +
        `${rules.source}: ${rules.testMatch.join(', ')}. Choose a temporary path accepted by the selected Jest ` +
        'config before asking for approval.'
    }
    if (rules.testRegex.length > 0 && !rules.testRegex.some(pattern => matchesTestRegex(absolute, pattern))) {
      return `uses temporary test path ${file.path}, which does not match the literal Jest testRegex patterns in ` +
        `${rules.source}: ${rules.testRegex.join(', ')}. Choose a temporary path accepted by the selected Jest ` +
        'config before asking for approval.'
    }
  }
}

/**
 * Reads bounded literal Jest collection rules without executing configuration.
 *
 * @param {object} command generated test command
 * @param {object} framework manifest framework entry
 * @param {string} repositoryRoot repository root
 * @returns {object|undefined} collection rules
 */
function getJestCollectionRules (command, framework, repositoryRoot) {
  const explicitConfig = getJestConfigFile(command, repositoryRoot)
  if (explicitConfig) return getJestConfigCollectionRules(explicitConfig, repositoryRoot)

  for (const configFile of framework.project?.configFiles || []) {
    if (configFile === framework.project?.packageJson) continue
    const rules = getJestConfigCollectionRules(configFile, repositoryRoot)
    if (rules) return rules
  }

  const packageJsonPath = framework.project?.packageJson
  const packageJsonSource = packageJsonPath && readRepositoryConfig(packageJsonPath, repositoryRoot)
  if (packageJsonSource) {
    try {
      const jest = JSON.parse(packageJsonSource).jest
      const testMatch = getBoundedStringArray(jest?.testMatch)
      const testRegex = getBoundedStringArray(jest?.testRegex)
      if (testMatch.length > 0 || testRegex.length > 0) {
        return {
          rootDir: typeof jest.rootDir === 'string'
            ? path.resolve(path.dirname(packageJsonPath), jest.rootDir)
            : path.dirname(packageJsonPath),
          source: packageJsonPath,
          testMatch,
          testRegex,
        }
      }
    } catch {}
  }
}

/**
 * Reads collection rules from one selected Jest config without executing it.
 *
 * @param {string} configFile Jest config path
 * @param {string} repositoryRoot repository root
 * @returns {object|undefined} collection rules
 */
function getJestConfigCollectionRules (configFile, repositoryRoot) {
  const source = readRepositoryConfig(configFile, repositoryRoot)
  if (!source) return
  try {
    const config = JSON.parse(source)
    const testMatch = getBoundedStringArray(config?.testMatch)
    const testRegex = getBoundedStringArray(config?.testRegex)
    if (testMatch.length > 0 || testRegex.length > 0) {
      return {
        rootDir: typeof config.rootDir === 'string'
          ? path.resolve(path.dirname(configFile), config.rootDir)
          : path.dirname(configFile),
        source: configFile,
        testMatch,
        testRegex,
      }
    }
  } catch {}
  const testMatch = getLiteralPropertyArrayPatterns(source, 'testMatch')
  const testRegex = getLiteralRegexPatterns(source, 'testRegex')
  if (testMatch.length === 0 && testRegex.length === 0) return
  const rootDirMatch = source.match(JEST_ROOT_DIR_PATTERN)
  return {
    rootDir: rootDirMatch ? path.resolve(path.dirname(configFile), rootDirMatch[2]) : path.dirname(configFile),
    source: configFile,
    testMatch,
    testRegex,
  }
}

/**
 * Returns a repository-contained explicit Jest config selected by a structured command.
 *
 * @param {object} command generated test command
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} selected config file
 */
function getJestConfigFile (command, repositoryRoot) {
  if (command.usesShell) return
  const argv = command.argv || []
  for (let index = 0; index < argv.length; index++) {
    let filename
    if ((argv[index] === '--config' || argv[index] === '-c') && argv[index + 1]) filename = argv[index + 1]
    if (argv[index].startsWith('--config=')) filename = argv[index].slice('--config='.length)
    if (argv[index].startsWith('-c=')) filename = argv[index].slice('-c='.length)
    if (!filename) continue
    const configFile = path.resolve(command.cwd, filename)
    return isRepositoryFile(configFile, repositoryRoot) ? configFile : undefined
  }
}

/**
 * Normalizes a bounded string or string array.
 *
 * @param {unknown} value candidate config value
 * @returns {string[]} bounded strings
 */
function getBoundedStringArray (value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  if (values.length > MAX_STATIC_CONFIG_PATTERNS || values.some(entry => {
    return typeof entry !== 'string' || entry.length > MAX_STATIC_CONFIG_PATTERN_BYTES
  })) return []
  return values
}

/**
 * Extracts an unambiguous literal string-array property from config source.
 *
 * @param {string} source config source
 * @param {string} property property name
 * @returns {string[]} literal values
 */
function getLiteralPropertyArrayPatterns (source, property) {
  const candidates = []
  visitConfigSource(source, ({ index }) => {
    if (!isPropertyAt(source, index, property)) return
    const match = new RegExp(String.raw`^${property}\s*:\s*\[`).exec(source.slice(index))
    if (!match) return
    const patterns = readLiteralStringArray(source, index + match[0].length)
    if (patterns.length > 0) candidates.push(patterns)
  })
  if (candidates.length === 0) return []
  const first = JSON.stringify(candidates[0])
  return candidates.every(candidate => JSON.stringify(candidate) === first) ? candidates[0] : []
}

/**
 * Extracts bounded string or regular-expression literals from config source.
 *
 * @param {string} source config source
 * @param {string} property property name
 * @returns {string[]} literal regular-expression sources
 */
function getLiteralRegexPatterns (source, property) {
  source = maskJavaScriptComments(source)
  const patterns = []
  const expression = new RegExp(
    String.raw`\b${property}\s*:\s*(?:(["'])([^"'\r\n]{1,256})\1|\/((?:\\.|[^/\r\n]){1,256})\/[dgimsuvy]*)`,
    'g'
  )
  for (const match of source.matchAll(expression)) {
    patterns.push(match[2] || match[3])
    if (patterns.length === MAX_STATIC_CONFIG_PATTERNS) break
  }
  return patterns
}

/**
 * Tests one file against a bounded literal regular expression.
 *
 * @param {string} filename normalized filename
 * @param {string} source regular-expression source
 * @returns {boolean} whether the filename matches
 */
function matchesTestRegex (filename, source) {
  try {
    return new RegExp(source).test(filename)
  } catch {
    return false
  }
}

function getRepositoryYarnError (command, repositoryRoot) {
  if (command.usesShell || path.basename(command.argv?.[0] || '') !== 'yarn') return

  const releaseDirectory = path.join(repositoryRoot, '.yarn', 'releases')
  let releases
  try {
    releases = fs.readdirSync(releaseDirectory)
      .filter(filename => /^yarn-[^/]+\.cjs$/.test(filename))
      .sort()
  } catch {}
  if (releases?.length > 0) {
    const release = path.posix.join('.yarn', 'releases', releases[releases.length - 1])
    return `uses bare "yarn", but this repository pins ${release}. Use the structured command ` +
      `argv [process.execPath, "${release}", ...] so validation does not depend on an ambient Yarn shim.`
  }

  const packageManager = getRepositoryPackageManager(repositoryRoot)
  const match = /^yarn@(\d+)(?:\.|$)/.exec(packageManager || '')
  if (match && Number(match[1]) > 1) {
    return `uses bare "yarn", but package.json requires ${packageManager}. Use an explicit Corepack command ` +
      '`argv ["corepack", "yarn", ...]` or the repository-configured `yarnPath` so validation cannot resolve an ' +
      'incompatible ambient Yarn version.'
  }
}

/**
 * Reads the package-manager requirement declared by the repository root.
 *
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} declared package-manager requirement
 */
function getRepositoryPackageManager (repositoryRoot) {
  const packageJson = readRepositoryConfig(path.join(repositoryRoot, 'package.json'), repositoryRoot)
  if (!packageJson) return

  try {
    const value = JSON.parse(packageJson).packageManager
    return typeof value === 'string' ? value : undefined
  } catch {}
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
  return new RegExp(`^${getGlobRegexSource(normalized)}$`).test(filename)
}

/**
 * Converts the bounded glob subset used by Jest and Vitest collection patterns.
 *
 * @param {string} pattern glob pattern
 * @returns {string} regular-expression source
 */
function getGlobRegexSource (pattern) {
  let source = ''
  let index = 0

  while (index < pattern.length) {
    const character = pattern[index]
    if ((character === '?' || character === '+') && pattern[index + 1] === '(') {
      const end = pattern.indexOf(')', index + 2)
      const value = end === -1 ? '' : pattern.slice(index + 2, end)
      const alternatives = value.split('|')
      const safeOptional = character === '?' && alternatives.length === 1 && /^[A-Za-z0-9._*?-]+$/.test(value)
      const safeRepeated = character === '+' && alternatives.every(value => /^[A-Za-z0-9._-]+$/.test(value))
      if (safeOptional || safeRepeated) {
        const group = `(?:${alternatives.map(getGlobRegexSource).join('|')})`
        source += `${group}${character}`
        index = end + 1
        continue
      }
    }
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:[^/]+/)*'
        index += 3
      } else {
        source += '.*'
        index += 2
      }
      continue
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      const value = end === -1 ? '' : pattern.slice(index + 1, end)
      if (/^!?[A-Za-z0-9_-]+$/.test(value)) {
        source += `[${value.startsWith('!') ? `^${value.slice(1)}` : value}]`
        index = end + 1
        continue
      } else {
        source += String.raw`\[`
      }
    } else if (character === '{') {
      const end = pattern.indexOf('}', index + 1)
      const values = end === -1 ? [] : pattern.slice(index + 1, end).split(',')
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

  return source
}

function escapeRegex (value) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`)
}

/**
 * Checks whether a path is lexically inside a root.
 *
 * @param {string} root allowed root
 * @param {string} filename candidate path
 * @returns {boolean} whether the path is inside the root
 */
function isPathInside (root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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

function unquote (value) {
  return value.replaceAll(/^['"]|['"]$/g, '')
}

module.exports = { getCommandSuitabilityError, getPackageScriptExpansion }
