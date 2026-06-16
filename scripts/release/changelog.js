'use strict'

const INTERNAL_CATEGORY = 'Internal'
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
  ['AppSec', ['appsec', 'iast', 'rasp', 'waf', 'asm', 'aap']],
  ['AI Guard', ['aiguard', 'ai-guard', 'ai_guard']],
  ['Profiling', ['profiling', 'profiler']],
  ['Test Optimization', [
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
  ['LLM Observability', [
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
  ['Data Streams Monitoring', ['dsm', 'data-streams']],
  ['Database Monitoring', ['dbm']],
  ['Feature Flags', ['openfeature', 'feature-flags', 'flagging', 'ffe']],
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
    'runtime_metrics',
    'metrics',
    'dogstatsd',
    'stats',
    'sampler',
    'propagation',
    'exporters',
    'agent',
    'agentless',
    'startup-log',
    'shimmer',
    'storage',
    'esm',
    'stacktrace',
    'service-naming',
    'tags',
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
 * @property {string} [author] Display string for the release contributor, e.g. `@handle`.
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
 * @property {boolean} revert
 * @property {string} [warning]
 */

/**
 * @param {CommitEntry[]} entries
 * @returns {ReleaseChangelog}
 */
function createReleaseChangelog (entries) {
  const sections = new Map()
  const contributors = new Set()
  const warnings = []
  let isMinor = false

  for (const entry of entries) {
    const change = parseChange(entry)

    if (change.warning) warnings.push(change.warning)
    if (change.category === 'Features' && !change.revert) isMinor = true
    if (entry.author) contributors.add(entry.author)

    const section = sections.get(change.category)
    if (section) {
      section.push(change)
    } else {
      sections.set(change.category, [change])
    }
  }

  return {
    markdown: renderMarkdown(sections, contributors),
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
      revert: false,
      warning: `Non-conventional release-note subject for ${entry.sha}: ${entry.subject}`,
    }
  }

  const category = CATEGORY_BY_TYPE[parsed.type] || INTERNAL_CATEGORY
  const internal = INTERNAL_TYPES.has(parsed.type)
  const product = selectProduct(parsed.scopes)

  return {
    category,
    product,
    subject: parsed.subject,
    pr: subjectWithPullRequest.pr,
    internal,
    revert: parsed.isRevert,
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
    isRevert,
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
  let allGeneral = true

  for (const scope of scopes) {
    const product = findProduct(scope)
    if (product === undefined) {
      allGeneral = false
      continue
    }
    if (product !== 'General') return product
  }

  // No product groups these scopes. Fall back to the full scope list from the
  // commit verbatim rather than a catch-all, unless every scope is a core one.
  if (allGeneral) return 'General'

  return scopes.join(', ')
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
 * @param {Set<string>} contributors
 */
function renderMarkdown (sections, contributors) {
  const lines = []

  for (const category of CATEGORY_ORDER) {
    const changes = sections.get(category)
    if (!changes?.length) continue

    lines.push(renderHeading(category))
    for (const change of changes.sort(compareChanges)) {
      lines.push(renderChange(change))
    }
    lines.push('')
  }

  if (contributors.size > 0) {
    lines.push('<b>Contributors</b>')
    for (const contributor of [...contributors].sort(compareContributors)) {
      lines.push(`- ${contributor}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * @param {string} category
 */
function renderHeading (category) {
  if (category === INTERNAL_CATEGORY) {
    return `<b>${category}</b> (CI, Testing, Benchmarking)`
  }

  return `<b>${category}</b>`
}

/**
 * Groups same-product entries together; the internal section carries no product,
 * so it falls through to a plain subject sort.
 *
 * @param {Change} a
 * @param {Change} b
 */
function compareChanges (a, b) {
  if (!a.internal) {
    const byProduct = a.product.toLowerCase().localeCompare(b.product.toLowerCase())
    if (byProduct !== 0) return byProduct
  }

  return a.subject.toLowerCase().localeCompare(b.subject.toLowerCase())
}

/**
 * @param {string} a
 * @param {string} b
 */
function compareContributors (a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase())
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
