'use strict'

const { BaseEvaluator, EvaluatorResult } = require('./evaluator')

function optionsOrEmpty (options) {
  if (options == null) return {}
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Evaluator options must be an object')
  }
  return options
}

function option (options, camelName, snakeName) {
  return options[camelName] ?? options[snakeName]
}

function validateExtractor (extractor, name) {
  if (extractor !== undefined && typeof extractor !== 'function') {
    throw new TypeError(`${name} must be a callable function`)
  }
}

function assessment (value) {
  return value ? 'pass' : 'fail'
}

function isPromiseLike (value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function'
}

/**
 * Evaluator that validates output length constraints.
 */
class LengthEvaluator extends BaseEvaluator {
  /**
   * @param {{minLength?: number, maxLength?: number, countType?: string, outputExtractor?: Function,
   *   name?: string}} [options]
   */
  constructor (options = {}) {
    const values = optionsOrEmpty(options)
    super(option(values, 'name', 'name'))

    const minLength = option(values, 'minLength', 'min_length')
    const maxLength = option(values, 'maxLength', 'max_length')
    const countType = values.countType ?? values.count_type ?? 'characters'
    const outputExtractor = values.outputExtractor ?? values.output_extractor

    if (!['characters', 'words', 'lines'].includes(countType)) {
      throw new Error(`countType must be 'characters', 'words', or 'lines', got: ${countType}`)
    }
    if (minLength !== undefined && (!Number.isFinite(minLength) || minLength < 0)) {
      throw new Error(`minLength must be non-negative, got: ${minLength}`)
    }
    if (maxLength !== undefined && (!Number.isFinite(maxLength) || maxLength < 0)) {
      throw new Error(`maxLength must be non-negative, got: ${maxLength}`)
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new Error(`minLength (${minLength}) cannot be greater than maxLength (${maxLength})`)
    }
    if (minLength === undefined && maxLength === undefined) {
      throw new Error('At least one of minLength or maxLength must be specified')
    }
    validateExtractor(outputExtractor, 'outputExtractor')

    this.minLength = minLength
    this.maxLength = maxLength
    this.countType = countType
    this.outputExtractor = outputExtractor
  }

  /**
   * @param {string} text
   */
  _calculateLength (text) {
    if (this.countType === 'characters') return text.length
    if (this.countType === 'words') return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
    return text === '' ? 0 : text.split(/\r\n|[\r\n]/).length
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @returns {EvaluatorResult}
   */
  evaluate (context) {
    let output = context.outputData
    if (this.outputExtractor) output = this.outputExtractor(output)
    if (output == null) return new EvaluatorResult(false, { assessment: 'fail' })

    const length = this._calculateLength(String(output))
    const valid = (this.minLength === undefined || length >= this.minLength) &&
      (this.maxLength === undefined || length <= this.maxLength)
    return new EvaluatorResult(valid, { assessment: assessment(valid) })
  }
}

/**
 * Evaluator that validates whether output is JSON and optionally contains required keys.
 */
class JSONEvaluator extends BaseEvaluator {
  /**
   * @param {{requiredKeys?: string[], outputExtractor?: Function, name?: string}} [options]
   */
  constructor (options = {}) {
    const values = optionsOrEmpty(options)
    super(option(values, 'name', 'name'))
    const outputExtractor = values.outputExtractor ?? values.output_extractor
    validateExtractor(outputExtractor, 'outputExtractor')

    this.requiredKeys = values.requiredKeys ?? values.required_keys ?? []
    this.outputExtractor = outputExtractor
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @returns {EvaluatorResult}
   */
  evaluate (context) {
    let output = context.outputData
    if (this.outputExtractor) output = this.outputExtractor(output)
    if (output == null) return new EvaluatorResult(false, { assessment: 'fail' })

    let parsed
    if (Array.isArray(output) || (typeof output === 'object' && output !== null)) {
      parsed = output
    } else {
      try {
        parsed = JSON.parse(String(output))
      } catch {
        return new EvaluatorResult(false, { assessment: 'fail' })
      }
    }

    const valid = !this.requiredKeys.some(key => {
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && !Object.hasOwn(parsed, key)
    })
    return new EvaluatorResult(valid, { assessment: assessment(valid) })
  }
}

/**
 * Evaluator that compares output and expected output as strings.
 */
class StringCheckEvaluator extends BaseEvaluator {
  /**
   * @param {{operation?: string, caseSensitive?: boolean, stripWhitespace?: boolean, outputExtractor?: Function,
   *   expectedOutputExtractor?: Function, name?: string}} [options]
   */
  constructor (options = {}) {
    const values = optionsOrEmpty(options)
    super(option(values, 'name', 'name'))
    const operation = values.operation ?? 'eq'
    const outputExtractor = values.outputExtractor ?? values.output_extractor
    const expectedOutputExtractor = values.expectedOutputExtractor ?? values.expected_output_extractor

    if (!['eq', 'ne', 'contains', 'icontains'].includes(operation)) {
      throw new Error(`operation must be one of eq, ne, contains, icontains, got: ${operation}`)
    }
    validateExtractor(outputExtractor, 'outputExtractor')
    validateExtractor(expectedOutputExtractor, 'expectedOutputExtractor')

    this.operation = operation
    this.caseSensitive = values.caseSensitive ?? values.case_sensitive ?? true
    this.stripWhitespace = values.stripWhitespace ?? values.strip_whitespace ?? false
    this.outputExtractor = outputExtractor
    this.expectedOutputExtractor = expectedOutputExtractor
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @returns {EvaluatorResult}
   */
  evaluate (context) {
    let output = context.outputData
    let expected = context.expectedOutput
    if (this.outputExtractor) output = this.outputExtractor(output)
    if (this.expectedOutputExtractor) expected = this.expectedOutputExtractor(expected)

    if (output == null && expected == null) {
      const value = this.operation === 'eq'
      return new EvaluatorResult(value, { assessment: assessment(value) })
    }
    if (output == null || expected == null) {
      const value = this.operation === 'ne'
      return new EvaluatorResult(value, { assessment: assessment(value) })
    }

    let outputString = String(output)
    let expectedString = String(expected)
    if (this.stripWhitespace) {
      outputString = outputString.trim()
      expectedString = expectedString.trim()
    }
    if (this.operation === 'icontains' || !this.caseSensitive) {
      outputString = outputString.toLowerCase()
      expectedString = expectedString.toLowerCase()
    }

    let value
    if (this.operation === 'eq') value = outputString === expectedString
    else if (this.operation === 'ne') value = outputString !== expectedString
    else value = outputString.includes(expectedString)
    return new EvaluatorResult(value, { assessment: assessment(value) })
  }
}

/**
 * Evaluator that checks output against a regular expression.
 */
class RegexMatchEvaluator extends BaseEvaluator {
  /**
   * @param {{pattern: string | RegExp, matchMode?: string, flags?: string,
   *   outputExtractor?: Function, name?: string}} options
   */
  constructor (options) {
    const values = optionsOrEmpty(options)
    super(option(values, 'name', 'name'))
    const pattern = values.pattern
    const matchMode = values.matchMode ?? values.match_mode ?? 'search'
    const flags = values.flags ?? ''
    const outputExtractor = values.outputExtractor ?? values.output_extractor

    if (!['search', 'match', 'fullmatch'].includes(matchMode)) {
      throw new Error(`matchMode must be 'search', 'match', or 'fullmatch', got: ${matchMode}`)
    }
    const isRegExp = Object.prototype.toString.call(pattern) === '[object RegExp]'
    if (!isRegExp && typeof pattern !== 'string') throw new TypeError('pattern must be a string or RegExp')
    validateExtractor(outputExtractor, 'outputExtractor')
    try {
      this.pattern = isRegExp ? new RegExp(pattern.source, flags || pattern.flags) : new RegExp(pattern, flags)
    } catch (error) {
      throw new Error(`Invalid regex pattern: ${error.message}`)
    }
    this.patternString = isRegExp ? pattern.source : pattern
    this.matchMode = matchMode
    this.flags = flags
    this.outputExtractor = outputExtractor
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @returns {EvaluatorResult}
   */
  evaluate (context) {
    let output = context.outputData
    if (this.outputExtractor) output = this.outputExtractor(output)
    if (output == null) return new EvaluatorResult(false, { assessment: 'fail' })

    const value = String(output)
    this.pattern.lastIndex = 0
    let matched
    if (this.matchMode === 'search') matched = this.pattern.test(value)
    else if (this.matchMode === 'match') matched = this.pattern.exec(value)?.index === 0
    else {
      const match = this.pattern.exec(value)
      matched = match !== null && match[0] === value
    }
    return new EvaluatorResult(matched, { assessment: assessment(matched) })
  }
}

/**
 * @param {number[]} first
 * @param {number[]} second
 */
function cosineSimilarity (first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) throw new TypeError('Embedding function must return an array')
  if (first.length !== second.length) {
    throw new Error(`Vectors must have same length: ${first.length} != ${second.length}`)
  }

  let dot = 0
  let firstMagnitude = 0
  let secondMagnitude = 0
  for (let i = 0; i < first.length; i++) {
    dot += first[i] * second[i]
    firstMagnitude += first[i] * first[i]
    secondMagnitude += second[i] * second[i]
  }
  if (firstMagnitude === 0 || secondMagnitude === 0) return 0
  return dot / Math.sqrt(firstMagnitude * secondMagnitude)
}

/**
 * @param {number} similarity
 * @param {number} threshold
 * @returns {EvaluatorResult}
 */
function semanticResult (similarity, threshold) {
  const normalized = (similarity + 1) / 2
  return new EvaluatorResult(normalized, { assessment: assessment(normalized >= threshold) })
}

/**
 * Evaluator that measures semantic similarity using an embedding function.
 */
class SemanticSimilarityEvaluator extends BaseEvaluator {
  /**
   * @param {{embeddingFn: Function, threshold?: number, name?: string}} options
   */
  constructor (options) {
    const values = optionsOrEmpty(options)
    super(option(values, 'name', 'name'))
    const embeddingFn = values.embeddingFn ?? values.embedding_fn
    const threshold = values.threshold ?? 0.7
    if (typeof embeddingFn !== 'function') throw new TypeError('embeddingFn must be a callable function')
    if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
      throw new Error(`threshold must be between 0 and 1, got: ${threshold}`)
    }
    this.embeddingFn = embeddingFn
    this.threshold = threshold
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @returns {EvaluatorResult | Promise<EvaluatorResult>}
   */
  evaluate (context) {
    const output = context.outputData
    const expected = context.expectedOutput
    if (output == null && expected == null) return new EvaluatorResult(1, { assessment: 'pass' })
    if (output == null || expected == null) return new EvaluatorResult(0, { assessment: 'fail' })

    const outputEmbedding = this.embeddingFn(String(output))
    const expectedEmbedding = this.embeddingFn(String(expected))
    if (isPromiseLike(outputEmbedding) || isPromiseLike(expectedEmbedding)) {
      return Promise.all([outputEmbedding, expectedEmbedding]).then(([first, second]) => {
        return semanticResult(cosineSimilarity(first, second), this.threshold)
      })
    }
    return semanticResult(cosineSimilarity(outputEmbedding, expectedEmbedding), this.threshold)
  }
}

module.exports = {
  JSONEvaluator,
  LengthEvaluator,
  RegexMatchEvaluator,
  SemanticSimilarityEvaluator,
  StringCheckEvaluator,
}
