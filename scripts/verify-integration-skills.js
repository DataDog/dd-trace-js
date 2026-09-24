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

const TERMINAL_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
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

const root = process.cwd()

/**
 * @param {string} filename
 */
function read (filename) {
  return readFileSync(path.join(root, filename), 'utf8')
}

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check (condition, message) {
  if (!condition) failures.push(message)
}

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
 */
function verifyFrontmatter (filename, source) {
  if (!filename.endsWith('/SKILL.md')) return

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
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
 */
function verifySourcePattern (filename, pattern, description) {
  const absoluteFilename = path.join(root, filename)
  const sourceExists = existsSync(absoluteFilename)
  check(sourceExists, `missing source contract file ${filename}`)
  if (!sourceExists) return

  check(pattern.test(read(filename)), `${filename}: ${description}`)
}

/**
 * @param {string} pattern
 * @param {string[]} requiredOwners
 * @param {string} description
 */
function verifyCodeownersRule (pattern, requiredOwners, description) {
  const filename = '.github/CODEOWNERS'
  const absoluteFilename = path.join(root, filename)
  const sourceExists = existsSync(absoluteFilename)
  check(sourceExists, `missing source contract file ${filename}`)
  if (!sourceExists) return

  let owners
  for (const line of read(filename).split('\n')) {
    const [candidatePattern, ...candidateOwners] = line.trim().split(/\s+/)
    if (candidatePattern === pattern) owners = new Set(candidateOwners)
  }

  let hasRequiredOwners = owners !== undefined
  if (hasRequiredOwners) {
    for (const owner of requiredOwners) {
      if (!owners.has(owner)) {
        hasRequiredOwners = false
        break
      }
    }
  }
  check(hasRequiredOwners, `${filename}: ${description}`)
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
 * @param {string} character
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
 */
function escapeControlCharacters (value) {
  return value.replaceAll(TERMINAL_CONTROL_PATTERN, escapeControlCharacter)
}

function verifySymlink (link, target) {
  const absoluteLink = path.join(root, link)
  const linkExists = existsSync(absoluteLink)
  check(linkExists, `missing discovery link ${link}`)
  if (!linkExists) return

  const isSymbolicLink = lstatSync(absoluteLink).isSymbolicLink()
  check(isSymbolicLink, `${link}: must be a symbolic link`)
  if (!isSymbolicLink) return

  check(path.normalize(readlinkSync(absoluteLink)) === path.normalize(target), `${link}: must point to ${target}`)
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
  verifySymlink('.cursor/skills/apm-integrations', '../../.agents/skills/apm-integrations')
  verifySymlink('.cursor/skills/serverless-integrations', '../../.agents/skills/serverless-integrations')
  verifyCodeownersRule(
    '/.agents/skills/apm-integrations/',
    ['@DataDog/apm-idm-js'],
    'missing APM skill ownership'
  )
  verifyCodeownersRule(
    '/.agents/skills/serverless-integrations/',
    ['@DataDog/serverless-aws', '@DataDog/apm-serverless'],
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
