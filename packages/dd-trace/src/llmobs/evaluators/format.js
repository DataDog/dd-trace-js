'use strict'

const { BaseEvaluator, assertOptionalFunction, booleanResult } = require('./base')
const { toText } = require('./util')

const COUNT_TYPES = new Set(['characters', 'words', 'lines'])

/**
 * @param {string} text
 * @param {string} countType
 * @returns {number}
 */
function measure (text, countType) {
  if (countType === 'characters') return text.length
  if (countType === 'words') return text.split(/\s+/).filter(Boolean).length
  return text.split(/\r\n|\r|\n/).filter((line, index, lines) => index < lines.length - 1 || line !== '').length
}

/**
 * Validates that the output length falls within inclusive `minLength` / `maxLength` bounds.
 */
class LengthEvaluator extends BaseEvaluator {
  /**
   * @param {object} [options]
   * @param {number} [options.minLength] Minimum allowed length (inclusive).
   * @param {number} [options.maxLength] Maximum allowed length (inclusive).
   * @param {'characters' | 'words' | 'lines'} [options.countType] What to count. Default `'characters'`.
   * @param {(output: unknown) => unknown} [options.outputExtractor] Transform applied to the output first.
   * @param {string} [options.name]
   */
  constructor ({ minLength, maxLength, countType = 'characters', outputExtractor, name } = {}) {
    super(name)

    if (!COUNT_TYPES.has(countType)) {
      throw new Error(`countType must be 'characters', 'words', or 'lines', got: ${countType}`)
    }
    if (minLength != null && minLength < 0) throw new Error(`minLength must be non-negative, got: ${minLength}`)
    if (maxLength != null && maxLength < 0) throw new Error(`maxLength must be non-negative, got: ${maxLength}`)
    if (minLength != null && maxLength != null && minLength > maxLength) {
      throw new Error(`minLength (${minLength}) cannot be greater than maxLength (${maxLength})`)
    }
    if (minLength == null && maxLength == null) {
      throw new Error('At least one of minLength or maxLength must be specified')
    }
    assertOptionalFunction(outputExtractor, 'output_extractor')

    this.minLength = minLength ?? null
    this.maxLength = maxLength ?? null
    this.countType = countType
    this.outputExtractor = outputExtractor ?? null
  }

  evaluate (context) {
    let output = context.outputData
    if (this.outputExtractor !== null) output = this.outputExtractor(output)
    if (output == null) return booleanResult(false)

    const length = measure(toText(output), this.countType)
    if (this.minLength !== null && length < this.minLength) return booleanResult(false)
    if (this.maxLength !== null && length > this.maxLength) return booleanResult(false)
    return booleanResult(true)
  }
}

/**
 * Validates that the output is JSON (or an already-parsed object/array) and
 * optionally contains every `requiredKeys` entry.
 */
class JSONEvaluator extends BaseEvaluator {
  /**
   * @param {object} [options]
   * @param {string[]} [options.requiredKeys] Keys that must be present when the parsed value is an object.
   * @param {(output: unknown) => unknown} [options.outputExtractor] Transform applied to the output first.
   * @param {string} [options.name]
   */
  constructor ({ requiredKeys, outputExtractor, name } = {}) {
    super(name)
    assertOptionalFunction(outputExtractor, 'output_extractor')
    this.requiredKeys = requiredKeys ?? []
    this.outputExtractor = outputExtractor ?? null
  }

  evaluate (context) {
    let output = context.outputData
    if (this.outputExtractor !== null) output = this.outputExtractor(output)
    if (output == null) return booleanResult(false)

    let parsed
    if (typeof output === 'object') {
      parsed = output
    } else {
      try {
        parsed = JSON.parse(String(output))
      } catch {
        return booleanResult(false)
      }
    }

    if (this.requiredKeys.length > 0 && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of this.requiredKeys) {
        if (!Object.hasOwn(parsed, key)) return booleanResult(false)
      }
    }
    return booleanResult(true)
  }
}

module.exports = { JSONEvaluator, LengthEvaluator }
