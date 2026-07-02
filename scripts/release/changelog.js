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
const REFERENCE_PATTERN = /#([0-9]+)/g
const GITHUB_URL = 'https://github.com'
const REPO_URL = `${GITHUB_URL}/DataDog/dd-trace-js`
const UNCATEGORIZED_PRODUCT = 'Other'
const DEPENDENCY_PRODUCT = 'Dependencies'
// Dependabot tags the commit scope `deps-dev` for development dependencies and
// `deps` for production ones, but the `deps` manifests under test/benchmark/docs
// directories are not shipped. The shipped manifests are the repo root and the
// bundled `/vendor` tree; only those (and the matching production groups from
// `.github/dependabot.yml`) reach customers. Keep this set in sync with the
// `dependency-type: "production"` groups there.
const PRODUCTION_DEPENDENCY_GROUPS = new Set([
  'runtime-minor-and-patch-dependencies',
  'vendor-minor-and-patch-dependencies',
  'security-production',
])

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
 * @property {string} pr Bare pull request number, e.g. `8012`, or `''` when absent.
 * @property {boolean} revert
 * @property {boolean} [drop] Set when the entry is intentionally omitted from the changelog.
 * @property {string} [warning]
 */

/**
 * @param {CommitEntry[]} entries
 * @param {CommitEntry[]} [breakingEntries]
 * @returns {ReleaseChangelog}
 */
function createReleaseChangelog (entries, breakingEntries = []) {
  const sections = new Map()
  const breakingChanges = []
  const contributors = new Set()
  const warnings = []
  let isMinor = false

  for (const entry of breakingEntries) {
    const change = parseChange(entry, { dropOtherDependencies: false })

    if (change.warning) warnings.push(change.warning)
    if (entry.author) contributors.add(entry.author)
    breakingChanges.push(change)
  }

  for (const entry of entries) {
    const change = parseChange(entry)

    if (change.drop) continue
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
    markdown: renderMarkdown(sections, contributors, breakingChanges),
    isMinor,
    warnings,
  }
}

/**
 * @param {CommitEntry} entry
 * @param {{ dropOtherDependencies?: boolean }} [options]
 * @returns {Change}
 */
function parseChange (entry, options = {}) {
  const subjectWithPullRequest = parsePullRequest(entry.subject)
  const parsed = parseConventionalSubject(subjectWithPullRequest.subject)

  if (!parsed) {
    return {
      category: INTERNAL_CATEGORY,
      product: UNCATEGORIZED_PRODUCT,
      subject: subjectWithPullRequest.subject,
      pr: subjectWithPullRequest.pr,
      revert: false,
      warning: `Non-conventional release-note subject for ${entry.sha}: ${entry.subject}`,
    }
  }

  const dependency = classifyDependencyBump(parsed.scopes, parsed.subject)
  if (dependency === 'other' && options.dropOtherDependencies !== false) {
    return { drop: true }
  }

  return {
    category: CATEGORY_BY_TYPE[parsed.type] || INTERNAL_CATEGORY,
    product: dependency ? DEPENDENCY_PRODUCT : selectProduct(parsed.scopes),
    subject: parsed.subject,
    pr: subjectWithPullRequest.pr,
    revert: parsed.isRevert,
  }
}

/**
 * Classify a Dependabot dependency bump as shipped (`production`) or not
 * (`other`, dropped from the changelog), or `undefined` when the commit is not
 * a dependency bump at all. Development dependencies and the instrumented-library
 * support ranges under test/benchmark/docs directories never reach customers.
 *
 * @param {string[]} scopes
 * @param {string} subject
 * @returns {'production'|'other'|undefined}
 */
function classifyDependencyBump (scopes, subject) {
  if (!scopes.includes('deps') && !scopes.includes('deps-dev')) return
  if (scopes.includes('deps-dev')) return 'other'

  const directory = subject.match(/\bin (\/\S+)/)
  if (directory && directory[1] !== '/vendor') return 'other'

  const group = subject.match(/\bthe (\S+) group\b/)
  if (group && !PRODUCTION_DEPENDENCY_GROUPS.has(group[1])) return 'other'

  return 'production'
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
    pr: match[1],
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
 * @param {Change[]} breakingChanges
 */
function renderMarkdown (sections, contributors, breakingChanges) {
  const lines = []

  if (breakingChanges.length > 0) {
    lines.push('### Breaking Changes')
    for (const change of breakingChanges.sort(compareChanges)) {
      lines.push(renderChange(change))
    }
    lines.push('')
  }

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
    const badges = [...contributors].sort(compareContributors).map(renderContributor)
    lines.push('### Contributors', '', badges.join(' '), '')
  }

  return lines.join('\n')
}

/**
 * @param {string} category
 */
function renderHeading (category) {
  if (category === INTERNAL_CATEGORY) {
    return `### ${category} (CI, Testing, Benchmarking)`
  }

  return `### ${category}`
}

/**
 * Groups same-product entries together, then orders by subject within a product.
 *
 * @param {Change} a
 * @param {Change} b
 */
function compareChanges (a, b) {
  const byProduct = a.product.toLowerCase().localeCompare(b.product.toLowerCase())
  if (byProduct !== 0) return byProduct

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
 * Renders a GitHub avatar that links to the contributor's profile. Display
 * strings that are not a `@handle` (a plain git author name) have no profile to
 * link, so they render verbatim.
 *
 * @param {string} contributor
 */
function renderContributor (contributor) {
  if (!contributor.startsWith('@')) return contributor

  const login = contributor.slice(1)
  return `[<img src="${GITHUB_URL}/${login}.png?size=48" width="24" height="24" ` +
    `alt="${contributor}" title="${contributor}" />](${GITHUB_URL}/${login})`
}

/**
 * @param {Change} change
 */
function renderChange (change) {
  const subject = linkifyReferences(change.subject)
  const suffix = change.pr ? ` ${renderPullRequest(change.pr)}` : ''
  if (change.product === UNCATEGORIZED_PRODUCT) {
    return `- ${subject}${suffix}`
  }

  return `- **${change.product}:** ${subject}${suffix}`
}

/**
 * Wraps inline `#1234` references in an explicit link so GitHub renders them as
 * plain links instead of expanding each one into a pull request preview.
 *
 * @param {string} text
 */
function linkifyReferences (text) {
  return text.replaceAll(REFERENCE_PATTERN, (_, number) => renderPullRequest(number))
}

/**
 * @param {string} number Bare pull request number.
 */
function renderPullRequest (number) {
  return `[#${number}](${REPO_URL}/pull/${number})`
}

module.exports = {
  createReleaseChangelog,
}
