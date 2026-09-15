'use strict'

const { BaseEvaluator, EvaluatorResult } = require('./base')
const { isThenable, toText } = require('./util')

/**
 * @param {number[]} vec1
 * @param {number[]} vec2
 * @returns {number} Cosine similarity in [-1, 1]; 0 when either vector has zero magnitude.
 */
function cosineSimilarity (vec1, vec2) {
  if (!Array.isArray(vec1) || !Array.isArray(vec2)) throw new TypeError('embeddingFn must return an array of numbers')
  if (vec1.length !== vec2.length) {
    throw new Error(`Vectors must have same length: ${vec1.length} != ${vec2.length}`)
  }
  let dot = 0
  let mag1 = 0
  let mag2 = 0
  for (let i = 0; i < vec1.length; i++) {
    dot += vec1[i] * vec2[i]
    mag1 += vec1[i] * vec1[i]
    mag2 += vec2[i] * vec2[i]
  }
  const magnitude1 = Math.sqrt(mag1)
  const magnitude2 = Math.sqrt(mag2)
  if (magnitude1 === 0 || magnitude2 === 0) return 0
  return dot / (magnitude1 * magnitude2)
}

/**
 * Measures semantic similarity between output and expected output using a
 * user-supplied embedding function. The score is cosine similarity normalized to [0, 1].
 */
class SemanticSimilarityEvaluator extends BaseEvaluator {
  /**
   * @param {object} options
   * @param {(text: string) => number[] | Promise<number[]>} options.embeddingFn Converts text to an embedding vector.
   * @param {number} [options.threshold] Minimum normalized similarity (0-1) required to pass. Default `0.7`.
   * @param {string} [options.name]
   */
  constructor ({ embeddingFn, threshold = 0.7, name } = {}) {
    super(name)
    if (typeof embeddingFn !== 'function') throw new TypeError('embeddingFn must be a callable function')
    if (typeof threshold !== 'number' || Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(`threshold must be between 0 and 1, got: ${threshold}`)
    }
    this.embeddingFn = embeddingFn
    this.threshold = threshold
  }

  /**
   * @param {import('./base').EvaluatorContext} context
   * @returns {EvaluatorResult | Promise<EvaluatorResult>}
   */
  evaluate (context) {
    const output = context.outputData
    const expected = context.expectedOutput

    if (output == null && expected == null) return new EvaluatorResult(1, { assessment: 'pass' })
    if (output == null || expected == null) return new EvaluatorResult(0, { assessment: 'fail' })

    const outputEmbedding = this.embeddingFn(toText(output))
    const expectedEmbedding = this.embeddingFn(toText(expected))
    if (isThenable(outputEmbedding) || isThenable(expectedEmbedding)) {
      return Promise.all([outputEmbedding, expectedEmbedding]).then(([a, b]) => this.#score(a, b))
    }
    return this.#score(outputEmbedding, expectedEmbedding)
  }

  /**
   * @param {number[]} outputEmbedding
   * @param {number[]} expectedEmbedding
   * @returns {EvaluatorResult}
   */
  #score (outputEmbedding, expectedEmbedding) {
    const normalized = (cosineSimilarity(outputEmbedding, expectedEmbedding) + 1) / 2
    return new EvaluatorResult(normalized, { assessment: normalized >= this.threshold ? 'pass' : 'fail' })
  }
}

module.exports = { SemanticSimilarityEvaluator, cosineSimilarity }
