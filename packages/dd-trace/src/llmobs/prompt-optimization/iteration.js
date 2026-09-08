'use strict'

const log = require('../../log')
const { hasEntries } = require('../experiments/util')
const { OPTIMIZATION_SYSTEM_PROMPT_TEMPLATE, TIPS } = require('./system-prompt')

const MAX_DISTINCT_LABELS = 10

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Render a value for inclusion in the optimization user prompt.
 * @param {unknown} value
 * @returns {string}
 */
function display (value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyValue (value) {
  if (value === null || value === undefined || value === '' || value === false || value === 0) return true
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return !hasEntries(value)
  return false
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T}
 */
function pickRandom (items) {
  return items[Math.floor(Math.random() * items.length)]
}

/**
 * One optimization step: builds the optimization system/user prompts from the
 * current prompt and its experiment results, then asks the user-supplied
 * `optimizationTask` for an improved prompt.
 */
class OptimizationIteration {
  #optimizationTask
  #config
  #labelize

  /**
   * @param {object} options
   * @param {number} options.iteration 0-indexed iteration number.
   * @param {string} options.currentPrompt Prompt being improved.
   * @param {import('../experiments/result').ExperimentResult} options.currentResults Results of the experiment
   *   that ran `currentPrompt`.
   * @param {Function} options.optimizationTask Callback performing the LLM call and returning the new prompt.
   * @param {Record<string, unknown>} options.config Optimization config.
   * @param {Function | null | undefined} options.labelize Maps an experiment row to an example label.
   */
  constructor ({ iteration, currentPrompt, currentResults, optimizationTask, config, labelize }) {
    this.iteration = iteration
    this.currentPrompt = currentPrompt
    this.currentResults = currentResults
    this.#optimizationTask = optimizationTask
    this.#config = config
    this.#labelize = labelize ?? null
  }

  /**
   * Generate an improved prompt. Falls back to the current prompt when the
   * optimization task throws or returns an empty value.
   * @returns {Promise<string>}
   */
  async run () {
    const systemPrompt = this.loadSystemPrompt()
    const userPrompt = this.buildUserPrompt()

    let improvedPrompt
    try {
      improvedPrompt = await this.#optimizationTask({
        systemPrompt,
        userPrompt,
        config: this.#config,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: typeof this.#config.modelName === 'string' ? this.#config.modelName : null,
      })
    } catch (err) {
      log.error('Iteration %s: Failed to run optimizationTask', this.iteration, err)
      improvedPrompt = ''
    }

    if (typeof improvedPrompt !== 'string' || improvedPrompt.length === 0) {
      log.warn(
        'Iteration %s: optimizationTask returned an empty or non-string prompt, keeping current prompt',
        this.iteration
      )
      return this.currentPrompt
    }

    return improvedPrompt
  }

  /**
   * Prepare the system prompt: inject the expected output format, the evaluation
   * model (if any) and a random prompt-engineering tip.
   * @returns {string}
   */
  loadSystemPrompt () {
    const outputFormat = this.#config.evaluationOutputFormat
    let structurePlaceholder = ''
    if (!isEmptyValue(outputFormat)) {
      structurePlaceholder = '## Prompt Output Format Requirements\n' +
        'The optimized prompt must guide the LLM to produce JSON output with this structure:\n' +
        '\n\n' +
        `${display(outputFormat)}\n` +
        '\n\n' +
        '**If this output format is not clearly specified in the initial prompt**\n' +
        '**add it as your first improvement step**'
    }

    let systemPrompt = OPTIMIZATION_SYSTEM_PROMPT_TEMPLATE.replace('{{STRUCTURE_PLACEHOLDER}}', structurePlaceholder)

    if (Object.hasOwn(this.#config, 'modelName')) {
      systemPrompt +=
        `\n\nIMPORTANT: The improved prompt will be applied to this evaluation model: ${this.#config.modelName}\n` +
        'Consider the capabilities, limitations, and characteristics of this specific model ' +
        'when optimizing the prompt.\n'
    }

    const tipText = TIPS[pickRandom(Object.keys(TIPS))]
    systemPrompt += `\n\n**TIP: ${tipText}**`
    return systemPrompt
  }

  /**
   * Build the user prompt: current prompt, summary metrics and one labeled
   * example per label.
   * @returns {string}
   */
  buildUserPrompt () {
    const promptParts = [`Initial Prompt:\n${this.currentPrompt}\n`]

    const summaryEvaluations = this.currentResults?.summaryEvaluations
    if (hasEntries(summaryEvaluations)) {
      promptParts.push('Performance Metrics:')
      for (const summaryMetric of Object.values(summaryEvaluations)) {
        const value = summaryMetric?.value
        if (isPlainObject(value)) {
          for (const [metricName, metricData] of Object.entries(value)) {
            promptParts.push(`- ${metricName}: ${display(metricData)}`)
          }
        }
      }
      promptParts.push('')
    }

    const rows = this.currentResults?.rows ?? []
    if (rows.length > 0) {
      promptParts.push(this.addExamples(rows))
    }

    return promptParts.join('\n\n')
  }

  /**
   * Group rows by the label returned by `labelize` and format one random row per label.
   * @param {import('../experiments/result').Row[]} rows
   * @returns {string}
   */
  addExamples (rows) {
    if (rows.length === 0 || this.#labelize === null) return ''

    const examplesByLabel = new Map()
    for (const row of rows) {
      const label = this.#labelize(row)
      if (label === null || label === undefined || label === '') continue
      const key = String(label)
      if (!examplesByLabel.has(key)) examplesByLabel.set(key, [])
      examplesByLabel.get(key).push(row)
    }

    if (examplesByLabel.size === 0) return ''

    if (examplesByLabel.size > MAX_DISTINCT_LABELS) {
      log.warn('Too many distinct labels: %s', examplesByLabel.size)
      return ''
    }

    const formattedParts = ['## Examples from Current Evaluation\n']
    const labels = [...examplesByLabel.keys()].sort()
    for (const label of labels) {
      const example = pickRandom(examplesByLabel.get(label))
      formattedParts.push(`### ${label}\n`, OptimizationIteration.formatExample(example), '')
    }

    return formattedParts.join('\n')
  }

  /**
   * @param {import('../experiments/result').Row} example
   * @returns {string}
   */
  static formatExample (example) {
    const parts = [`Input:\n${display(example.input)}`]

    if (!isEmptyValue(example.expectedOutput)) {
      parts.push(`Expected Output:\n${display(example.expectedOutput)}`)
    }

    if (!isEmptyValue(example.output)) {
      parts.push(`Actual Output:\n${display(example.output)}`)
    }

    const evaluations = example.evaluations
    if (isPlainObject(evaluations)) {
      for (const [evalName, evalData] of Object.entries(evaluations)) {
        if (isPlainObject(evalData) && Object.hasOwn(evalData, 'reasoning')) {
          parts.push(`Reasoning (${evalName}):\n${display(evalData.reasoning)}`)
        }
      }
    }

    return parts.join('\n')
  }
}

module.exports = { OptimizationIteration }
