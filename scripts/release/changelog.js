'use strict'

const INTERNAL_CATEGORY = '<b>Internal</b> (CI, Testing, Benchmarking)'
const CATEGORY_ORDER = [
  'Features',
  'Fixes',
  'Performance',
  'Documentation',
  INTERNAL_CATEGORY,
]
const CONVENTIONAL_PATTERN = new RegExp(
  String.raw`^(?:(revert)(!)?: )?` +
    String.raw`(feat|fix|docs|style|refactor|perf|test|bench|build|ci|chore)(?:\(([^)]+)\))?(!)?: (.+)$`
)
const PULL_REQUEST_PATTERN = /\s+\(#([0-9]+)\)$/
const INTERNAL_TYPES = new Set(['bench', 'build', 'chore', 'ci', 'refactor', 'style', 'test'])

const CATEGORY_BY_TYPE = {
  docs: 'Documentation',
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
}
const PRODUCTS = [
  ['AppSec', ['appsec', 'iast', 'rasp', 'waf', 'asm']],
  ['AI Guard', ['aiguard', 'ai-guard']],
  ['Profiling', ['profiling', 'profiler']],
  ['CI Visibility', [
    'ci-visibility',
    'test-optimization',
    'testopt',
    'itr',
    'efd',
    'tia',
    'jest',
    'mocha',
    'cucumber',
    'cypress',
    'playwright',
    'vitest',
    'selenium',
  ]],
  ['Crash Tracking', ['crashtracking', 'crash-tracking']],
  ['Dynamic Instrumentation', ['debugger', 'code-origin', 'dynamic-instrumentation']],
  ['LLMObs', [
    'llmobs',
    'ai',
    'openai',
    'anthropic',
    'langchain',
    'langgraph',
    'genai',
    'vertexai',
    'bedrockruntime',
  ]],
  ['Serverless', ['serverless', 'lambda', 'azure_metadata', 'inferred_proxy']],
  ['OpenTelemetry', ['otel', 'opentelemetry']],
  ['General', [
    'core',
    'tracing',
    'span',
    'format',
    'encode',
    'encoder',
    'opentracing',
    'http',
    'http2',
    'instrumentation',
    'plugins',
    'config',
    'telemetry',
    'remote-config',
    'runtime-metrics',
    'stats',
    'sampler',
    'types',
  ]],
]
const PRODUCT_BY_SCOPE = new Map()

for (const [product, scopes] of PRODUCTS) {
  for (const scope of scopes) {
    PRODUCT_BY_SCOPE.set(scope, product)
  }
}

/**
 * @typedef {object} CommitEntry
 * @property {string} sha
 * @property {string} subject
 */

/**
 * @typedef {object} ReleaseChangelog
 * @property {string} markdown
 * @property {boolean} isMinor
 * @property {string[]} warnings
 */

/**
 * @typedef {object} Change
 * @property {string} category
 * @property {string} product
 * @property {string} subject
 * @property {string} pr
 * @property {boolean} internal
 * @property {string} [warning]
 */

/**
 * @param {CommitEntry[]} entries
 * @returns {ReleaseChangelog}
 */
function createReleaseChangelog (entries) {
  const sections = new Map()
  const warnings = []
  let isMinor = false

  for (const entry of entries) {
    const change = parseChange(entry)

    if (change.warning) warnings.push(change.warning)
    if (change.category === 'Features') isMinor = true

    const section = sections.get(change.category)
    if (section) {
      section.push(change)
    } else {
      sections.set(change.category, [change])
    }
  }

  return {
    markdown: renderSections(sections),
    isMinor,
    warnings,
  }
}

/**
 * @param {CommitEntry} entry
 * @returns {Change}
 */
function parseChange (entry) {
  const subjectWithPullRequest = parsePullRequest(entry.subject)
  const parsed = parseConventionalSubject(subjectWithPullRequest.subject)

  if (!parsed) {
    return {
      category: INTERNAL_CATEGORY,
      product: 'Other',
      subject: subjectWithPullRequest.subject,
      pr: subjectWithPullRequest.pr,
      internal: true,
      warning: `Non-conventional release-note subject for ${entry.sha}: ${entry.subject}`,
    }
  }

  const category = CATEGORY_BY_TYPE[parsed.type] || INTERNAL_CATEGORY
  const internal = INTERNAL_TYPES.has(parsed.type)
  const product = selectProduct(parsed.scopes)
  const warning = !internal && product === 'Other'
    ? `Unknown release-note product for ${entry.sha}: ${entry.subject}`
    : undefined

  return {
    category,
    product,
    subject: parsed.subject,
    pr: subjectWithPullRequest.pr,
    internal,
    warning,
  }
}

/**
 * @param {string} subject
 */
function parsePullRequest (subject) {
  const match = subject.match(PULL_REQUEST_PATTERN)
  if (!match) {
    return { subject, pr: '' }
  }

  return {
    subject: subject.slice(0, match.index),
    pr: `#${match[1]}`,
  }
}

/**
 * @param {string} subject
 */
function parseConventionalSubject (subject) {
  const match = subject.match(CONVENTIONAL_PATTERN)
  if (!match) return

  const isRevert = match[1] === 'revert'
  const type = match[3]
  const scopes = splitScopes(match[4])
  const parsedSubject = sentenceCase(match[6])

  return {
    type,
    scopes,
    subject: isRevert ? `Revert "${parsedSubject}"` : parsedSubject,
  }
}

/**
 * @param {string|undefined} scope
 */
function splitScopes (scope) {
  if (!scope) return []

  const scopes = []
  for (const part of scope.split(',')) {
    const normalized = part.trim().toLowerCase()
    if (normalized) scopes.push(normalized)
  }
  return scopes
}

/**
 * @param {string[]} scopes
 */
function selectProduct (scopes) {
  let fallback = 'General'

  for (const scope of scopes) {
    const product = findProduct(scope)
    if (!product) {
      fallback = 'Other'
      continue
    }
    if (product !== 'General') return product
  }

  return fallback
}

/**
 * @param {string} scope
 */
function findProduct (scope) {
  for (const part of scope.split('/')) {
    const product = PRODUCT_BY_SCOPE.get(part)
    if (product) return product
  }
}

/**
 * @param {string} subject
 */
function sentenceCase (subject) {
  return subject[0].toUpperCase() + subject.slice(1)
}

/**
 * @param {Map<string, Change[]>} sections
 */
function renderSections (sections) {
  const lines = []

  for (const category of CATEGORY_ORDER) {
    const changes = sections.get(category)
    if (!changes?.length) continue

    lines.push(category)
    for (const change of changes) {
      lines.push(renderChange(change))
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * @param {Change} change
 */
function renderChange (change) {
  const suffix = change.pr ? ` ${change.pr}` : ''
  if (change.internal) {
    return `- ${change.subject}${suffix}`
  }

  return `- <b>${change.product}</b> ${change.subject}${suffix}`
}

module.exports = {
  createReleaseChangelog,
}
