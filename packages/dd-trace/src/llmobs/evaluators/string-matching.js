'use strict'

const { BaseEvaluator, assertOptionalFunction, booleanResult } = require('./base')
const { toText } = require('./util')

const OPERATIONS = ['eq', 'ne', 'contains', 'icontains']
const MATCH_MODES = new Set(['search', 'match', 'fullmatch'])

/**
 * Compares the output with the expected output using `eq`, `ne`, `contains` or `icontains`.
 */
class StringCheckEvaluator extends BaseEvaluator {
  /**
   * @param {object} [options]
   * @param {'eq' | 'ne' | 'contains' | 'icontains'} [options.operation] Comparison operation. Default `'eq'`.
   * @param {boolean} [options.caseSensitive] Case-sensitive comparison. Default `true`; ignored for `icontains`.
   * @param {boolean} [options.stripWhitespace] Trim both sides before comparing. Default `false`.
   * @param {(output: unknown) => unknown} [options.outputExtractor] Transform applied to the output first.
   * @param {(expected: unknown) => unknown} [options.expectedOutputExtractor] Transform applied to the expected output.
   * @param {string} [options.name]
   */
  constructor ({
    operation = 'eq',
    caseSensitive = true,
    stripWhitespace = false,
    outputExtractor,
    expectedOutputExtractor,
    name,
  } = {}) {
    super(name)
    if (!OPERATIONS.includes(operation)) {
      throw new Error(`operation must be one of ${JSON.stringify(OPERATIONS)}, got: ${operation}`)
    }
    assertOptionalFunction(outputExtractor, 'output_extractor')
    assertOptionalFunction(expectedOutputExtractor, 'expected_output_extractor')

    this.operation = operation
    this.caseSensitive = caseSensitive
    this.stripWhitespace = stripWhitespace
    this.outputExtractor = outputExtractor ?? null
    this.expectedOutputExtractor = expectedOutputExtractor ?? null
  }

  evaluate (context) {
    let output = context.outputData
    let expected = context.expectedOutput
    if (this.outputExtractor !== null) output = this.outputExtractor(output)
    if (this.expectedOutputExtractor !== null) expected = this.expectedOutputExtractor(expected)

    if (output == null && expected == null) return booleanResult(this.operation === 'eq')
    if (output == null || expected == null) return booleanResult(this.operation === 'ne')

    let outputText = toText(output)
    let expectedText = toText(expected)
    if (this.stripWhitespace) {
      outputText = outputText.trim()
      expectedText = expectedText.trim()
    }
    if (this.operation === 'icontains' || !this.caseSensitive) {
      outputText = outputText.toLowerCase()
      expectedText = expectedText.toLowerCase()
    }

    if (this.operation === 'eq') return booleanResult(outputText === expectedText)
    if (this.operation === 'ne') return booleanResult(outputText !== expectedText)
    return booleanResult(outputText.includes(expectedText))
  }
}

/**
 * Checks the output against a regular expression.
 */
class RegexMatchEvaluator extends BaseEvaluator {
  /**
   * @param {object} options
   * @param {string | RegExp} options.pattern Pattern to match.
   * @param {'search' | 'match' | 'fullmatch'} [options.matchMode] `search` anywhere (default), `match` anchored at
   *   the start, `fullmatch` anchored at both ends.
   * @param {string} [options.flags] `RegExp` flags such as `'i'` or `'m'` (Python's `re` flags equivalent).
   * @param {(output: unknown) => unknown} [options.outputExtractor] Transform applied to the output first.
   * @param {string} [options.name]
   */
  constructor ({ pattern, matchMode = 'search', flags = '', outputExtractor, name } = {}) {
    super(name)
    if (!MATCH_MODES.has(matchMode)) {
      throw new Error(`matchMode must be 'search', 'match', or 'fullmatch', got: ${matchMode}`)
    }
    if (pattern === undefined || pattern === null) throw new Error('pattern is required')
    assertOptionalFunction(outputExtractor, 'output_extractor')

    const source = pattern instanceof RegExp ? pattern.source : String(pattern)
    const resolvedFlags = pattern instanceof RegExp && flags === '' ? pattern.flags : flags
    let anchored = source
    if (matchMode === 'match') anchored = `^(?:${source})`
    else if (matchMode === 'fullmatch') anchored = `^(?:${source})$`
    try {
      this.pattern = new RegExp(anchored, resolvedFlags.replaceAll('g', ''))
    } catch (err) {
      throw new Error(`Invalid regex pattern: ${err.message}`)
    }

    this.patternStr = source
    this.matchMode = matchMode
    this.flags = resolvedFlags
    this.outputExtractor = outputExtractor ?? null
  }

  evaluate (context) {
    let output = context.outputData
    if (this.outputExtractor !== null) output = this.outputExtractor(output)
    if (output == null) return booleanResult(false)
    return booleanResult(this.pattern.test(toText(output)))
  }
}

module.exports = { RegexMatchEvaluator, StringCheckEvaluator }
