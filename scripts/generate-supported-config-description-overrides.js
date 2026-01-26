'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

const SUPPORTED_JSON_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.json')
const USAGE_INDEX_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.env-usage-index.json'
)
const MISSING_LIST_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.missing-descriptions.json'
)
const OVERRIDES_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.overrides.json'
)
const DOCS_REPORT_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.docs-report.json'
)

function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJSON (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function isPlainObject (v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function normalizeDescription (s) {
  if (!s) return s
  const trimmed = String(s).trim()
  if (!trimmed) return trimmed
  // Uppercase the first letter when it starts with a word character.
  return trimmed.replace(/^([a-z])/, (_, c) => c.toUpperCase())
}

function isMeaningfulLeadingComment (s) {
  if (!s) return false
  const t = String(s).trim()
  if (!t) return false
  // Filter out common non-descriptive directives.
  if (/eslint/i.test(t)) return false
  if (/^\s*todo\b/i.test(t)) return false
  return true
}

function isLowQualityDescription (s) {
  if (!s) return true
  const t = String(s).trim()
  if (!t) return true
  if (/eslint/i.test(t)) return true
  if (/^\s*todo\b/i.test(t)) return true
  if (t === 'Configuration option.' || t === 'Configuration option') return true
  if (t === 'Configuration.' || t === 'Configuration') return true
  if (t === 'Count configuration.' || t === 'Count configuration') return true
  if (t === 'Destination path or location.' || t === 'Destination path or location') return true
  if (t === 'Interval for heap snapshot.' || t === 'Interval for heap snapshot') return true
  if (/^\[Datadog site\]\[\d+\]\s*-\s*\*\*Required\*\*$/.test(t)) return true
  if (/^Datadog site\s*-\s*\*\*Required\*\*$/.test(t)) return true
  if (t === 'Destination site for your metrics, traces, and logs.' ||
      t === 'Destination site for your metrics, traces, and logs') return true
  return false
}

function pickBestMatch (matches) {
  if (!matches?.length) return
  // Prefer core runtime code over tests.
  const rank = (m) => {
    const f = m.file
    if (f.startsWith('packages/dd-trace/src/')) return 0
    if (f.startsWith('packages/datadog-instrumentations/src/')) return 1
    if (f.startsWith('integration-tests/')) return 2
    if (f.startsWith('packages/dd-trace/test/')) return 3
    return 4
  }
  const sorted = matches.slice().sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    const f = a.file.localeCompare(b.file)
    if (f !== 0) return f
    return a.line - b.line
  })
  return sorted[0]
}

function cleanDocsDescription (s) {
  if (!s) return s
  let out = String(s)
  // Strip Datadog docs template placeholders and region-param artifacts.
  out = out.replace(/\{\{<[^>]*>\}\}/g, '').replace(/\{\{\}\}/g, '')
  // Replace markdown reference-style "Datadog site" links with plain text.
  out = out.replace(/\[Datadog site\]\[\d+\]/g, 'Datadog site')
  // Normalize whitespace.
  out = out.replace(/\s+/g, ' ').trim()
  return out
}

function toFirstSentence (s) {
  if (!s) return s
  const idx = s.indexOf('.')
  if (idx === -1) return s
  return s.slice(0, idx + 1).trim()
}

function docsShortDescription (envVar, docsReport) {
  const bucket = docsReport?.matchesByEnvVar?.[envVar]
  const candidates = bucket?.descriptionCandidates
  if (!Array.isArray(candidates) || candidates.length === 0) return

  // Only apply doc-derived descriptions where we have strong signal.
  if (envVar === 'DD_SITE') {
    /** @type {string[]} */
    const filtered = []
    for (const c of candidates) {
      const v = c?.value
      if (typeof v !== 'string') continue
      // Avoid unrelated mentions (e.g. TLS minimum version docs that mention DD_SITE).
      if (/minimum tls/i.test(v) || /\btlsv?1/i.test(v)) continue
      if (!/datadog site/i.test(v)) continue
      const cleaned = cleanDocsDescription(v)
      if (cleaned) filtered.push(cleaned)
    }

    /** @type {{ first: string, score: number }[]} */
    const scored = []
    for (const raw of filtered) {
      const first = toFirstSentence(raw)
      if (!first) continue
      let score = 0
      if (/destination/i.test(first)) score += 3
      if (/\bsend\b/i.test(first)) score += 2
      if (/required/i.test(first)) score -= 10
      if (first.length >= 50) score += 1
      scored.push({ first, score })
    }
    scored.sort((a, b) => b.score - a.score)

    const best = scored[0]
    if (best?.first) {
      // Make it explicitly actionable for users: you only set this when you’re not on the default Datadog site.
      return normalizeDescription(
        'Datadog site/region to send data to. Set this when your org is not on `datadoghq.com`.'
      )
    }
  }
}

function inferBooleanDefaultFromSnippet (snippet) {
  // Heuristic: only apply when semantics are unambiguous.
  // - isTrue(getValueFromEnvSources('ENV')) => false when unset
  // - !isFalse(getValueFromEnvSources('ENV')) => true when unset
  const s = String(snippet)
  if (/!\s*isFalse\s*\(/.test(s)) return true
  if (/isTrue\s*\(/.test(s)) return false
}

function descriptionFromEnvVarName (envVar) {
  if (envVar.startsWith('DD_CIVISIBILITY_')) {
    const rest = envVar.slice('DD_CIVISIBILITY_'.length)
    if (rest === 'TEST_SESSION_ID') {
      return 'CI Visibility test session trace identifier used to correlate spans across worker processes.'
    }
    if (rest === 'TEST_MODULE_ID') {
      return 'CI Visibility test module identifier used to correlate spans across worker processes.'
    }
    if (rest === 'TEST_COMMAND') return 'Command used to run the test suite in CI Visibility.'
    if (rest === 'RUM_FLUSH_WAIT_MILLIS') return 'Wait time in milliseconds before flushing CI Visibility RUM events.'
    if (rest.startsWith('DANGEROUSLY_FORCE_')) return 'Force-enable CI Visibility behavior for testing or debugging.'
    if (rest === 'AUTO_INSTRUMENTATION_PROVIDER') {
      return 'Name of the CI Visibility auto-instrumentation tool that injected dd-trace (telemetry only).'
    }
    return 'CI Visibility configuration.'
  }
  if (envVar.startsWith('DD_TEST_MANAGEMENT_')) {
    if (envVar.endsWith('_RETRIES')) return 'Number of retries used by Test Management.'
    return 'Test Management configuration.'
  }
  if (envVar.startsWith('DD_GIT_')) {
    if (envVar.endsWith('_SHA') || envVar.endsWith('_HEAD_SHA')) return 'Git commit SHA for git metadata collection.'
    if (envVar.includes('PULL_REQUEST_BASE_BRANCH')) return 'Git base branch information for pull requests.'
    return 'Git metadata configuration.'
  }
  if (envVar.startsWith('DD_TRACE_')) {
    if (envVar === 'DD_TRACE_DISABLED_PLUGINS') {
      return 'Comma-separated list of plugin IDs to disable. See `index.d.ts` `interface Plugins` for valid IDs.'
    }
    if (envVar === 'DD_TRACE_BEAUTIFUL_LOGS') {
      return 'Pretty-print JSON payloads in tracer debug logs (adds indentation).'
    }
    if (envVar === 'DD_TRACE_AWS_ADD_SPAN_POINTERS') {
      return 'Enable/disable span pointers for supported AWS SDK operations.'
    }
    if (envVar === 'DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS') {
      return 'JSON object mapping DynamoDB table names to primary key field names (1-2) used for span pointers.'
    }
    if (envVar === 'DD_TRACE_GRAPHQL_ERROR_EXTENSIONS') {
      return 'Comma-separated list of GraphQL error extension keys to record on span events.'
    }
    if (envVar === 'DD_TRACE_PEER_SERVICE_MAPPING') {
      return 'Comma-separated `from:to` mapping to remap `peer.service` (sets `_dd.peer.service.remapped_from`).'
    }
    if (envVar === 'DD_TRACE_NATIVE_SPAN_EVENTS') {
      return 'Encode span events in the native `span_events` payload format instead of `meta.events` JSON.'
    }
    if (envVar === 'DD_TRACE_SCOPE') {
      return 'Legacy scope configuration (async context propagation); currently has no effect.'
    }
    if (envVar === 'DD_TRACE_TAGS') {
      return 'Additional tags to apply to traces, as comma-separated `key:value` pairs.'
    }
    if (envVar === 'DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH') {
      return 'Maximum length of the `x-datadog-tags` header for trace tag propagation. Set to 0 to disable.'
    }
    if (envVar === 'DD_TRACE_ENCODING_DEBUG') return 'Enable/disable additional trace encoding debug logging.'
    if (envVar === 'DD_TRACE_EXPERIMENTAL_SPAN_COUNTS') return 'Enable/disable experimental span counts.'
    if (envVar === 'DD_TRACE_EXPERIMENTAL_STATE_TRACKING') return 'Enable/disable experimental state tracking.'
    if (envVar.endsWith('_MAPPING')) return 'Mapping configuration.'
  }

  if (envVar === 'DD_ACTION_EXECUTION_ID') {
    return 'AWS CodePipeline action execution ID (used as CI job identifier for correlation).'
  }

  if (envVar.startsWith('DD_HEAP_SNAPSHOT_')) {
    if (envVar === 'DD_HEAP_SNAPSHOT_COUNT') return 'Number of heap snapshots to write. Set to 0 to disable.'
    if (envVar === 'DD_HEAP_SNAPSHOT_DESTINATION') return 'Directory path where heap snapshots are written.'
    if (envVar === 'DD_HEAP_SNAPSHOT_INTERVAL') return 'Delay in seconds between heap snapshots.'
  }
  if (envVar === 'DD_PROFILING_SOURCE_MAP') return 'Enable/disable source map support for profiling.'

  // Span attribute size limits
  if (/_SPAN_CHAR_LIMIT$/.test(envVar)) {
    const base = envVar
      .replace(/^DD_/, '')
      .replace(/_SPAN_CHAR_LIMIT$/, '')
      .toLowerCase()
    return `Maximum number of characters recorded for ${base} span data.`
  }

  // Worker markers
  if (envVar === 'DD_VITEST_WORKER') {
    return 'Internal marker (set to `1`) used to detect Vitest worker processes ' +
      'for CI Visibility IPC payload routing.'
  }
  if (envVar === 'DD_PLAYWRIGHT_WORKER') {
    return 'Internal marker (set to `1`) used to detect Playwright worker processes ' +
      'for CI Visibility IPC payload routing.'
  }
  if (/_WORKER$/.test(envVar)) {
    const base = envVar.replace(/^DD_/, '').replace(/_WORKER$/, '').toLowerCase()
    return `Internal marker (set to \`1\`) used to detect ${base} worker processes for CI Visibility.`
  }

  if (envVar.endsWith('_ID')) return 'Identifier used for configuration and correlation.'
  if (envVar.endsWith('_DESTINATION')) return 'Destination path or location.'
  if (envVar.endsWith('_COUNT')) return 'Count configuration.'
  return 'Configuration option.'
}

function parseArgs () {
  const args = process.argv.slice(2)
  /** @type {{ envListPath: string | undefined, force: boolean }} */
  const out = { envListPath: undefined, force: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--env-list') out.envListPath = args[++i]
    else if (a === '--force') out.force = true
  }
  return out
}

function readEnvListIfPresent (file) {
  try {
    const arr = readJSON(file)
    if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string')
  } catch {
    // ignore
  }
}

function main () {
  const argv = parseArgs()
  const supported = readJSON(SUPPORTED_JSON_PATH)
  const usage = readJSON(USAGE_INDEX_PATH)
  const docsReport = (() => {
    try {
      return readJSON(DOCS_REPORT_PATH)
    } catch {
      return undefined
    }
  })()
  const supportedConfigurations = supported?.supportedConfigurations || {}

  const overrides = (() => {
    try {
      const o = readJSON(OVERRIDES_PATH)
      return isPlainObject(o) ? o : {}
    } catch {
      return {}
    }
  })()

  const matchesByEnvVar = usage?.matchesByEnvVar || {}
  const explicitList = argv.envListPath ? readEnvListIfPresent(argv.envListPath) : undefined
  const baseList = explicitList || readEnvListIfPresent(MISSING_LIST_PATH)
  const envVarsToProcess = baseList || (() => {
    const out = []
    for (const [envVar, entries] of Object.entries(supportedConfigurations)) {
      const entry = Array.isArray(entries) ? entries[0] : undefined
      if (entry?.description === '__UNKNOWN__' || isLowQualityDescription(entry?.description)) out.push(envVar)
    }
    return out
  })()
  // If we’re using the generated missing-descriptions list, augment it with low-quality descriptions too.
  if (!explicitList && Array.isArray(baseList)) {
    for (const [envVar, entries] of Object.entries(supportedConfigurations)) {
      const entry = Array.isArray(entries) ? entries[0] : undefined
      if (isLowQualityDescription(entry?.description) && !envVarsToProcess.includes(envVar)) {
        envVarsToProcess.push(envVar)
      }
    }
  }
  envVarsToProcess.sort()

  /** @type {string[]} */
  const updated = []

  for (const envVar of envVarsToProcess) {
    if (!supportedConfigurations[envVar]) continue
    const entry = supportedConfigurations[envVar]?.[0] || {}
    const bucket = matchesByEnvVar[envVar]
    const best = pickBestMatch(bucket?.matches || [])
    const leadingComment = isMeaningfulLeadingComment(best?.leadingComment) ? best.leadingComment : undefined
    const snippet = best?.snippetLarge || best?.snippetSmall

    let description = leadingComment || undefined
    if (!description) {
      description = docsShortDescription(envVar, docsReport) || descriptionFromEnvVarName(envVar)
    }

    /** @type {Record<string, unknown>} */
    const o = isPlainObject(overrides[envVar]) ? overrides[envVar] : {}
    if (argv.force || isLowQualityDescription(o.description)) {
      o.description = normalizeDescription(description)
    }

    // Optionally fill in missing type/default when we have strong evidence.
    if (entry?.type === '__UNKNOWN__' && typeof o.type !== 'string') {
      if (/_ENABLED$/.test(envVar) || /_DISABLED$/.test(envVar) || /_DEBUG$/.test(envVar)) {
        o.type = 'boolean'
      }
    }
    if (entry?.default === '__UNKNOWN__' && !Object.hasOwn(o, 'default')) {
      const type = typeof o.type === 'string' ? o.type : entry.type
      if (type === 'boolean' && snippet) {
        const inferred = inferBooleanDefaultFromSnippet(snippet)
        if (inferred !== undefined) o.default = inferred
      }
    }
    if (entry?.default === '__UNKNOWN__' && !Object.hasOwn(o, 'default') && /_WORKER$/.test(envVar)) {
      // Worker marker env vars are unset by default and are typically injected by instrumentation itself.
      o.default = '__UNSET__'
    }

    // Attach evidence for review/debuggability.
    if (best) {
      /** @type {{ kind: 'code' | 'code_context', file: string, line: number, snippet: string }[]} */
      const evidence = [{
        kind: 'code',
        file: best.file,
        line: best.line,
        snippet: best.snippetSmall
      }]
      if (!leadingComment && best.snippetLarge && best.snippetLarge !== best.snippetSmall) {
        evidence.push({
          kind: 'code_context',
          file: best.file,
          line: best.line,
          snippet: best.snippetLarge
        })
      }
      o.evidence = evidence
    }

    overrides[envVar] = o
    updated.push(envVar)
  }

  const sorted = {}
  for (const k of Object.keys(overrides).sort()) sorted[k] = overrides[k]
  writeJSON(OVERRIDES_PATH, sorted)
  process.stdout.write(`Generated/updated overrides for ${updated.length} env vars\nWrote ${OVERRIDES_PATH}\n`)
}

if (require.main === module) {
  main()
}
