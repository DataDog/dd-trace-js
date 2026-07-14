'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')

const TARGET_SUFFIX = path.join('@genkit-ai', 'core', 'lib', 'tracing', 'instrumentation.js')
const OUTPUT_PATH = process.env.GENKIT_CONTEXT_OUTPUT

if (!OUTPUT_PATH) throw new Error('GENKIT_CONTEXT_OUTPUT is required')

const storage = new AsyncLocalStorage()
const records = []
const originalLoad = Module._load
let nextCaptureId = 1

function classify (labels) {
  const subtype = labels?.['genkit:metadata:subtype']
  const type = labels?.['genkit:type']

  if (subtype === 'model') return 'generation'
  if (subtype === 'flow' || type === 'flowStep') return 'workflow'
  if (subtype === 'tool') return 'tool'
  if (subtype === 'retriever') return 'retrieval'
  if (subtype === 'embedder') return 'embedding'
}

function sanitizeString (value, key, operation) {
  if (key === 'output' && (value.startsWith('{') || value.startsWith('['))) {
    try {
      return sanitize(JSON.parse(value), key, operation)
    } catch {}
  }
  return value.length > 500 ? `${value.slice(0, 500)}[truncated]` : value
}

function sanitize (value, key = '', operation) {
  if (value === undefined) return '[undefined]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return sanitizeString(value, key, operation)
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (value instanceof Error) return { name: value.name, message: value.message }

  if (Array.isArray(value)) {
    if (operation === 'embedding' && key === 'embedding' && value.every(item => typeof item === 'number')) {
      return { omittedNumericVector: true, dimensions: value.length }
    }
    return value.slice(0, 20).map(item => sanitize(item, key, operation))
  }

  if (typeof value === 'object') {
    const result = {}
    for (const [property, item] of Object.entries(value)) {
      const isUsageMetric = /^(inputTokens|outputTokens|totalTokens|thoughtsTokens|cachedContentTokens)$/i.test(property)
      if (!isUsageMetric && /secret|token|password|authorization|api.?key/i.test(property)) {
        result[property] = '[redacted]'
      } else if (/^(raw|custom|media|data)$/i.test(property)) {
        result[property] = '[omitted]'
      } else {
        result[property] = sanitize(item, property, operation)
      }
    }
    return result
  }

  return String(value)
}

function getOptions (args) {
  return args.length === 3 ? args[1] : args[0]
}

function writeOutput () {
  const byId = new Map(records.map(record => [record.captureId, record]))
  for (const record of records) {
    let parentId = record.parentCaptureId
    while (parentId && !byId.get(parentId)?.operation) parentId = byId.get(parentId)?.parentCaptureId
    record.selectedParentCaptureId = parentId || null
  }

  const selected = records.filter(record => record.operation)
  const output = {
    schemaVersion: 1,
    target: '@genkit-ai/core@1.21.0 runInNewSpan',
    captureMethod: 'CommonJS preload Module._load proxy around the real exported runInNewSpan function',
    captureCount: records.length,
    selectedCaptureCount: selected.length,
    operationCounts: selected.reduce((counts, record) => {
      counts[record.operation] = (counts[record.operation] || 0) + 1
      return counts
    }, {}),
    nestingIndex: records.map(record => ({
      captureId: record.captureId,
      parentCaptureId: record.parentCaptureId,
      selectedParentCaptureId: record.selectedParentCaptureId,
      operation: record.operation,
      name: record.metadataAfter?.name || record.metadataBefore?.name,
      labels: record.labelsBefore,
      completion: record.completion,
      nativeSpan: record.nativeSpan,
    })),
    records: selected,
  }
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`)
}

Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain)
  const exports = originalLoad.apply(this, arguments)
  if (!resolved.endsWith(TARGET_SUFFIX)) return exports

  return new Proxy(exports, {
    get (target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'runInNewSpan' || typeof value !== 'function') return value

      return function capturedRunInNewSpan (...args) {
        const opts = getOptions(args)
        const operation = classify(opts?.labels)
        const parent = storage.getStore()
        const record = {
          captureId: nextCaptureId++,
          parentCaptureId: parent?.captureId || null,
          selectedParentCaptureId: null,
          operation: operation || null,
          argumentCount: args.length,
          optionsArgumentIndex: args.length === 3 ? 1 : 0,
          labelsBefore: sanitize(opts?.labels, 'labels', operation),
          metadataBefore: sanitize(opts?.metadata, 'metadata', operation),
          nativeSpan: null,
          metadataAfter: null,
          result: null,
          error: null,
          completion: null,
        }
        records.push(record)

        const functionIndex = args.length === 3 ? 2 : 1
        const originalFunction = args[functionIndex]
        args[functionIndex] = function capturedCallback (...callbackArgs) {
          const nativeSpan = callbackArgs[1]
          const spanContext = nativeSpan?.spanContext?.()
          if (spanContext) {
            record.nativeSpan = {
              traceId: spanContext.traceId,
              spanId: spanContext.spanId,
            }
          }
          return originalFunction.apply(this, callbackArgs)
        }

        return storage.run(record, async () => {
          try {
            const result = await value.apply(this, args)
            record.result = sanitize(result, 'result', operation)
            record.completion = 'success'
            return result
          } catch (error) {
            record.error = sanitize(error, 'error', operation)
            record.completion = 'error'
            throw error
          } finally {
            record.metadataAfter = sanitize(opts?.metadata, 'metadata', operation)
          }
        })
      }
    },
  })
}

process.once('exit', writeOutput)
