'use strict'

const { hasEntries } = require('../experiments/util')

/**
 * @typedef {object} IterationData
 * @property {number} iteration 0 for the baseline, then 1..maxIterations.
 * @property {string} prompt Prompt evaluated in this iteration.
 * @property {import('../experiments/result').ExperimentResult} results Experiment results used for scoring
 *   (the validation experiment when dataset splitting is enabled).
 * @property {number | null} score Score returned by `computeScore`.
 * @property {string | null} experimentUrl Dashboard URL of the scored experiment.
 * @property {Record<string, {value: unknown, error: string | null}>} summaryEvaluations
 * @property {string | null} [trainExperimentUrl] Only set when dataset splitting is enabled.
 */

/**
 * @typedef {object} TestPhaseResult
 * @property {import('../experiments/result').ExperimentResult} results
 * @property {number | null} score
 * @property {string | null} experimentUrl
 */

/**
 * @param {number | null | undefined} score
 * @returns {string}
 */
function formatScore (score) {
  return typeof score === 'number' ? score.toFixed(4) : 'N/A'
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function display (value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Outcome of a prompt optimization: every iteration plus the index of the best one.
 */
class OptimizationResult {
  #testPhase

  /**
   * @param {string} name
   * @param {string} initialPrompt
   * @param {IterationData[]} iterations
   * @param {number} bestIteration
   * @param {TestPhaseResult | null} [testPhase]
   */
  constructor (name, initialPrompt, iterations, bestIteration, testPhase = null) {
    this.name = name
    this.initialPrompt = initialPrompt
    this.iterations = iterations
    this.bestIteration = bestIteration
    this.#testPhase = testPhase
  }

  /** @returns {IterationData | undefined} */
  get #best () {
    return this.iterations[this.bestIteration]
  }

  /** Best performing prompt, or the initial prompt when no iteration ran. */
  get bestPrompt () {
    return this.#best?.prompt ?? this.initialPrompt
  }

  /** Score of the best iteration. */
  get bestScore () {
    return this.#best?.score ?? null
  }

  /** Experiment URL of the best iteration. */
  get bestExperimentUrl () {
    return this.#best?.experimentUrl ?? null
  }

  /** Number of iterations run, including the baseline. */
  get totalIterations () {
    return this.iterations.length
  }

  /** Score of the final test experiment (dataset splitting only). */
  get testScore () {
    return this.#testPhase?.score ?? null
  }

  /** Experiment URL of the final test experiment (dataset splitting only). */
  get testExperimentUrl () {
    return this.#testPhase?.experimentUrl ?? null
  }

  /** Results of the final test experiment (dataset splitting only). */
  get testResults () {
    return this.#testPhase?.results ?? null
  }

  /** @returns {IterationData[]} */
  getHistory () {
    return this.iterations
  }

  /** @returns {Array<number | null>} */
  getScoreHistory () {
    return this.iterations.map(iteration => iteration.score)
  }

  /** @returns {string[]} */
  getPromptHistory () {
    return this.iterations.map(iteration => iteration.prompt)
  }

  /**
   * Human-readable summary of the optimization.
   * @returns {string}
   */
  summary () {
    const lines = [
      `Optimization: ${this.name}`,
      `Total iterations: ${this.totalIterations}`,
      `Best iteration: ${this.bestIteration}`,
      `Best score: ${formatScore(this.bestScore)}`,
    ]

    if (this.testScore !== null) {
      lines.push(`Test score: ${formatScore(this.testScore)}`)
      if (this.testExperimentUrl) lines.push(`Test experiment: ${this.testExperimentUrl}`)
    }

    const best = this.#best
    if (best && hasEntries(best.summaryEvaluations)) {
      lines.push(`\nBest iteration summary evaluations:\n${display(best.summaryEvaluations)}`)
    }

    const testSummaryEvaluations = this.testResults?.summaryEvaluations
    if (hasEntries(testSummaryEvaluations)) {
      lines.push(`\nTest set summary evaluations:\n${display(testSummaryEvaluations)}`)
    }

    lines.push('\nScore progression:')
    for (const iteration of this.iterations) {
      const marker = iteration.iteration === this.bestIteration ? ' <- BEST' : ''
      lines.push(
        `Iteration ${iteration.iteration} (score: ${formatScore(iteration.score)}): ${iteration.experimentUrl}${marker}`
      )
    }

    return lines.join('\n')
  }
}

module.exports = { OptimizationResult }
