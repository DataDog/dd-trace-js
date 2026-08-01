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

const root = path.resolve(process.argv[2] ?? process.cwd())
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
 * @returns {string[]}
 */
function listJavaScriptFiles (directory) {
  const files = []
  if (!existsSync(directory)) return files

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(filename))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(filename)
    }
  }

  return files
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
  for (const filename of listJavaScriptFiles(lambdaDirectory)) {
    check(!/\bstartSpan\s*\(/.test(readFileSync(filename, 'utf8')), `${filename}: Lambda now starts a span`)
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

verifyInventory()
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
