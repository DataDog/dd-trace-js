'use strict'

const log = require('../log')
const {
  LLMOBS_PARENT_ID_BRIDGE_KEY,
  LLMOBS_TRACE_ID_BRIDGE_KEY,
  SPAN_KINDS,
} = require('./constants/tags')

// LLM I/O is overwhelmingly ASCII (English prompts and code). Walk once
// looking for the first non-ASCII char; if there is none, hand the input
// straight back. Otherwise pick up the slow path from the byte that needed
// escaping. ~5x faster on typical prompt strings than the per-char `+=`
// loop the function used to do unconditionally.
function encodeUnicode (str = '') {
  for (let index = 0; index < str.length; index++) {
    if (str.charCodeAt(index) > 127) {
      let result = str.slice(0, index)
      // eslint-disable-next-line sonarjs/updated-loop-counter -- inner loop continues from outer position
      for (; index < str.length; index++) {
        const code = str.charCodeAt(index)
        result += code > 127 ? String.raw`\u${code.toString(16).padStart(4, '0')}` : str[index]
      }
      return result
    }
  }
  return str
}

function validateKind (kind) {
  if (!SPAN_KINDS.includes(kind)) {
    throw new Error(`
      Invalid span kind specified: "${kind}"
      Must be one of: ${SPAN_KINDS.join(', ')}
    `)
  }

  return kind
}

/**
 * Validates cost tag keys and records telemetry for the annotation source.
 * @param {import('../opentracing/span')} span
 * @param {unknown} costTags
 * @param {string} source
 * @param {Record<string, unknown>} spanTags
 * @returns {string[]}
 */
function validateCostTags (span, costTags, source, spanTags) {
  // Lazy-required to avoid the `index.js -> telemetry -> tagger -> util` module cycle.
  const telemetry = require('./telemetry')

  telemetry.recordCostTagsAnnotated(span, source)

  if (!Array.isArray(costTags)) {
    log.warn('costTags must be an array of strings. Ignoring value.')
    telemetry.recordCostTagsSubmitted(span, 1, source, 'error', 'non_list')
    return []
  }

  const validatedCostTags = new Set()
  let nonStringEntries = 0
  let missingSpanTags = 0

  for (const costTag of costTags) {
    if (typeof costTag !== 'string') {
      log.warn('costTags entries must be strings. Skipping entry %s.', costTag)
      nonStringEntries++
      continue
    }
    if (!Object.hasOwn(spanTags, costTag)) {
      log.warn('costTags entry "%s" must reference a key present in span tags. Skipping entry.', costTag)
      missingSpanTags++
      continue
    }
    validatedCostTags.add(costTag)
  }

  if (nonStringEntries) {
    telemetry.recordCostTagsSubmitted(span, nonStringEntries, source, 'error', 'non_string_entry')
  }
  if (missingSpanTags) {
    telemetry.recordCostTagsSubmitted(span, missingSpanTags, source, 'error', 'missing_span_tag')
  }
  if (validatedCostTags.size) {
    telemetry.recordCostTagsSubmitted(span, validatedCostTags.size, source, 'success')
  }

  return [...validatedCostTags]
}

// Validates tool definition entires
function validateToolDefinitions (toolDefinitions) {
  if (!Array.isArray(toolDefinitions)) {
    log.warn('toolDefinitions must be an array.')
    return []
  }
  const validated = []

  for (let i = 0; i < toolDefinitions.length; i++) {
    const currToolDef = toolDefinitions[i]
    if (!currToolDef || typeof currToolDef !== 'object') {
      log.warn('Tool definition at index %d must be an object. Skipping.', i)
      continue
    }

    // Name is not optional
    if (!currToolDef.name || typeof currToolDef.name !== 'string' || currToolDef.name.length <= 0) {
      log.warn('Tool definition at index %d must have a non empty string "name". Skipping.', i)
      continue
    }
    const validatedToolDef = { name: currToolDef.name }

    // Description, Schema, and Version are optional types
    if (currToolDef.description !== undefined) {
      if (typeof currToolDef.description === 'string') {
        validatedToolDef.description = currToolDef.description
      } else {
        log.warn('Tool definition "description" at index %d must be a string. Skipping field.', i)
      }
    }

    if (currToolDef.schema !== undefined) {
      if (currToolDef.schema !== null && typeof currToolDef.schema === 'object' && !Array.isArray(currToolDef.schema)) {
        validatedToolDef.schema = currToolDef.schema
      } else {
        log.warn('Tool definition "schema" at index %d must be a plain object. Skipping field.', i)
      }
    }

    if (currToolDef.version !== undefined) {
      if (typeof currToolDef.version === 'string') {
        validatedToolDef.version = currToolDef.version
      } else {
        log.warn('Tool definition "version" at index %d must be a string. Skipping field.', i)
      }
    }

    validated.push(validatedToolDef)
  }

  return validated
}

// extracts the argument names from a function string
function parseArgumentNames (str) {
  const result = []
  let current = ''
  let closerCount = 0
  let recording = true
  let inSingleLineComment = false
  let inMultiLineComment = false

  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    const nextChar = str[i + 1]

    // Handle single-line comments
    if (!inMultiLineComment && char === '/' && nextChar === '/') {
      inSingleLineComment = true
      i++ // Skip the next character
      continue
    }

    // Handle multi-line comments
    if (!inSingleLineComment && char === '/' && nextChar === '*') {
      inMultiLineComment = true
      i++ // Skip the next character
      continue
    }

    // End of single-line comment
    if (inSingleLineComment && char === '\n') {
      inSingleLineComment = false
      continue
    }

    // End of multi-line comment
    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false
      i++ // Skip the next character
      continue
    }

    // Skip characters inside comments
    if (inSingleLineComment || inMultiLineComment) {
      continue
    }

    if (['{', '[', '('].includes(char)) {
      closerCount++
    } else if (['}', ']', ')'].includes(char)) {
      closerCount--
    } else if (char === '=' && nextChar !== '>' && closerCount === 0) {
      recording = false
      // record the variable name early, and stop counting characters until we reach the next comma
      result.push(current.trim())
      current = ''
      continue
    } else if (char === ',' && closerCount === 0) {
      if (recording) {
        result.push(current.trim())
        current = ''
      }

      recording = true
      continue
    }

    if (recording) {
      current += char
    }
  }

  if (current && recording) {
    result.push(current.trim())
  }

  return result
}

// finds the bounds of the arguments in a function string
function findArgumentsBounds (str) {
  let start = -1
  let end = -1
  let closerCount = 0

  // TODO(BridgeAR): This "breaks" up codePoints.
  // Investigate if this is a problem.
  for (let i = 0; i < str.length; i++) {
    const char = str[i]

    if (char === '(') {
      if (closerCount === 0) {
        start = i
      }

      closerCount++
    } else if (char === ')') {
      closerCount--

      if (closerCount === 0) {
        end = i
        break
      }
    }
  }

  return { start, end }
}

const memo = new WeakMap()
function getFunctionArguments (fn, args = []) {
  if (!fn) return
  if (!args.length) return
  if (args.length === 1) return args[0]

  try {
    let names
    if (memo.has(fn)) {
      names = memo.get(fn)
    } else {
      const fnString = fn.toString()
      const { start, end } = findArgumentsBounds(fnString)
      names = parseArgumentNames(fnString.slice(start + 1, end))
      memo.set(fn, names)
    }

    const argsObject = {}

    for (const argIdx in args) {
      const name = names[argIdx]
      const arg = args[argIdx]

      const spread = name?.startsWith('...')

      // this can only be the last argument
      if (spread) {
        argsObject[name.slice(3)] = args.slice(argIdx)
        break
      }

      argsObject[name] = arg
    }

    return argsObject
  } catch {
    return args
  }
}

function spanHasError (span) {
  const spanContext = span.context()
  return !!(spanContext.getTag('error') || spanContext.getTag('error.type'))
}

// LLM SDKs stream tool-call argument JSON across SSE chunks; a malformed
// accumulation would otherwise throw straight into the chunk subscriber.
function safeJsonParse (value, fallback) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback === undefined ? value : fallback
  }
}

// Bridge tags read by the trace-indexer to pull OTel `gen_ai.*` spans into
// the same LLMObs trace. Written once per local trace (first-writer wins on
// `_trace.tags`). Pass `includeParentId: false` when the span sits below an
// OTel `gen_ai.*` ancestor — without it the indexer treats this span as the
// LLMObs root and hoists the gen_ai ancestors under it, inverting the trace.
/**
 * @param {import('../opentracing/span')} span
 * @param {{ includeParentId?: boolean }} [opts]
 */
function writeBridgeTags (span, { includeParentId = true } = {}) {
  const traceTags = span?.context?.()._trace?.tags
  if (!traceTags || traceTags[LLMOBS_TRACE_ID_BRIDGE_KEY]) return
  traceTags[LLMOBS_TRACE_ID_BRIDGE_KEY] = span.context().toTraceId(true)
  if (includeParentId) {
    traceTags[LLMOBS_PARENT_ID_BRIDGE_KEY] = span.context().toSpanId()
  }
}

// Walks the APM parent chain for the nearest ancestor with any `gen_ai.*`
// tag. Lets an auto-instrumented LLMObs span nested under a manual OTel
// workflow point its `parent_id` at the OTel parent so the SDK-emitted
// event renders under it instead of as a parallel root.
/**
 * @param {import('../opentracing/span')} span
 * @returns {string | null}
 */
function findGenAIAncestorSpanId (span) {
  const ctx = span?.context?.()
  let parentId = ctx?._parentId?.toString(10)
  if (!parentId || parentId === '0') return null

  const started = ctx._trace?.started
  if (!started || started.length === 0) return null

  // Linear scan per hop — parent chains are short, avoids a per-call Map.
  while (parentId && parentId !== '0') {
    let parent = null
    for (const s of started) {
      if (s.context()._spanId.toString(10) === parentId) {
        parent = s
        break
      }
    }
    if (!parent) return null

    const tags = parent.context().getTags()
    if (tags) {
      for (const key of Object.keys(tags)) {
        if (key.startsWith('gen_ai.')) return parentId
      }
    }

    parentId = parent.context()._parentId?.toString(10)
  }
  return null
}

module.exports = {
  encodeUnicode,
  findGenAIAncestorSpanId,
  validateCostTags,
  validateKind,
  getFunctionArguments,
  safeJsonParse,
  spanHasError,
  writeBridgeTags,
  validateToolDefinitions,
}
