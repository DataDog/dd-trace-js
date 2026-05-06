'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const CHECK_FLAG = '--check'
const OUTPUT_PATH_IN_REPOSITORY = 'packages/dd-trace/src/config/generated-config-types.d.ts'
const SUPPORTED_CONFIGURATIONS_PATH = path.join(
  __dirname,
  '..',
  'packages/dd-trace/src/config/supported-configurations.json'
)
const OUTPUT_PATH = path.join(
  __dirname,
  '..',
  'packages/dd-trace/src/config/generated-config-types.d.ts'
)
const CONFIG_INDEX_PATH = path.join(
  __dirname,
  '..',
  'packages/dd-trace/src/config/index.js'
)

const BASE_TYPES = {
  array: 'string[]',
  boolean: 'boolean',
  decimal: 'number',
  int: 'number',
  json: 'unknown',
  map: 'Record<string, string>',
  string: 'string',
}

const SIMPLE_ALLOWED_VALUE = /^[A-Za-z0-9 _./:-]+$/
const PROPERTY_TYPE_OVERRIDES = {
  'dogstatsd.port': 'string | number',
  port: 'string | number',
  samplingRules: "import('../../../../index').SamplingRule[]",
  spanSamplingRules: "import('../../../../index').SpanSamplingRule[]",
  url: 'string | URL',
}
const TRANSFORM_TYPE_OVERRIDES = {
  normalizeProfilingEnabled: "'true' | 'false' | 'auto'",
  parseOtelTags: 'Record<string, string>',
  sampleRate: 'number',
  setGRPCRange: 'number[]',
  splitJSONPathRules: 'string[]',
}

function createTreeNode () {
  return {
    children: new Map(),
    type: undefined,
  }
}

function getPropertyName (canonicalName, entry) {
  const configurationNames = entry.internalPropertyName ? [entry.internalPropertyName] : entry.configurationNames
  return configurationNames?.[0] ?? canonicalName
}

const FALLBACK_PATTERN =
  /if\s*\(\s*!\s*this\.([\w.]+)\s*\)\s*\{[\s\S]*?setAndTrack\s*\(\s*this\s*,\s*['"]([\w.]+)['"]\s*,/g

// Expression whose tail (after any top-level `||`/`??`, or the whole expression) is a string or
// template literal — i.e. the result is guaranteed defined at runtime.
const GUARANTEED_DEFINED = /(?:^|\|\||\?\?)\s*(?:'[^']*'|"[^"]*"|`(?:\$\{[^}`]*\}|[^`])*`)\s*$/

// Returns the index right after the `close` that balances the `open` preceding `start`, or -1 if
// unbalanced. Skips over string and template literals so their contents don't affect depth.
function balancedEnd (s, start, open, close) {
  let depth = 1
  let i = start
  while (i < s.length) {
    const ch = s[i]
    if (ch === open) {
      depth++
      i++
    } else if (ch === close) {
      i++
      if (--depth === 0) return i
    } else if (ch === '"' || ch === '\'' || ch === '`') {
      i = skipQuoted(s, i, ch)
    } else {
      i++
    }
  }
  return -1
}

function skipQuoted (s, i, quote) {
  const isTemplate = quote === '`'
  i++
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue }
    if (s[i] === quote) return i + 1
    if (isTemplate && s[i] === '$' && s[i + 1] === '{') {
      i = balancedEnd(s, i + 2, '{', '}')
      if (i === -1) return s.length
      continue
    }
    i++
  }
  return i
}

function findCalculatedFallbackProperties () {
  const source = readFileSync(CONFIG_INDEX_PATH, 'utf8')
  const marker = /#applyCalculated\s*\(\s*\)\s*\{/.exec(source)
  if (!marker) throw new Error('Could not locate #applyCalculated() in config/index.js')

  const bodyStart = marker.index + marker[0].length
  const body = source.slice(bodyStart, balancedEnd(source, bodyStart, '{', '}') - 1)

  const properties = new Set()
  let match
  while ((match = FALLBACK_PATTERN.exec(body)) !== null) {
    if (match[1] !== match[2]) continue
    const valueStart = match.index + match[0].length
    const valueEnd = balancedEnd(body, valueStart, '(', ')')
    if (valueEnd === -1) continue
    const value = body.slice(valueStart, valueEnd - 1).trim()
    if (GUARANTEED_DEFINED.test(value)) properties.add(match[1])
  }
  return properties
}

const CALCULATED_FALLBACK_PROPERTIES = findCalculatedFallbackProperties()

function withUndefined (type, entry, propertyName) {
  if (entry.default !== null) return type
  if (CALCULATED_FALLBACK_PROPERTIES.has(propertyName)) return type
  return `${type} | undefined`
}

function getAllowedType (entry) {
  if (!entry.allowed) {
    return
  }

  const values = entry.allowed.split('|')
  if (values.length === 0 || values.some(value => !SIMPLE_ALLOWED_VALUE.test(value))) {
    return
  }

  const normalizedValues = values.map(value => {
    if (entry.transform === 'toLowerCase') {
      return value.toLowerCase()
    }
    if (entry.transform === 'toUpperCase') {
      return value.toUpperCase()
    }
    return value
  })

  return normalizedValues
    .map(value => JSON.stringify(value))
    .join(' | ')
}

function getTypeForEntry (propertyName, entry) {
  const override = PROPERTY_TYPE_OVERRIDES[propertyName] ??
    TRANSFORM_TYPE_OVERRIDES[entry.transform] ??
    getAllowedType(entry) ??
    BASE_TYPES[entry.type]

  if (!override) {
    throw new Error(`Unsupported configuration type for ${propertyName}: ${entry.type}`)
  }

  return withUndefined(override, entry, propertyName)
}

function addProperty (root, propertyName, type) {
  const parts = propertyName.split('.')
  let node = root

  for (const part of parts) {
    node.children.set(part, node.children.get(part) ?? createTreeNode())
    node = node.children.get(part)
  }

  if (node.type && node.type !== type) {
    throw new Error(`Conflicting generated types for ${propertyName}: ${node.type} !== ${type}`)
  }

  node.type = type
}

function renderPropertyName (name) {
  return /^[$A-Z_a-z][$\w]*$/.test(name) ? name : JSON.stringify(name)
}

function renderNode (node, indentLevel = 0) {
  const indent = '  '.repeat(indentLevel)

  if (node.children.size === 0) {
    return /** @type {string} */ (node.type)
  }

  const objectBody = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => {
      return `${indent}  ${renderPropertyName(key)}: ${renderNode(child, indentLevel + 1)};`
    })
    .join('\n')
  const objectType = `{\n${objectBody}\n${indent}}`

  if (!node.type) {
    return objectType
  }

  return `${node.type} | ${objectType}`
}

function generateConfigTypes () {
  const { supportedConfigurations } = JSON.parse(readFileSync(SUPPORTED_CONFIGURATIONS_PATH, 'utf8'))
  const root = createTreeNode()

  for (const [canonicalName, entries] of Object.entries(supportedConfigurations)) {
    if (entries.length !== 1) {
      throw new Error(
        `Multiple entries found for canonical name: ${canonicalName}. ` +
        'This is currently not supported and must be implemented, if needed.'
      )
    }

    const [entry] = entries
    const propertyName = getPropertyName(canonicalName, entry)
    const type = getTypeForEntry(propertyName, entry)

    addProperty(root, propertyName, type)
  }

  return (
    '// This file is generated from packages/dd-trace/src/config/supported-configurations.json\n' +
    '// by scripts/generate-config-types.js. Do not edit this file directly.\n\n' +
    'export interface GeneratedConfig ' +
    renderNode(root) +
    '\n'
  )
}

function normalizeLineEndings (value) {
  return value.replaceAll('\r\n', '\n')
}

function writeGeneratedConfigTypes () {
  const output = generateConfigTypes()
  writeFileSync(OUTPUT_PATH, output)
  return output
}

function checkGeneratedConfigTypes () {
  const generated = generateConfigTypes()

  const current = normalizeLineEndings(readFileSync(OUTPUT_PATH, 'utf8'))
  if (current === generated) {
    return true
  }

  // eslint-disable-next-line no-console
  console.error(`❌ Generated config types are out of date.

The checked-in generated file does not match the current source-of-truth inputs:
- packages/dd-trace/src/config/supported-configurations.json
- index.d.ts

To regenerate it locally, run:
  npm run generate:config:types

Then commit the updated file:
  ${OUTPUT_PATH_IN_REPOSITORY}
`)
  return false
}

if (require.main === module) {
  if (process.argv.includes(CHECK_FLAG)) {
    process.exitCode = checkGeneratedConfigTypes() ? 0 : 1
  } else {
    writeGeneratedConfigTypes()
  }
}

module.exports = {
  checkGeneratedConfigTypes,
  generateConfigTypes,
  OUTPUT_PATH,
  SUPPORTED_CONFIGURATIONS_PATH,
  writeGeneratedConfigTypes,
}
