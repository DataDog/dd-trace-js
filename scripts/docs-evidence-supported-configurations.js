'use strict'

/**
 * Builds a docs evidence report for every env var in
 * `packages/dd-trace/src/config/supported-configurations.json` by scanning the
 * official Datadog docs source repository: https://github.com/DataDog/documentation
 *
 * Source:
 * - local checkout created by `scripts/sync-datadog-documentation.js`
 *
 * Output:
 * - packages/dd-trace/src/config/supported-configurations.docs-report.json
 *
 * The report includes:
 * - evidence matches (file/line/snippet)
 * - best-effort extracted table fields: type/description/default
 * - doc scope hint (nodejs vs other), used for weighting
 * - type conflicts (docs type vs supported-configurations.json type)
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SUPPORTED_JSON_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.json')
const DEFAULT_DOCS_REPO_DIR = path.join(REPO_ROOT, 'scripts/.cache/datadog-documentation')
const DEFAULT_DOCS_DIR = fs.existsSync(path.join(DEFAULT_DOCS_REPO_DIR, 'content/en'))
  ? path.join(DEFAULT_DOCS_REPO_DIR, 'content/en')
  : DEFAULT_DOCS_REPO_DIR
const REPORT_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.docs-report.json'
)

const ENV_VAR_RE = /(?:^|[^A-Z0-9_])((?:DD|OTEL)_[A-Z0-9_]+)/g

function normalizeDocsDescriptionMarkdown (raw) {
  if (!raw) return
  let s = String(raw)
  // Keep markdown, but normalize HTML line breaks.
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // Drop any remaining HTML tags (rare, but shows up in some docs).
  s = s.replace(/<\/?[^>]+>/g, '')
  // Trim trailing whitespace per-line.
  s = s.split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n').trim()
  if (!s) return
  // Keep size bounded (avoid giant blobs if we hit an unexpected page).
  if (s.length > 4000) return s.slice(0, 3997) + '...'
  return s
}

function normalizeDocsDefaultValue (raw) {
  if (!raw) return
  let s = String(raw)
  // Defaults should be parseable: strip markup aggressively.
  s = s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/`/g, '')
    .trim()
  if (!s) return
  // Keep it small; defaults should be short.
  if (s.length > 240) return s.slice(0, 237) + '...'
  return s
}

function detectScopeFromPath (relPath) {
  const p = relPath.toLowerCase()
  if (p.includes('/nodejs') || p.includes('nodejs.md') || p.includes('node.js')) return 'nodejs'
  return 'other'
}

function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJSON (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function normalizeDocType (raw) {
  if (!raw) return
  const s = String(raw).trim().toLowerCase()
  if (!s) return
  if (s.includes('boolean') || s === 'bool' || s === 'true/false') return 'boolean'
  if (s.includes('integer') || s === 'int') return 'int'
  if (s.includes('float') || s.includes('double') || s.includes('number')) return 'float'
  if (s.includes('string') || s.includes('text')) return 'string'
  if (s.includes('array') || s.includes('list') || s.includes('comma')) return 'array'
  if (s.includes('json') || s.includes('object') || s.includes('map') || s.includes('dictionary')) return 'json'
}

function listFiles (dir) {
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    const entries = fs.readdirSync(cur, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.name === '.git') continue
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        stack.push(p)
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name)
        // Most official docs content we care about is Markdown; keep it bounded for perf.
        if (ext === '.md' || ext === '.mdoc') {
          out.push(p)
        }
      }
    }
  }
  return out
}

function splitTableRow (line) {
  // markdown tables: | a | b | c |
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return
  const rawCells = trimmed.split('|').map(c => c.trim())
  // Drop leading/trailing empty from surrounding pipes
  if (rawCells.length >= 2 && rawCells[0] === '') rawCells.shift()
  if (rawCells.length >= 2 && rawCells[rawCells.length - 1] === '') rawCells.pop()
  if (rawCells.length < 2) return
  return rawCells
}

function isTableSeparatorRow (cells) {
  return cells.every(c => /^:?-{3,}:?$/.test(c.replace(/\s+/g, '')))
}

function parseDefinitionListField (line, field) {
  const normalized = String(line).trimStart()
    .replace(/^:{1,2}\s*/, '')
    .replace(/\*\*/g, '')
  const re = new RegExp(`^${field}\\s*:\\s*(.*)$`, 'i')
  const m = normalized.match(re)
  return m?.[1]?.trim()
}

function isStandaloneEnvVarLine (line) {
  const trimmed = String(line).trim()
  const unwrapped = trimmed.replace(/^`/, '').replace(/`$/, '').trim()
  return /^(?:DD|OTEL)_[A-Z0-9_]+$/.test(unwrapped)
}

function extractDefinitionListBlock (lines, startIdx) {
  // Datadog docs often use a "definition list" style:
  // `ENV_VAR`
  // :: **Default**: `...` <br>
  // **Supported Input**: ... <br>
  // **Description**: ...
  /** @type {{ default?: string, supportedInput?: string, description?: string }} */
  const out = {}
  /** @type {string[]} */
  const descriptionLines = []
  let collectingDescription = false
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) break
    const d = parseDefinitionListField(line, 'Default')
    if (d && !out.default) out.default = d
    const si = parseDefinitionListField(line, 'Supported Input')
    if (si && !out.supportedInput) out.supportedInput = si
    const desc = parseDefinitionListField(line, 'Description')
    if (desc && !out.description) {
      out.description = desc
      collectingDescription = true
      descriptionLines.push(desc)
      continue
    }
    // After the Description line, Datadog docs often continue the description on subsequent lines
    // (including markdown bullets). Collect until blank line or next env var entry.
    if (collectingDescription) {
      if (isStandaloneEnvVarLine(line)) break
      descriptionLines.push(line)
    }
  }
  if (descriptionLines.length) out.description = descriptionLines.join('\n').trim()
  return out
}

function extractEnvVarPropertyBlock (lines, startIdx) {
  // Some official docs (e.g. language-specific config pages) use:
  // :: **Environment Variable**: `DD_FOO` <br>
  // **Default**: `true`<br>
  // <free-form description lines>
  /** @type {{ default?: string, description?: string }} */
  const out = {}
  /** @type {string[]} */
  const descLines = []
  let sawDefault = false

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) break
    // Next property block usually starts with a backticked property name (e.g. `dd.trace...`)
    if (/^`[^`]+`$/.test(trimmed)) break

    const d = parseDefinitionListField(line, 'Default')
    if (d && !out.default) {
      out.default = d
      sawDefault = true
      continue
    }

    // Skip other structured fields
    if (/^\s*(?:::)?\s*\*\*/.test(trimmed)) continue
    if (/Environment Variable/i.test(trimmed)) continue

    if (sawDefault) descLines.push(line)
  }

  if (descLines.length) out.description = descLines.join('\n').trim()
  return out
}

function extractProseDefaultCandidate (lines, startIdx) {
  // Scan forward in the current paragraph for "Default:" / "Defaults to" patterns.
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) break
    const m = line.match(/\bDefault(?:s)?\s*(?:to|is|:)\s*([^.\n\r]+)(?:\.|$)/i)
    if (!m) continue
    const raw = m[1].trim()
    if (!raw) continue
    // Prefer backticked snippets
    const tick = raw.match(/`([^`]+)`/)
    if (tick) return tick[1].trim()
    // Prefer quoted snippets
    const quoted = raw.match(/"([^"]+)"/) || raw.match(/'([^']+)'/)
    if (quoted) return quoted[1].trim()
    return raw
  }
}

function scanDocsForEnvVars (docsDir, envVars, { includeProseDefaults = false } = {}) {
  const envSet = new Set(envVars)

  /**
   * @typedef {{ file: string, line: number, snippet: string, scope: 'nodejs'|'other' }} Evidence
   * @typedef {{ value: string, scope: 'nodejs'|'other', evidence: Evidence }} Candidate
   */

  /** @type {Record<string, { matches: Evidence[], typeCandidates: Candidate[], descriptionCandidates: Candidate[], defaultCandidates: Candidate[], docTypes: string[], docTypeEvidence: Evidence[] }>} */
  const index = {}
  for (const env of envVars) {
    index[env] = {
      matches: [],
      typeCandidates: [],
      descriptionCandidates: [],
      defaultCandidates: [],
      docTypes: [],
      docTypeEvidence: []
    }
  }

  const files = listFiles(docsDir)

  for (const file of files) {
    // Quick skip: avoid reading huge JSON blobs
    const stat = fs.statSync(file)
    if (stat.size > 5 * 1024 * 1024) continue

    const rel = path.relative(REPO_ROOT, file)
    const scope = detectScopeFromPath(rel)
    const contents = fs.readFileSync(file, 'utf8')
    const lines = contents.split('\n')

    /** @type {{ headers: string[], headerIndexByName: Record<string, number> } | undefined} */
    let tableHeader
    /** @type {string[] | undefined} */
    let pendingHeaderCells

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Markdown table header detection (two-line pattern: header + separator)
      const cells = splitTableRow(line)
      if (cells) {
        if (pendingHeaderCells && isTableSeparatorRow(cells)) {
          const headers = pendingHeaderCells.map(h => h.toLowerCase())
          const headerIndexByName = {}
          for (let idx = 0; idx < headers.length; idx++) {
            headerIndexByName[headers[idx]] = idx
          }
          tableHeader = { headers, headerIndexByName }
          pendingHeaderCells = undefined
          continue
        }

        // potential header row
        if (!tableHeader && cells.some(c => /type|description|default/i.test(c))) {
          pendingHeaderCells = cells
        }
      } else {
        pendingHeaderCells = undefined
        // terminate table context after blank line
        if (!line.trim()) tableHeader = undefined
      }

      // Find env vars from this line and then filter by the set we care about.
      const seen = new Set()
      let m
      while ((m = ENV_VAR_RE.exec(line)) !== null) {
        if (m[1] && envSet.has(m[1])) seen.add(m[1])
      }
      if (seen.size === 0) continue

      /** @type {Evidence} */
      const evidence = { file: rel, line: i + 1, snippet: line.trim().slice(0, 240), scope }

      for (const token of seen) {
        const bucket = index[token]
        bucket.matches.push(evidence)
      }

      // Property blocks: ":: **Environment Variable**: `ENV`" style (common in language-specific config pages).
      if (seen.size === 1 && /Environment Variable/i.test(line)) {
        const [token] = Array.from(seen)
        const block = extractEnvVarPropertyBlock(lines, i)
        const bucket = index[token]
        if (block.description) {
          const d = normalizeDocsDescriptionMarkdown(block.description)
          if (d) bucket.descriptionCandidates.push({ value: d, scope, evidence })
        }
        if (block.default) {
          const dv = normalizeDocsDefaultValue(block.default)
          if (dv) bucket.defaultCandidates.push({ value: dv, scope, evidence })
        }
      }

      // Definition-list style blocks (used heavily in the official "library_config" docs).
      // Only attempt this when the line is *just* the env var token (optionally wrapped in backticks).
      if (seen.size === 1) {
        const [token] = Array.from(seen)
        const trimmed = line.trim()
        const unwrapped = trimmed.replace(/^`/, '').replace(/`$/, '').trim()
        if (unwrapped === token) {
          const block = extractDefinitionListBlock(lines, i)
          const bucket = index[token]
          if (block.supportedInput) {
            const t = normalizeDocType(block.supportedInput)
            if (t) {
              bucket.docTypes.push(t)
              bucket.docTypeEvidence.push(evidence)
              bucket.typeCandidates.push({ value: t, scope, evidence })
            }
          }
          if (block.description) {
            const d = normalizeDocsDescriptionMarkdown(block.description)
            if (d) bucket.descriptionCandidates.push({ value: d, scope, evidence })
          }
          if (block.default) {
            const dv = normalizeDocsDefaultValue(block.default)
            if (dv) bucket.defaultCandidates.push({ value: dv, scope, evidence })
          }
        }
      }

      // If inside a table, attempt to extract columns from the same row.
      const rowCells = splitTableRow(line)
      if (tableHeader && rowCells) {
        const typeIdx =
          tableHeader.headerIndexByName.type ??
          tableHeader.headerIndexByName['value type'] ??
          tableHeader.headerIndexByName.format
        const descIdx =
          tableHeader.headerIndexByName.description ??
          tableHeader.headerIndexByName.details ??
          tableHeader.headerIndexByName.meaning
        const defaultIdx =
          tableHeader.headerIndexByName.default ??
          tableHeader.headerIndexByName.defaults ??
          tableHeader.headerIndexByName['default value']

        for (const token of seen) {
          const bucket = index[token]
          if (typeof typeIdx === 'number' && rowCells[typeIdx]) {
            const t = normalizeDocType(rowCells[typeIdx])
            if (t) {
              bucket.docTypes.push(t)
              bucket.docTypeEvidence.push(evidence)
              bucket.typeCandidates.push({ value: t, scope, evidence })
            }
          }
          if (typeof descIdx === 'number' && rowCells[descIdx]) {
            const d = normalizeDocsDescriptionMarkdown(rowCells[descIdx])
            if (d) bucket.descriptionCandidates.push({ value: d, scope, evidence })
          }
          if (typeof defaultIdx === 'number' && rowCells[defaultIdx]) {
            const dv = normalizeDocsDefaultValue(rowCells[defaultIdx])
            if (dv) bucket.defaultCandidates.push({ value: dv, scope, evidence })
          }
        }
      }

      // Prose defaults: only as an additional pass, and only when we are not in a table.
      if (includeProseDefaults && !tableHeader) {
        const proseDefault = extractProseDefaultCandidate(lines, i)
        if (proseDefault) {
          for (const token of seen) {
            const bucket = index[token]
            const dv = normalizeDocsDefaultValue(proseDefault)
            if (dv) bucket.defaultCandidates.push({ value: dv, scope, evidence })
          }
        }
      }
    }
  }

  // Normalize docTypes to unique per env var
  for (const env of envVars) {
    index[env].docTypes = Array.from(new Set(index[env].docTypes))
  }

  return index
}

function main () {
  const docsDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DOCS_DIR
  const supported = readJSON(SUPPORTED_JSON_PATH)
  const supportedConfigurations = supported.supportedConfigurations || {}
  const envVars = Object.keys(supportedConfigurations).sort()

  const indexTableOnly = scanDocsForEnvVars(docsDir, envVars, { includeProseDefaults: false })
  const indexWithProse = scanDocsForEnvVars(docsDir, envVars, { includeProseDefaults: true })

  const countDefaultCoverage = (idx) => envVars.filter(v => (idx[v]?.defaultCandidates || []).length > 0).length
  const tableDefaults = countDefaultCoverage(indexTableOnly)
  const proseDefaults = countDefaultCoverage(indexWithProse)
  const useProse = proseDefaults > tableDefaults
  const index = useProse ? indexWithProse : indexTableOnly

  /** @type {{ envVar: string, supportedType: string, docsTypes: string[], evidence: { file: string, line: number, snippet: string }[] }[]} */
  const typeConflicts = []
  /** @type {{ envVar: string, docsTypes: string[], evidence: { file: string, line: number, snippet: string }[] }[]} */
  const docsTypeSuggestions = []

  for (const envVar of envVars) {
    const entry = supportedConfigurations[envVar]?.[0]
    const supportedType = entry?.type
    const docsTypes = index[envVar].docTypes

    if (docsTypes.length === 0) continue

    if (supportedType === '__UNKNOWN__') {
      docsTypeSuggestions.push({
        envVar,
        docsTypes,
        evidence: index[envVar].docTypeEvidence.slice(0, 5)
      })
      continue
    }

    if (!docsTypes.includes(supportedType)) {
      typeConflicts.push({
        envVar,
        supportedType,
        docsTypes,
        evidence: index[envVar].docTypeEvidence.slice(0, 5)
      })
    }
  }

  const report = {
    docsDir,
    supportedVersion: supported.version,
    envVarCount: envVars.length,
    matchedEnvVarCount: envVars.filter(v => index[v].matches.length > 0).length,
    defaultCandidateCoverage: { tableOnly: tableDefaults, withProse: proseDefaults, used: useProse ? 'withProse' : 'tableOnly' },
    typeConflicts,
    docsTypeSuggestions,
    matchesByEnvVar: index
  }

  writeJSON(REPORT_PATH, report)
  process.stdout.write(`Wrote ${REPORT_PATH}\n`)
  process.stdout.write(`type conflicts: ${typeConflicts.length}\n`)
  process.stdout.write(`docs type suggestions (supported type unknown): ${docsTypeSuggestions.length}\n`)
}

if (require.main === module) {
  main()
}

