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

const { get_encoding: getEncoding } = require('tiktoken')
const { parse: parseYaml } = require('yaml')

const INTEGRATION_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const MODES = new Set(['add', 'review', 'debug', 'serverless'])
const ORCHESTRION_TRAITS = new Set(['async', 'auto', 'callback', 'cjs-esm', 'orchestrion'])
const PLUGIN_CONTRACT_PATTERNS = new Map([
  ['type', /static type = ['"]([^'"]+)['"]/],
  ['kind', /static kind = ['"]([^'"]+)['"]/],
  ['operation', /static operation = ['"]([^'"]+)['"]/],
])
const PLUGIN_BASE_TRAITS = new Set(['cache', 'client', 'consumer', 'database', 'producer', 'server', 'tracing'])
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
 * @property {string} root
 * @property {string} [inspect]
 * @property {string} [packageName]
 * @property {'add' | 'review' | 'debug' | 'serverless'} mode
 * @property {string[]} traits
 * @property {boolean} json
 */

/**
 * @typedef {object} InspectionPacket
 * @property {string} integration
 * @property {string} package
 * @property {string} mode
 * @property {string[]} traits
 * @property {{ instrumentation?: string, rewriter?: string, plugin?: string, tests: string[] }} targets
 * @property {{ pluginBase?: string, requestedBase?: string, startSpan?: string, type?: string, kind?: string,
 *   operation?: string, schemas: string[], channels: string[] }} contract
 * @property {Record<string, boolean | number | string | undefined>} registrations
 * @property {{ integration: string, files: string[], registrations: string[] } | undefined} reference
 * @property {string[]} references
 */

/**
 * @param {string[]} arguments_
 * @returns {Arguments}
 */
function parseArguments (arguments_) {
  let rootArgument
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
      traits = value.split(',')
      for (const trait of traits) {
        if (!TRAITS.has(trait)) throw new Error(`unknown integration trait: ${trait}`)
      }
    } else if (argument === '--json') {
      json = true
    } else if (argument === '--root') {
      rootArgument = arguments_[++i]
      if (!rootArgument) throw new Error('--root requires a directory')
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else if (inspect === undefined && rootArgument === undefined) {
      rootArgument = argument
    } else {
      throw new Error(`unexpected argument: ${argument}`)
    }
  }

  return {
    root: path.resolve(rootArgument ?? process.cwd()),
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
  console.error(error.message)
  process.exit(1)
}
const root = options.root

/**
 * @param {string} filename
 * @returns {string}
 */
function read (filename) {
  return readFileSync(path.join(root, filename), 'utf8')
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function listMarkdownFiles (directory) {
  const files = []
  const absoluteDirectory = path.join(root, directory)

  if (!existsSync(absoluteDirectory)) return files

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(filename))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(filename.replaceAll(path.sep, '/'))
    }
  }

  return files
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
    actual.push(...listMarkdownFiles(directory))
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
 * @param {string} filename
 * @param {string[]} values
 * @returns {boolean}
 */
function containsAny (filename, values) {
  const absoluteFilename = path.join(root, filename)
  if (!existsSync(absoluteFilename)) return false

  const source = readFileSync(absoluteFilename, 'utf8')
  return values.some(value => source.includes(value))
}

/**
 * @param {string} filename
 * @param {string[]} values
 * @returns {string | undefined}
 */
function findLine (filename, values) {
  const absoluteFilename = path.join(root, filename)
  if (!existsSync(absoluteFilename)) return

  const lines = readFileSync(absoluteFilename, 'utf8').split('\n')
  const index = lines.findIndex(line => values.some(value => line.includes(value)))
  if (index !== -1) return `${filename}:${index + 1}`
}

/**
 * @param {string} filename
 * @param {string} integration
 * @returns {string | undefined}
 */
function findWorkflowLine (filename, integration) {
  const absoluteFilename = path.join(root, filename)
  if (!existsSync(absoluteFilename)) return

  const lines = readFileSync(absoluteFilename, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const plugins = lines[i].match(/\bPLUGINS:\s*['"]?([a-z0-9_|-]+)/)?.[1]
    if (plugins?.split('|').includes(integration)) return `${filename}:${i + 1}`
  }
}

/**
 * @param {string} pluginDirectory
 * @returns {string | undefined}
 */
function findPluginBase (pluginDirectory) {
  for (const filename of listRelativeFiles(pluginDirectory, ['.js'])) {
    const match = read(filename).match(/require\(['"]\.\.\/\.\.\/dd-trace\/src\/plugins\/([a-z0-9-]+)['"]\)/)
    if (match) return match[1]
  }
}

/**
 * @param {string | undefined} pluginBase
 * @returns {{ startSpan?: string, type?: string, kind?: string, operation?: string }}
 */
function findPluginContract (pluginBase) {
  const contract = {}
  const visited = new Set()
  let current = pluginBase

  while (current && !visited.has(current)) {
    visited.add(current)
    const filename = `packages/dd-trace/src/plugins/${current}.js`
    if (!existsSync(path.join(root, filename))) break

    const source = read(filename)
    if (!contract.startSpan) {
      const signature = source.match(/startSpan \(([^)]*)\)/)
      if (signature) contract.startSpan = `startSpan(${signature[1].replaceAll(/\s*,\s*/g, ', ')})`
    }
    for (const [property, pattern] of PLUGIN_CONTRACT_PATTERNS) {
      if (contract[property]) continue
      contract[property] = source.match(pattern)?.[1]
    }

    current = source.match(/require\(['"]\.\/([a-z0-9-]+)['"]\)/)?.[1]
  }

  return contract
}

/**
 * @param {string[]} filenames
 * @returns {string[]}
 */
function findChannels (filenames) {
  const channels = new Set()
  const patterns = [
    /(?:channel|tracingChannel)\(\s*['"]([^'"]+)['"]/g,
    /channelName:\s*['"]([^'"]+)['"]/g,
    /static prefix = ['"]([^'"]+)['"]/g,
  ]

  for (const filename of filenames) {
    const source = read(filename)
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) channels.add(match[1])
    }
  }

  return [...channels].sort()
}

/**
 * @param {string} packageName
 * @param {string} integration
 * @returns {string | undefined}
 */
function findLatestVersion (packageName, integration) {
  const filename = 'packages/dd-trace/test/plugins/versions/package.json'
  if (!existsSync(path.join(root, filename))) return

  const dependencies = JSON.parse(read(filename)).dependencies ?? {}
  return dependencies[packageName] ?? dependencies[integration]
}

/**
 * @param {string} integration
 * @returns {string | undefined}
 */
function findCodeownersCoverage (integration) {
  const filename = '.github/CODEOWNERS'
  if (!existsSync(path.join(root, filename))) return

  for (const line of read(filename).split('\n')) {
    const pattern = line.trim().split(/\s+/, 1)[0]
    if (pattern.includes(`datadog-plugin-${integration}/`) || pattern === '/packages/datadog-plugin-*/') {
      return pattern
    }
  }
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
    const filename = `packages/dd-trace/src/plugins/${trait}.js`
    if (PLUGIN_BASE_TRAITS.has(trait) && existsSync(path.join(root, filename))) references.push(filename)
  }
  references.push(mode === 'serverless'
    ? '.agents/skills/serverless-integrations/references/testing-guide.md'
    : '.agents/skills/apm-integrations/references/testing.md')

  return references
}

/**
 * @param {string} integration
 * @param {string[]} traits
 * @returns {{ integration: string, files: string[], registrations: string[] } | undefined}
 */
function findClosestReference (integration, traits) {
  const directory = 'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations'
  const requestedBase = traits.find(trait => PLUGIN_BASE_TRAITS.has(trait))
  let closest
  let closestScore = 0

  for (const filename of listRelativeFiles(directory, ['.js'])) {
    const candidate = path.basename(filename, '.js')
    if (candidate === 'index' || candidate === integration) continue

    const source = read(filename)
    const moduleName = source.match(/name:\s*['"]([^'"]+)['"]/)?.[1] ?? candidate
    const pluginDirectory = `packages/datadog-plugin-${candidate}`
    const pluginBase = findPluginBase(`${pluginDirectory}/src`)
    let score = traits.includes('orchestrion') ? 1 : 0
    if (requestedBase && pluginBase === requestedBase) score += 8
    if (traits.includes('cjs-esm') && /(?:cjs|commonjs)/i.test(source) && /esm/i.test(source)) score += 4
    for (const [trait, kind] of TRAIT_KINDS) {
      if (traits.includes(trait) && (
        source.includes(`kind: '${kind}'`) || source.includes(`kind: "${kind}"`)
      )) score += 2
    }
    if (score <= closestScore) continue

    closestScore = score
    const tests = listRelativeFiles(`${pluginDirectory}/test`, ['.spec.js', '.spec.mjs'])
    closest = {
      integration: candidate,
      files: [
        filename,
        existingPath(`packages/datadog-instrumentations/src/${candidate}.js`),
        existingPath(`${pluginDirectory}/src/index.js`),
        tests.find(filename => path.basename(filename) === 'index.spec.js') ?? tests[0],
      ].filter(Boolean),
      registrations: [
        findLine('packages/datadog-instrumentations/src/helpers/hooks.js', [
          `'${moduleName}':`,
          `"${moduleName}":`,
          `${moduleName}:`,
        ]),
        findLine('packages/dd-trace/src/plugins/index.js', [
          `get '${moduleName}'`,
          `get "${moduleName}"`,
          `datadog-plugin-${candidate}/src`,
        ]),
        findLine('packages/dd-trace/test/plugins/versions/package.json', [`"${moduleName}"`, `"${candidate}"`]),
        findLine('index.d.ts', [`"${candidate}"`]),
        findLine('index.d.v5.ts', [`"${candidate}"`]),
        findLine('docs/API.md', [`id="${candidate}"`, `[${candidate}]`]),
        findLine('docs/test.ts', [`use('${candidate}'`, `use("${candidate}"`]),
        findLine('.github/CODEOWNERS', [`datadog-plugin-${candidate}/`, '/packages/datadog-plugin-*/']),
        findWorkflowLine('.github/workflows/apm-integrations.yml', candidate),
        findWorkflowLine('.github/workflows/serverless.yml', candidate),
      ].filter(Boolean),
    }
  }

  return closest
}

/**
 * @param {string} integration
 * @param {string} packageName
 * @param {string} mode
 * @param {string[]} traits
 * @returns {InspectionPacket}
 */
function inspectIntegration (integration, packageName, mode, traits) {
  const instrumentation = existingPath(`packages/datadog-instrumentations/src/${integration}.js`)
  const rewriter = existingPath(
    `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/${integration}.js`
  )
  const pluginDirectory = `packages/datadog-plugin-${integration}`
  const plugin = existingPath(`${pluginDirectory}/src/index.js`)
  const tests = listRelativeFiles(`${pluginDirectory}/test`, ['.spec.js', '.spec.mjs'])
  const pluginBase = findPluginBase(`${pluginDirectory}/src`)
  const requestedBase = traits.find(trait => PLUGIN_BASE_TRAITS.has(trait))
  const contract = findPluginContract(pluginBase ?? requestedBase)
  const sourceFiles = [instrumentation, rewriter, ...listRelativeFiles(`${pluginDirectory}/src`, ['.js'])]
    .filter(Boolean)
  const names = [integration]
  if (packageName !== integration) names.push(packageName)

  return {
    integration,
    package: packageName,
    mode,
    traits,
    targets: {
      instrumentation,
      rewriter,
      plugin,
      tests,
    },
    contract: {
      pluginBase,
      requestedBase,
      ...contract,
      schemas: contract.type
        ? [
            existingPath(`packages/dd-trace/src/service-naming/schemas/v0/${contract.type}.js`),
            existingPath(`packages/dd-trace/src/service-naming/schemas/v1/${contract.type}.js`),
          ].filter(Boolean)
        : [],
      channels: findChannels(sourceFiles),
    },
    registrations: {
      hook: containsAny(
        'packages/datadog-instrumentations/src/helpers/hooks.js',
        names.flatMap(name => [`${name}:`, `'${name}':`, `"${name}":`])
      ),
      plugin: containsAny('packages/dd-trace/src/plugins/index.js', [`datadog-plugin-${integration}/src`]),
      latestVersion: findLatestVersion(packageName, integration),
      types: containsAny('index.d.ts', [`"${integration}"`]),
      v5Types: containsAny('index.d.v5.ts', [`"${integration}"`]),
      docs: containsAny('docs/API.md', [`id="${integration}"`, `[${integration}]`]),
      docsTest: containsAny('docs/test.ts', [`use('${integration}'`, `use("${integration}"`]),
      codeowners: findCodeownersCoverage(integration),
      workflow: findWorkflowLine('.github/workflows/apm-integrations.yml', integration) !== undefined ||
        findWorkflowLine('.github/workflows/serverless.yml', integration) !== undefined,
    },
    reference: findClosestReference(integration, traits),
    references: findReferences(mode, traits, rewriter !== undefined),
  }
}

/**
 * @param {InspectionPacket} packet
 * @returns {string}
 */
function renderInspection (packet) {
  const requestedBase = !packet.contract.pluginBase && packet.contract.requestedBase ? ' (requested)' : ''
  const lines = [
    `Integration: ${packet.integration} (${packet.package})`,
    `Mode: ${packet.mode}${packet.traits.length ? `; traits: ${packet.traits.join(', ')}` : ''}`,
    'Targets:',
    `  instrumentation: ${packet.targets.instrumentation ?? 'missing'}`,
    `  rewriter: ${packet.targets.rewriter ?? 'missing'}`,
    `  plugin: ${packet.targets.plugin ?? 'missing'}`,
    `  tests: ${packet.targets.tests.length}`,
    'Contract:',
    `  base: ${packet.contract.pluginBase ?? packet.contract.requestedBase ?? 'unresolved'}${requestedBase}`,
    `  startSpan: ${packet.contract.startSpan ?? 'unresolved'}`,
    `  role: ${[packet.contract.type, packet.contract.kind, packet.contract.operation].filter(Boolean).join('/') ||
      'unresolved'}`,
    `  schemas: ${packet.contract.schemas.join(', ') || 'unresolved'}`,
    `  channels: ${packet.contract.channels.join(', ') || 'unresolved'}`,
    'Registrations:',
  ]

  for (const [name, value] of Object.entries(packet.registrations)) {
    lines.push(`  ${name}: ${value ?? 'missing'}`)
  }
  if (packet.reference) {
    lines.push(
      `Closest current reference: ${packet.reference.integration}`,
      '  files:',
      ...packet.reference.files.map(filename => `    ${filename}`),
      '  registrations:',
      ...packet.reference.registrations.map(filename => `    ${filename}`)
    )
  }
  lines.push(
    'Read next:',
    ...packet.references.map(filename => `  ${filename}`)
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
    options.packageName ?? options.inspect,
    options.mode,
    options.traits
  )
  // eslint-disable-next-line no-console
  console.log(options.json ? JSON.stringify(packet, undefined, 2) : renderInspection(packet))
} else {
  verifyInventory()
  verifyDiscoveryMetadata()
  const results = verifySkillDocuments()
  const transformerVersion = verifySourceContracts()

  if (failures.length) {
    // eslint-disable-next-line no-console
    console.error(`Integration skill verification failed:\n\n${failures.map(failure => `- ${failure}`).join('\n')}`)
    process.exitCode = 1
  } else {
    const total = results.reduce((sum, result) => sum + result.tokens, 0)
    // eslint-disable-next-line no-console
    console.log(`Integration skills: ${total} / ${TOTAL_TOKEN_BUDGET} tokens (o200k_base)`)
    for (const { filename, tokens, budget } of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${tokens} / ${budget}  ${filename}`)
    }
    // eslint-disable-next-line no-console
    console.log(`Vendored code transformer: ${transformerVersion} (derived from vendor/package-lock.json)`)
  }
}
