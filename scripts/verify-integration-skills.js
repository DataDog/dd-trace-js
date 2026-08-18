#!/usr/bin/env node

'use strict'

const {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} = require('node:fs')
const path = require('node:path')

const { Linter } = require('eslint')
const { get_encoding: getEncoding } = require('tiktoken')
const { parse: parseYaml } = require('yaml')

const INTEGRATION_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const MODES = new Set(['add', 'review', 'debug', 'serverless'])
const ORCHESTRION_TRAITS = new Set(['async', 'auto', 'callback', 'cjs-esm', 'orchestrion'])
const PLUGIN_BASE_DIRECTORY = 'packages/dd-trace/src/plugins/'
const PLUGIN_BASE_TRAITS = new Set([
  'cache',
  'client',
  'consumer',
  'database',
  'producer',
  'router',
  'server',
  'tracing',
])
const SOURCE_SUFFIXES = ['.js', '.cjs', '.mjs']
const TEST_SUFFIXES = ['.spec.js', '.spec.cjs', '.spec.mjs']
const TERMINAL_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const CHANNEL_ANCHOR_PATTERNS = [
  /\b(?:channel|tracingChannel)\s*\(/,
  /\bchannelName\s*:/,
  /\bstatic (?:get )?prefix\b/,
  /\.add(?:Trace)?(?:Bind|Subs?)\s*\(/,
  /\.(?:bindStore|publish|runStores|subscribe|unbindStore|unsubscribe)\s*\(/,
]
const TRAIT_KINDS = new Map([
  ['async', 'Async'],
  ['auto', 'Auto'],
  ['callback', 'Callback'],
])
const TRAITS = new Set([
  'async',
  'auto',
  'cache',
  'callback',
  'cjs-esm',
  'client',
  'consumer',
  'database',
  'orchestrion',
  'producer',
  'router',
  'server',
  'shimmer',
  'tracing',
])
const DISCOVERY_METADATA = new Map([
  ['.agents/skills/apm-integrations/agents/openai.yaml', 'apm-integrations'],
  ['.agents/skills/serverless-integrations/agents/openai.yaml', 'serverless-integrations'],
])
const TOTAL_TOKEN_BUDGET = 4000
const SKILL_TOKEN_BUDGETS = new Map([
  ['.agents/skills/apm-integrations/SKILL.md', 1400],
  ['.agents/skills/apm-integrations/references/orchestrion.md', 600],
  ['.agents/skills/apm-integrations/references/shimmer.md', 250],
  ['.agents/skills/apm-integrations/references/testing.md', 500],
  ['.agents/skills/serverless-integrations/SKILL.md', 800],
  ['.agents/skills/serverless-integrations/references/testing-guide.md', 350],
])
const SKILL_DIRECTORIES = [
  '.agents/skills/apm-integrations',
  '.agents/skills/serverless-integrations',
]
const CONCRETE_PATH_PREFIXES = [
  '.github/',
  'docs/',
  'index.d.ts',
  'index.d.v5.ts',
  'integration-tests/',
  'packages/',
]
const failures = []

/**
 * @typedef {object} Arguments
 * @property {string} [inspect]
 * @property {string} [packageName]
 * @property {'add' | 'review' | 'debug' | 'serverless'} mode
 * @property {string[]} traits
 * @property {boolean} json
 */

/**
 * @typedef {object} PackageRegistration
 * @property {string} name
 * @property {boolean} requested
 * @property {string} [hook]
 * @property {string} [plugin]
 * @property {{ value: string, source: string }} [version]
 */

/**
 * @typedef {object} InspectionTargets
 * @property {string} [instrumentation]
 * @property {string} [rewriter]
 * @property {string[]} plugins
 * @property {string[]} dependents
 * @property {string[]} tests
 */

/**
 * @typedef {object} InspectionRegistrations
 * @property {string[]} rewriter
 * @property {string[]} types
 * @property {string[]} v5Types
 * @property {string[]} docs
 * @property {string[]} docsTest
 * @property {string[]} codeowners
 * @property {string[]} workflows
 * @property {string[]} schemas
 */

/**
 * @typedef {object} RegistryRegistration
 * @property {string[]} requests
 * @property {string} source
 */

/** @typedef {import('estree').TemplateElement & { value: { cooked: string } }} StaticTemplateElement */

/** @typedef {import('estree').Node & { range: [number, number] }} RangedNode */

/** @typedef {{ request: string, node: import('estree').CallExpression }} StaticRequire */

/**
 * @typedef {object} IntegrationRegistrations
 * @property {Map<string, string>} hooks
 * @property {Map<string, string>} plugins
 * @property {string[]} pluginDirectories
 * @property {string[]} publicIds
 */

/**
 * @typedef {object} InspectionPacket
 * @property {string} integration
 * @property {string} mode
 * @property {string[]} traits
 * @property {InspectionTargets} targets
 * @property {PackageRegistration[]} packages
 * @property {{ contractSources: string[], channelAnchors: string[] }} evidence
 * @property {InspectionRegistrations} registrations
 * @property {{ integration: string, files: string[], registrations: string[] } | undefined} reference
 * @property {string[]} references
 */

/**
 * @param {string[]} arguments_
 * @returns {Arguments}
 */
function parseArguments (arguments_) {
  let inspect
  let packageName
  let mode = 'review'
  let json = false
  let traits = []

  for (let i = 0; i < arguments_.length; i++) {
    const argument = arguments_[i]
    if (argument === '--inspect') {
      inspect = arguments_[++i]
      if (!inspect) throw new Error('--inspect requires an integration id')
      if (!INTEGRATION_PATTERN.test(inspect)) {
        throw new Error('integration id must contain only lowercase letters, numbers, hyphens, or underscores')
      }
    } else if (argument === '--package') {
      packageName = arguments_[++i]
      if (!packageName) throw new Error('--package requires an npm package name')
    } else if (argument === '--mode') {
      mode = arguments_[++i]
      if (!MODES.has(mode)) throw new Error('mode must be add, review, debug, or serverless')
    } else if (argument === '--traits') {
      const value = arguments_[++i]
      if (!value) throw new Error('--traits requires a comma-separated value')
      const parsedTraits = value.split(',')
      for (const trait of parsedTraits) {
        if (!TRAITS.has(trait)) throw new Error(`unknown integration trait: ${trait}`)
      }
      traits = [...new Set(parsedTraits)]
    } else if (argument === '--json') {
      json = true
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      throw new Error(`unexpected argument: ${argument}`)
    }
  }

  return {
    inspect,
    packageName,
    mode,
    traits,
    json,
  }
}

let options
try {
  options = parseArguments(process.argv.slice(2))
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(escapeControlCharacters(error.message))
  process.exit(1)
}
const root = process.cwd()

/** @type {Map<string, RegistryRegistration> | undefined} */
let hookRegistrations

/** @type {Map<string, RegistryRegistration> | undefined} */
let pluginRegistrations

/** @type {Map<string, import('eslint').SourceCode | undefined>} */
const sourceCodes = new Map()

/**
 * @param {string} filename
 * @returns {string}
 */
function read (filename) {
  return readFileSync(path.join(root, filename), 'utf8')
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {void}
 */
function check (condition, message) {
  if (!condition) failures.push(message)
}

/**
 * @returns {void}
 */
function verifyInventory () {
  const expected = [...SKILL_TOKEN_BUDGETS.keys()].sort()
  const actual = []
  for (const directory of SKILL_DIRECTORIES) {
    actual.push(...listRelativeFiles(directory, ['.md']))
  }
  actual.sort()

  check(
    actual.length === expected.length && actual.every((filename, index) => filename === expected[index]),
    `expected exactly these skill files:\n${expected.map(filename => `  ${filename}`).join('\n')}`
  )
}

/**
 * @param {string} filename
 * @param {string} source
 * @returns {void}
 */
function verifyFrontmatter (filename, source) {
  if (!filename.endsWith('/SKILL.md')) return

  const match = source.match(/^---\n([\s\S]*?)\n---\n/)
  check(match !== null, `${filename}: missing YAML frontmatter`)
  if (!match) return

  let frontmatter
  try {
    frontmatter = parseYaml(match[1])
  } catch (error) {
    failures.push(`${filename}: invalid YAML frontmatter: ${error.message}`)
    return
  }

  const expectedName = path.basename(path.dirname(filename))
  check(frontmatter?.name === expectedName, `${filename}: name must be ${expectedName}`)
  check(
    typeof frontmatter?.description === 'string' && frontmatter.description.trim().length > 0,
    `${filename}: description must be a non-empty string`
  )
}

/**
 * @param {string} filename
 * @param {string} source
 * @returns {void}
 */
function verifyLinks (filename, source) {
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const destination = match[1].split('#', 1)[0]
    if (!destination || /^(?:https?:|mailto:)/.test(destination)) continue

    const linkedFile = path.resolve(root, path.dirname(filename), destination)
    check(existsSync(linkedFile), `${filename}: broken link to ${destination}`)
  }
}

/**
 * @param {string} filename
 * @param {string} source
 * @returns {void}
 */
function verifyConcretePaths (filename, source) {
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]
    if (candidate.includes('<') || !CONCRETE_PATH_PREFIXES.some(prefix => candidate.startsWith(prefix))) continue

    check(existsSync(path.join(root, candidate)), `${filename}: missing referenced path ${candidate}`)
  }
}

/**
 * @param {string} filename
 * @param {string} source
 * @returns {void}
 */
function verifyNpmCommands (filename, source) {
  let scripts
  for (const [, command] of source.matchAll(/\bnpm run ([\w:-]+)/g)) {
    if (scripts === undefined) {
      const packageFilename = path.join(root, 'package.json')
      const packageExists = existsSync(packageFilename)
      check(packageExists, `${filename}: cannot validate npm commands without package.json`)
      if (!packageExists) return

      try {
        scripts = JSON.parse(readFileSync(packageFilename, 'utf8')).scripts ?? {}
      } catch (error) {
        failures.push(`${filename}: cannot validate npm commands: ${error.message}`)
        return
      }
    }
    check(typeof scripts?.[command] === 'string', `${filename}: missing npm script ${command}`)
  }
}

/**
 * @returns {void}
 */
function verifyDiscoveryMetadata () {
  for (const [filename, skill] of DISCOVERY_METADATA) {
    const absoluteFilename = path.join(root, filename)
    if (!existsSync(absoluteFilename)) {
      failures.push(`missing discovery metadata ${filename}`)
      continue
    }

    let metadata
    try {
      metadata = parseYaml(read(filename))
    } catch (error) {
      failures.push(`${filename}: invalid YAML: ${error.message}`)
      continue
    }

    const { display_name: displayName, short_description: shortDescription, default_prompt: defaultPrompt } =
      metadata?.interface ?? {}
    check(typeof displayName === 'string' && displayName.length > 0, `${filename}: missing interface.display_name`)
    check(
      typeof shortDescription === 'string' && shortDescription.length >= 25 && shortDescription.length <= 64,
      `${filename}: interface.short_description must contain 25-64 characters`
    )
    check(
      typeof defaultPrompt === 'string' && defaultPrompt.includes(`$${skill}`),
      `${filename}: default_prompt must mention $${skill}`
    )
  }
}

/**
 * @param {string} filename
 * @param {RegExp} pattern
 * @param {string} description
 * @returns {void}
 */
function verifySourcePattern (filename, pattern, description) {
  const absoluteFilename = path.join(root, filename)
  const sourceExists = existsSync(absoluteFilename)
  check(sourceExists, `missing source contract file ${filename}`)
  if (!sourceExists) return

  check(pattern.test(read(filename)), `${filename}: ${description}`)
}

/**
 * @param {string} directory
 * @param {string[]} suffixes
 * @returns {string[]}
 */
function listRelativeFiles (directory, suffixes) {
  const files = []
  const absoluteDirectory = path.join(root, directory)
  if (!existsSync(absoluteDirectory)) return files

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(filename, suffixes))
    } else if (entry.isFile() && suffixes.some(suffix => entry.name.endsWith(suffix))) {
      files.push(filename.replaceAll(path.sep, '/'))
    }
  }

  return files.sort()
}

/**
 * @param {string} filename
 * @returns {string | undefined}
 */
function existingPath (filename) {
  return existsSync(path.join(root, filename)) ? filename : undefined
}

/**
 * @param {(string | undefined)[]} filenames
 * @returns {string[]}
 */
function compactPaths (filenames) {
  return [...new Set(filenames.filter(filename => filename !== undefined))]
}

/**
 * @param {string} filename
 * @param {string[]} values
 * @returns {string[]}
 */
function findLines (filename, values) {
  const absoluteFilename = path.join(root, filename)
  if (!existsSync(absoluteFilename)) return []

  const lines = readFileSync(absoluteFilename, 'utf8').split('\n')
  const matches = []
  for (let i = 0; i < lines.length; i++) {
    if (values.some(value => lines[i].includes(value))) matches.push(`${filename}:${i + 1}`)
  }
  return matches
}

/**
 * @param {string} filename
 * @param {string[]} integrations
 * @returns {string[]}
 */
function findWorkflowLines (filename, integrations) {
  const absoluteFilename = path.join(root, filename)
  if (!existsSync(absoluteFilename)) return []

  const lines = readFileSync(absoluteFilename, 'utf8').split('\n')
  const locations = []
  for (let i = 0; i < lines.length; i++) {
    const plugins = lines[i].match(/\bPLUGINS:\s*['"]?([a-z0-9_|-]+)/)?.[1]
    if (plugins?.split('|').some(plugin => integrations.includes(plugin))) {
      locations.push(`${filename}:${i + 1}`)
    }
  }
  return locations
}

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isFile (filename) {
  const absoluteFilename = path.join(root, filename)
  return existsSync(absoluteFilename) && lstatSync(absoluteFilename).isFile()
}

/**
 * @param {string} filename
 * @returns {import('eslint').SourceCode | undefined}
 */
function parseJavaScript (filename) {
  if (sourceCodes.has(filename)) return sourceCodes.get(filename)

  let sourceCode
  if (isFile(filename)) {
    const linter = new Linter()
    linter.verify(read(filename), {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'commonjs',
      },
    }, filename)
    sourceCode = linter.getSourceCode()
  }

  sourceCodes.set(filename, sourceCode)
  return sourceCode
}

/**
 * @param {import('estree').Node} node
 * @returns {string | undefined}
 */
function findStaticString (node) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined

  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = findStaticString(node.left)
    const right = findStaticString(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }

  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const quasi = /** @type {StaticTemplateElement} */ (node.quasis[0])
    return quasi.value.cooked
  }
}

/**
 * @param {import('estree').Property | import('estree').PropertyDefinition | import('estree').MethodDefinition |
 *   import('estree').MemberExpression} property
 * @returns {string | undefined}
 */
function findPropertyName (property) {
  const key = property.type === 'MemberExpression' ? property.property : property.key
  if (!property.computed && key.type === 'Identifier') return key.name
  return findStaticString(key)
}

/**
 * @param {import('estree').Node} node
 * @returns {{ name: string, value: string } | undefined}
 */
function findStaticClassProperty (node) {
  let name
  let value
  if (node.type === 'PropertyDefinition' && node.static) {
    name = findPropertyName(node)
    value = node.value ? findStaticString(node.value) : undefined
  } else if (node.type === 'MethodDefinition' && node.static && node.kind === 'get' &&
      node.value.body.body.length === 1) {
    const statement = node.value.body.body[0]
    name = findPropertyName(node)
    value = statement.type === 'ReturnStatement' && statement.argument
      ? findStaticString(statement.argument)
      : undefined
  }
  if (name && value !== undefined) return { name, value }
}

/**
 * @param {import('estree').Program} program
 * @returns {import('estree').ObjectExpression | undefined}
 */
function findExportedObject (program) {
  const objects = new Map()
  let exported
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration') continue

    for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier' && declaration.init?.type === 'ObjectExpression') {
        objects.set(declaration.id.name, declaration.init)
      }
    }
  }

  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression') continue

    const { left, right } = statement.expression
    if (left.type !== 'MemberExpression' || left.computed || left.object.type !== 'Identifier' ||
        left.object.name !== 'module' || left.property.type !== 'Identifier' || left.property.name !== 'exports') {
      continue
    }
    if (right.type === 'ObjectExpression') {
      exported = right
    } else if (right.type === 'Identifier') {
      exported = objects.get(right.name)
    } else {
      exported = undefined
    }
  }
  return exported
}

/**
 * @param {string} filename
 * @param {import('estree').Property} property
 * @returns {string}
 */
function findPropertyLocation (filename, property) {
  const location = /** @type {import('estree').SourceLocation} */ (property.loc)
  return `${filename}:${location.start.line}`
}

/**
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} [scope]
 * @returns {StaticRequire[]}
 */
function findStaticRequires (sourceCode, scope = sourceCode.ast) {
  const requires = []
  const [scopeStart, scopeEnd] = /** @type {RangedNode} */ (scope).range
  for (const step of sourceCode.traverse()) {
    if (step.type !== 'visit' || step.phase !== 1) continue

    const node = step.target
    const [start, end] = /** @type {RangedNode} */ (node).range
    if (start < scopeStart || end > scopeEnd || node.type !== 'CallExpression' ||
        node.callee.type !== 'Identifier' || node.callee.name !== 'require' ||
        node.arguments[0]?.type === 'SpreadElement') continue

    const request = node.arguments[0] && findStaticString(node.arguments[0])
    if (request !== undefined) requires.push({ request, node })
  }
  return requires
}

/**
 * @param {string} filename
 * @param {string} request
 * @returns {string | undefined}
 */
function resolveLocalSource (filename, request) {
  if (!request.startsWith('.')) return

  const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), request))
  if (target === '..' || target.startsWith('../')) return

  const candidates = [target]
  if (!path.posix.extname(target)) {
    for (const suffix of SOURCE_SUFFIXES) candidates.push(`${target}${suffix}`)
    for (const suffix of SOURCE_SUFFIXES) candidates.push(path.posix.join(target, `index${suffix}`))
  }

  return candidates.find(isFile)
}

/**
 * @returns {Map<string, RegistryRegistration>}
 */
function findHookRegistrations () {
  if (hookRegistrations) return hookRegistrations

  const filename = 'packages/datadog-instrumentations/src/helpers/hooks.js'
  const registry = parseJavaScript(filename)
  const object = registry && findExportedObject(registry.ast)
  hookRegistrations = new Map()
  if (!object) return hookRegistrations

  for (const property of object.properties) {
    if (property.type !== 'Property') continue

    const packageName = findPropertyName(property)
    const loader = property.value.type === 'ObjectExpression'
      ? property.value.properties.find(property => property.type === 'Property' &&
        findPropertyName(property) === 'fn')?.value
      : property.value
    if (!packageName || (loader?.type !== 'ArrowFunctionExpression' && loader?.type !== 'FunctionExpression')) continue

    hookRegistrations.set(packageName, {
      requests: findStaticRequires(registry, loader).map(({ request }) => request),
      source: findPropertyLocation(filename, property),
    })
  }
  return hookRegistrations
}

/**
 * @returns {Map<string, RegistryRegistration>}
 */
function findPluginRegistrations () {
  if (pluginRegistrations) return pluginRegistrations

  const filename = 'packages/dd-trace/src/plugins/index.js'
  const registry = parseJavaScript(filename)
  const object = registry && findExportedObject(registry.ast)
  pluginRegistrations = new Map()
  if (!object) return pluginRegistrations

  for (const property of object.properties) {
    if (property.type !== 'Property' || property.kind !== 'get') continue

    const packageName = findPropertyName(property)
    if (!packageName) continue

    pluginRegistrations.set(packageName, {
      requests: findStaticRequires(registry, property.value).map(({ request }) => request),
      source: findPropertyLocation(filename, property),
    })
  }
  return pluginRegistrations
}

/**
 * @param {string} integration
 * @returns {Map<string, string>}
 */
function findHookPackages (integration) {
  const filename = 'packages/datadog-instrumentations/src/helpers/hooks.js'
  const target = resolveLocalSource(filename, `../${integration}`)
  const packages = new Map()
  if (!target) return packages

  for (const [packageName, registration] of findHookRegistrations()) {
    if (registration.requests.some(request => resolveLocalSource(filename, request) === target)) {
      packages.set(packageName, registration.source)
    }
  }
  return packages
}

/**
 * @param {RegistryRegistration} registration
 * @returns {string | undefined}
 */
function findPluginDirectory (registration) {
  const filename = 'packages/dd-trace/src/plugins/index.js'
  for (const request of registration.requests) {
    const source = resolveLocalSource(filename, request)
    const match = source?.match(/^(packages\/datadog-plugin-[^/]+)\/src\//)
    if (match) return match[1]
  }
}

/**
 * @param {string} integration
 * @returns {IntegrationRegistrations}
 */
function findIntegrationRegistrations (integration) {
  const hooks = findHookPackages(integration)
  const plugins = new Map()
  const pluginDirectories = new Set()
  const defaultDirectory = `packages/datadog-plugin-${integration}`
  if (existsSync(path.join(root, defaultDirectory))) pluginDirectories.add(defaultDirectory)

  for (const [name, registration] of findPluginRegistrations()) {
    const directory = findPluginDirectory(registration)
    if (!directory || (directory !== defaultDirectory && !hooks.has(name))) continue

    plugins.set(name, registration.source)
    pluginDirectories.add(directory)
  }

  const directories = [...pluginDirectories].sort()
  return {
    hooks,
    plugins,
    pluginDirectories: directories,
    publicIds: [...new Set([integration, ...directories.map(directory =>
      path.basename(directory).slice('datadog-plugin-'.length))])],
  }
}

/**
 * @param {string} integration
 * @returns {string[]}
 */
function findRewriterRegistrations (integration) {
  const filename = 'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js'
  const target = resolveLocalSource(filename, `./${integration}`)
  const sourceCode = parseJavaScript(filename)
  if (!target || !sourceCode) return []

  const registrations = []
  for (const { request, node } of findStaticRequires(sourceCode)) {
    if (resolveLocalSource(filename, request) !== target) continue

    const location = /** @type {import('estree').SourceLocation} */ (node.loc)
    registrations.push(`${filename}:${location.start.line}`)
  }
  return registrations
}

/**
 * @param {string} packageName
 * @returns {{ value: string, source: string } | undefined}
 */
function findLatestVersion (packageName) {
  const filename = 'packages/dd-trace/test/plugins/versions/package.json'
  if (!isFile(filename)) return

  const dependencies = JSON.parse(read(filename)).dependencies ?? {}
  const value = dependencies[packageName]
  const source = findLines(filename, [`"${packageName}"`])[0]
  if (typeof value === 'string' && source) return { value, source }
}

/**
 * @param {string} integration
 * @param {IntegrationRegistrations} registrations
 * @param {string | undefined} packageName
 * @returns {PackageRegistration[]}
 */
function findPackages (integration, registrations, packageName) {
  const { hooks, plugins } = registrations
  const names = new Set(hooks.keys())
  for (const name of plugins.keys()) names.add(name)
  if (packageName) names.add(packageName)
  if (names.size === 0) names.add(integration)

  const packages = []
  for (const name of [...names].sort()) {
    packages.push({
      name,
      requested: name === packageName,
      hook: hooks.get(name),
      plugin: plugins.get(name),
      version: findLatestVersion(name),
    })
  }
  return packages
}

/**
 * @param {string[]} sources
 * @param {string[]} pluginDirectories
 * @returns {string[]}
 */
function findContractSources (sources, pluginDirectories) {
  const queue = [...sources]
  const visited = new Set(sources)
  const contracts = new Set()

  for (let i = 0; i < queue.length; i++) {
    const source = queue[i]
    const sourceCode = parseJavaScript(source)
    if (!sourceCode) continue

    for (const { request } of findStaticRequires(sourceCode)) {
      const dependency = resolveLocalSource(source, request)
      if (!dependency || visited.has(dependency)) continue

      const isBase = dependency.startsWith(PLUGIN_BASE_DIRECTORY) &&
        !dependency.slice(PLUGIN_BASE_DIRECTORY.length).includes('/')
      const isCrossPlugin = dependency.startsWith('packages/datadog-plugin-') &&
        !pluginDirectories.some(directory => dependency.startsWith(`${directory}/`))
      if (!isBase && !isCrossPlugin) continue

      visited.add(dependency)
      contracts.add(dependency)
      queue.push(dependency)
    }
  }
  return [...contracts].sort()
}

/**
 * @param {string} trait
 * @returns {string | undefined}
 */
function findTraitSource (trait) {
  const filename = trait === 'router'
    ? 'packages/datadog-plugin-router/src/index.js'
    : `packages/dd-trace/src/plugins/${trait}.js`
  return PLUGIN_BASE_TRAITS.has(trait) ? existingPath(filename) : undefined
}

/**
 * @param {string[]} pluginDirectories
 * @returns {string[]}
 */
function findPluginDependents (pluginDirectories) {
  if (pluginDirectories.length === 0) return []

  const dependents = []
  const selectedDirectories = new Set(pluginDirectories)

  for (const entry of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('datadog-plugin-')) continue

    const directory = `packages/${entry.name}`
    if (selectedDirectories.has(directory)) continue

    for (const filename of listRelativeFiles(`${directory}/src`, SOURCE_SUFFIXES)) {
      const sourceCode = parseJavaScript(filename)
      if (!sourceCode) continue

      const requires = findStaticRequires(sourceCode)
      if (requires.some(({ request }) => {
        const source = resolveLocalSource(filename, request)
        return source && pluginDirectories.some(selected => source.startsWith(`${selected}/src/`))
      })) {
        dependents.push(filename)
      }
    }
  }
  return dependents.sort()
}

/**
 * @param {string[]} pluginDirectories
 * @param {'src' | 'test'} subdirectory
 * @param {string[]} suffixes
 * @returns {string[]}
 */
function listPluginFiles (pluginDirectories, subdirectory, suffixes) {
  const files = []
  for (const directory of pluginDirectories) {
    files.push(...listRelativeFiles(`${directory}/${subdirectory}`, suffixes))
  }
  return files.sort()
}

/**
 * @param {string[]} filenames
 * @returns {string[]}
 */
function findChannelAnchors (filenames) {
  const anchors = []
  for (const filename of new Set(filenames)) {
    const lines = read(filename).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart()
      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue

      if (CHANNEL_ANCHOR_PATTERNS.some(pattern => pattern.test(line))) {
        anchors.push(`${filename}:${i + 1}`)
      }
    }
  }
  return anchors
}

/**
 * @param {string[]} integrations
 * @returns {string[]}
 */
function findCodeownersCoverage (integrations) {
  const filename = '.github/CODEOWNERS'
  if (!isFile(filename)) return []

  const locations = []
  const lines = read(filename).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const pattern = lines[i].trim().split(/\s+/, 1)[0]
    if (integrations.some(integration => pattern.includes(`datadog-plugin-${integration}/`)) ||
        pattern === '/packages/datadog-plugin-*/') {
      locations.push(`${filename}:${i + 1}`)
    }
  }
  return locations
}

/**
 * @param {string[]} ids
 */
function findRegistrationLedger (ids) {
  return {
    types: findLines('index.d.ts', ids.map(id => `"${id}"`)),
    v5Types: findLines('index.d.v5.ts', ids.map(id => `"${id}"`)),
    docs: findLines('docs/API.md', ids.flatMap(id => [`id="${id}"`, `[${id}]`])),
    docsTest: findLines('docs/test.ts', ids.flatMap(id => [`use('${id}'`, `use("${id}"`])),
    codeowners: findCodeownersCoverage(ids),
    workflows: [
      ...findWorkflowLines('.github/workflows/apm-integrations.yml', ids),
      ...findWorkflowLines('.github/workflows/serverless.yml', ids),
    ],
  }
}

/**
 * @param {string[]} filenames
 * @param {string[]} publicIds
 * @returns {string[]}
 */
function findSchemaRegistrations (filenames, publicIds) {
  const types = new Set()
  const kinds = new Set()
  const ids = new Set(publicIds)
  const operations = new Set()
  const coordinates = new Map([['type', types], ['kind', kinds], ['id', ids], ['operation', operations]])

  for (const filename of filenames) {
    const sourceCode = parseJavaScript(filename)
    if (!sourceCode) continue

    for (const step of sourceCode.traverse()) {
      if (step.type !== 'visit' || step.phase !== 1) continue

      const node = step.target
      const coordinate = findStaticClassProperty(node)
      if (coordinate) {
        coordinates.get(coordinate.name)?.add(coordinate.value)
        continue
      }
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' ||
          (findPropertyName(node.callee) !== 'operationName' && findPropertyName(node.callee) !== 'serviceName') ||
          node.arguments[0]?.type !== 'ObjectExpression') continue

      for (const property of node.arguments[0].properties) {
        if (property.type !== 'Property') continue

        const name = findPropertyName(property)
        const value = findStaticString(property.value)
        if (name !== 'operation' && value !== undefined) coordinates.get(name)?.add(value)
      }
    }
  }

  const schemaIds = new Set(ids)
  for (const id of ids) {
    for (const operation of operations) schemaIds.add(`${id}.${operation}`)
  }

  const locations = []
  for (const version of ['v0', 'v1']) {
    for (const type of [...types].sort()) {
      const filename = `packages/dd-trace/src/service-naming/schemas/${version}/${type}.js`
      const sourceCode = parseJavaScript(filename)
      const schema = sourceCode && findExportedObject(sourceCode.ast)
      if (!schema) continue

      for (const kindProperty of schema.properties) {
        if (kindProperty.type !== 'Property' || kindProperty.value.type !== 'ObjectExpression' ||
            !kinds.has(findPropertyName(kindProperty))) continue

        for (const idProperty of kindProperty.value.properties) {
          if (idProperty.type === 'Property' && schemaIds.has(findPropertyName(idProperty))) {
            locations.push(findPropertyLocation(filename, idProperty))
          }
        }
      }
    }
  }
  return locations
}

/**
 * @param {string} mode
 * @param {string[]} traits
 * @param {boolean} hasRewriter
 * @returns {string[]}
 */
function findReferences (mode, traits, hasRewriter) {
  const references = []

  if (hasRewriter || traits.some(trait => ORCHESTRION_TRAITS.has(trait))) {
    references.push('.agents/skills/apm-integrations/references/orchestrion.md')
  }
  if (traits.includes('shimmer')) {
    references.push('.agents/skills/apm-integrations/references/shimmer.md')
  }
  for (const trait of traits) {
    const filename = findTraitSource(trait)
    if (filename) references.push(filename)
  }
  references.push(mode === 'serverless'
    ? '.agents/skills/serverless-integrations/references/testing-guide.md'
    : '.agents/skills/apm-integrations/references/testing.md')

  return references
}

/**
 * @param {string} integration
 * @param {string} mode
 * @param {string[]} traits
 * @returns {{ integration: string, files: string[], registrations: string[] } | undefined}
 */
function findClosestReference (integration, mode, traits) {
  if (traits.length === 0) return

  const isServerless = mode === 'serverless'
  const isShimmer = traits.includes('shimmer')
  const directory = isShimmer || isServerless
    ? 'packages/datadog-instrumentations/src'
    : 'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations'
  const requestedBase = traits.find(trait => PLUGIN_BASE_TRAITS.has(trait))
  const requestedSource = requestedBase ? findTraitSource(requestedBase) : undefined
  let closest
  let closestScore = 0

  for (const filename of listRelativeFiles(directory, SOURCE_SUFFIXES)) {
    if ((isShimmer || isServerless) && path.posix.dirname(filename) !== directory) continue

    const candidate = path.basename(filename, path.extname(filename))
    if (candidate === 'index' || candidate === integration) continue

    const source = read(filename)
    if (isServerless) {
      if (findHookPackages(candidate).size === 0) continue
    } else if (isShimmer
      ? !source.includes('datadog-shimmer') || findHookPackages(candidate).size === 0
      : findRewriterRegistrations(candidate).length === 0) continue

    const moduleName = source.match(/name:\s*['"]([^'"]+)['"]/)?.[1] ?? candidate
    const registrations = findIntegrationRegistrations(candidate)
    const pluginSources = listPluginFiles(registrations.pluginDirectories, 'src', SOURCE_SUFFIXES)
    const contractSources = findContractSources(pluginSources, registrations.pluginDirectories)
    let hasServerlessType = false
    let hasRequestedKind = false
    if (isServerless) {
      for (const pluginSource of pluginSources) {
        const sourceCode = parseJavaScript(pluginSource)
        if (!sourceCode) continue

        for (const step of sourceCode.traverse()) {
          if (step.type !== 'visit' || step.phase !== 1) continue

          const coordinate = findStaticClassProperty(step.target)
          if (coordinate?.name === 'type' && coordinate.value === 'serverless') hasServerlessType = true
          if (coordinate?.name === 'kind' && coordinate.value === requestedBase) hasRequestedKind = true
        }
      }
      if (!hasServerlessType) continue
    }

    let score = isServerless || isShimmer || traits.includes('orchestrion') ? 1 : 0
    if (requestedSource && contractSources.includes(requestedSource)) score += 8
    if (hasRequestedKind) score += 8
    if (traits.includes('cjs-esm') && /(?:cjs|commonjs)/i.test(source) && /esm/i.test(source)) score += 4
    for (const [trait, kind] of TRAIT_KINDS) {
      if (traits.includes(trait) && (
        source.includes(`kind: '${kind}'`) || source.includes(`kind: "${kind}"`)
      )) score += 2
    }
    if (score <= closestScore) continue

    closestScore = score
    const tests = listPluginFiles(registrations.pluginDirectories, 'test', TEST_SUFFIXES)
    const pluginIndex = existingPath(`packages/datadog-plugin-${candidate}/src/index.js`) ??
      pluginSources.find(filename => path.basename(filename) === 'index.js')
    const integrationTest = existingPath(`packages/datadog-plugin-${candidate}/test/index.spec.js`) ??
      tests.find(filename => path.basename(filename) === 'index.spec.js')
    const ledger = findRegistrationLedger(registrations.publicIds)
    closest = {
      integration: candidate,
      files: compactPaths([
        filename,
        resolveLocalSource('packages/datadog-instrumentations/src/helpers/hooks.js', `../${candidate}`),
        pluginIndex ?? pluginSources[0],
        integrationTest ?? tests[0],
      ]),
      registrations: compactPaths([
        registrations.hooks.get(moduleName),
        registrations.plugins.get(moduleName),
        findLatestVersion(moduleName)?.source,
        ...Object.values(ledger).flat(),
      ]),
    }
  }

  return closest
}

/**
 * @param {string} integration
 * @param {string | undefined} packageName
 * @param {string} mode
 * @param {string[]} traits
 * @returns {InspectionPacket}
 */
function inspectIntegration (integration, packageName, mode, traits) {
  const instrumentation = resolveLocalSource(
    'packages/datadog-instrumentations/src/helpers/hooks.js',
    `../${integration}`
  )
  const rewriter = resolveLocalSource(
    'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js',
    `./${integration}`
  )
  const packageRegistrations = findIntegrationRegistrations(integration)
  const plugins = listPluginFiles(packageRegistrations.pluginDirectories, 'src', SOURCE_SUFFIXES)
  const dependents = findPluginDependents(packageRegistrations.pluginDirectories)
  const tests = listPluginFiles(packageRegistrations.pluginDirectories, 'test', TEST_SUFFIXES)
  const contractSources = findContractSources(plugins, packageRegistrations.pluginDirectories)
  const { publicIds } = packageRegistrations
  const ledger = findRegistrationLedger(publicIds)
  const channelSources = compactPaths([
    instrumentation,
    rewriter,
    ...plugins,
    ...dependents,
    ...contractSources,
  ])
  return {
    integration,
    mode,
    traits,
    targets: {
      instrumentation,
      rewriter,
      plugins,
      dependents,
      tests,
    },
    packages: findPackages(integration, packageRegistrations, packageName),
    evidence: {
      contractSources,
      channelAnchors: findChannelAnchors(channelSources),
    },
    registrations: {
      rewriter: findRewriterRegistrations(integration),
      ...ledger,
      schemas: findSchemaRegistrations([...plugins, ...contractSources], publicIds),
    },
    reference: findClosestReference(integration, mode, traits),
    references: findReferences(mode, traits, rewriter !== undefined),
  }
}

/**
 * @param {string} character
 * @returns {string}
 */
function escapeControlCharacter (character) {
  let escaped = ''
  for (let i = 0; i < character.length; i++) {
    escaped += String.raw`\u${character.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return escaped
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeControlCharacters (value) {
  return value.replaceAll(TERMINAL_CONTROL_PATTERN, escapeControlCharacter)
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeJsonControlCharacters (value) {
  return value.replaceAll(TERMINAL_CONTROL_PATTERN, character => {
    return character.charCodeAt(0) <= 0x1F ? character : escapeControlCharacter(character)
  })
}

/**
 * @param {InspectionPacket} packet
 * @returns {string}
 */
function renderInspection (packet) {
  const lines = [
    `Integration: ${escapeControlCharacters(packet.integration)}`,
    `Mode: ${packet.mode}${packet.traits.length ? `; traits: ${packet.traits.join(', ')}` : ''}`,
    'Targets:',
    `  instrumentation: ${packet.targets.instrumentation
      ? escapeControlCharacters(packet.targets.instrumentation)
      : 'missing'}`,
    `  rewriter: ${packet.targets.rewriter ? escapeControlCharacters(packet.targets.rewriter) : 'missing'}`,
    `  plugin sources: ${packet.targets.plugins.length}`,
    `  dependent sources: ${packet.targets.dependents.length}`,
    `  tests: ${packet.targets.tests.length}`,
    'Plugin sources:',
    ...(packet.targets.plugins.length ? packet.targets.plugins : ['none'])
      .map(filename => `  ${escapeControlCharacters(filename)}`),
    'Dependent sources:',
    ...(packet.targets.dependents.length ? packet.targets.dependents : ['none'])
      .map(filename => `  ${escapeControlCharacters(filename)}`),
    'Packages:',
  ]

  for (const registration of packet.packages) {
    const candidate = registration.hook || registration.plugin || registration.version ? '' : ' (candidate)'
    lines.push(`  ${escapeControlCharacters(registration.name)}${candidate}`)
    if (registration.hook) lines.push(`    hook: ${escapeControlCharacters(registration.hook)}`)
    if (registration.plugin) lines.push(`    plugin: ${escapeControlCharacters(registration.plugin)}`)
    if (registration.version) {
      lines.push(
        `    latest tested: ${escapeControlCharacters(registration.version.value)} ` +
        `(${escapeControlCharacters(registration.version.source)})`
      )
    }
  }
  lines.push(
    'Contract sources:',
    ...(packet.evidence.contractSources.length ? packet.evidence.contractSources : ['none'])
      .map(filename => `  ${escapeControlCharacters(filename)}`),
    'Channel anchors:',
    ...(packet.evidence.channelAnchors.length ? packet.evidence.channelAnchors : ['none'])
      .map(filename => `  ${escapeControlCharacters(filename)}`),
    'Registrations:',
  )

  for (const [name, value] of Object.entries(packet.registrations)) {
    lines.push(`  ${name}: ${value.map(escapeControlCharacters).join(', ') || 'missing'}`)
  }
  if (packet.reference) {
    lines.push(
      `Closest current reference: ${escapeControlCharacters(packet.reference.integration)}`,
      '  files:',
      ...packet.reference.files.map(filename => `    ${escapeControlCharacters(filename)}`),
      '  registrations:',
      ...packet.reference.registrations.map(filename => `    ${escapeControlCharacters(filename)}`)
    )
  }
  lines.push(
    'Read next:',
    ...packet.references.map(filename => `  ${escapeControlCharacters(filename)}`)
  )
  return lines.join('\n')
}

/**
 * @param {string} link
 * @param {string} target
 * @returns {void}
 */
function verifySymlink (link, target) {
  const absoluteLink = path.join(root, link)
  const linkExists = existsSync(absoluteLink)
  check(linkExists, `missing discovery link ${link}`)
  if (!linkExists) return

  const isSymbolicLink = lstatSync(absoluteLink).isSymbolicLink()
  check(isSymbolicLink, `${link}: must be a symbolic link`)
  if (!isSymbolicLink) return

  check(readlinkSync(absoluteLink) === target, `${link}: must point to ${target}`)
}

/**
 * @returns {string | undefined}
 */
function verifySourceContracts () {
  verifySourcePattern(
    'packages/dd-trace/src/plugins/tracing.js',
    /startSpan \(name, options = \{\}, enterOrCtx = true\)/,
    'TracingPlugin.startSpan signature changed; update the skill contract'
  )
  verifySourcePattern(
    'packages/dd-trace/src/plugins/cache.js',
    /startSpan \(options, ctx\)/,
    'CachePlugin.startSpan signature changed; update the skill contract'
  )
  for (const role of ['producer', 'consumer']) {
    verifySourcePattern(
      `packages/dd-trace/src/plugins/${role}.js`,
      /startSpan \(options, enterOrCtx\)/,
      `${role} startSpan signature changed; update the skill contract`
    )
  }
  verifySourcePattern(
    'packages/datadog-instrumentations/src/helpers/hooks.js',
    /\besmFirst\s*:/,
    'the ESM-first hook contract changed; update the integration workflow'
  )
  verifySourcePattern(
    'packages/datadog-instrumentations/src/helpers/hooks.js',
    /\bserverless\s*:/,
    'the serverless hook contract changed; update the integration workflow'
  )
  verifySourcePattern(
    'integration-tests/helpers/index.js',
    /'destructure' \| 'direct' \| 'namespace'/,
    'named export binding modes changed; update the testing reference'
  )

  const lambdaDirectory = path.join(root, 'packages/dd-trace/src/lambda')
  check(existsSync(lambdaDirectory), 'missing source contract directory packages/dd-trace/src/lambda')
  for (const filename of listRelativeFiles('packages/dd-trace/src/lambda', ['.js'])) {
    check(!/\bstartSpan\s*\(/.test(read(filename)), `${filename}: Lambda now starts a span`)
  }

  verifySymlink('.claude/skills/apm-integrations', '../../.agents/skills/apm-integrations')
  verifySymlink('.claude/skills/serverless-integrations', '../../.agents/skills/serverless-integrations')
  verifySourcePattern(
    '.github/CODEOWNERS',
    /^\/\.agents\/skills\/apm-integrations\/ @DataDog\/apm-idm-js$/m,
    'missing APM skill ownership'
  )
  verifySourcePattern(
    '.github/CODEOWNERS',
    /^\/\.agents\/skills\/serverless-integrations\/ @DataDog\/serverless-aws @DataDog\/apm-serverless$/m,
    'missing serverless skill ownership'
  )

  const packageLockPath = 'vendor/package-lock.json'
  if (!existsSync(path.join(root, packageLockPath))) {
    failures.push(`missing source contract file ${packageLockPath}`)
    return
  }

  let packageLock
  try {
    packageLock = JSON.parse(read(packageLockPath))
  } catch (error) {
    failures.push(`${packageLockPath}: invalid JSON: ${error.message}`)
    return
  }
  const transformer = packageLock.packages?.['node_modules/@apm-js-collab/code-transformer']
  check(typeof transformer?.version === 'string', `${packageLockPath}: missing code-transformer version`)
  return transformer?.version
}

/**
 * @returns {{ filename: string, tokens: number, budget: number }[]}
 */
function verifySkillDocuments () {
  const encoding = getEncoding('o200k_base')
  const results = []
  let total = 0

  try {
    for (const [filename, budget] of SKILL_TOKEN_BUDGETS) {
      const absoluteFilename = path.join(root, filename)
      if (!existsSync(absoluteFilename)) {
        failures.push(`missing skill file ${filename}`)
        continue
      }

      const source = read(filename)
      const tokens = encoding.encode(source).length
      total += tokens
      results.push({ filename, tokens, budget })

      check(tokens <= budget, `${filename}: ${tokens} tokens exceeds its ${budget}-token budget`)
      check(!/\bv?\d+\.\d+(?:\.\d+)?\b/.test(source), `${filename}: store no version pins; derive them from source`)
      verifyFrontmatter(filename, source)
      verifyLinks(filename, source)
      verifyConcretePaths(filename, source)
      verifyNpmCommands(filename, source)
    }
  } finally {
    encoding.free()
  }

  check(
    total <= TOTAL_TOKEN_BUDGET,
    `integration skills: ${total} tokens exceeds the ${TOTAL_TOKEN_BUDGET}-token budget`
  )
  return results
}

if (options.inspect) {
  const packet = inspectIntegration(
    options.inspect,
    options.packageName,
    options.mode,
    options.traits
  )
  const output = options.json
    ? escapeJsonControlCharacters(JSON.stringify(packet, undefined, 2))
    : renderInspection(packet)
  // eslint-disable-next-line no-console
  console.log(output)
} else {
  verifyInventory()
  verifyDiscoveryMetadata()
  const results = verifySkillDocuments()
  const transformerVersion = verifySourceContracts()

  if (failures.length) {
    const messages = failures.map(failure => `- ${escapeControlCharacters(failure)}`).join('\n')
    // eslint-disable-next-line no-console
    console.error(`Integration skill verification failed:\n\n${messages}`)
    process.exitCode = 1
  } else {
    const total = results.reduce((sum, result) => sum + result.tokens, 0)
    // eslint-disable-next-line no-console
    console.log(`Integration skills: ${total} / ${TOTAL_TOKEN_BUDGET} tokens (o200k_base)`)
    for (const { filename, tokens, budget } of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${tokens} / ${budget}  ${escapeControlCharacters(filename)}`)
    }
    // eslint-disable-next-line no-console
    console.log(
      `Vendored code transformer: ${escapeControlCharacters(transformerVersion)} ` +
      '(derived from vendor/package-lock.json)'
    )
  }
}
