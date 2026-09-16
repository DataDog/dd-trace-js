'use strict'

const log = require('../../log')
const { Dataset } = require('../experiments/dataset')
const { hasEntries } = require('../experiments/util')
const { OptimizationIteration } = require('./iteration')
const { OptimizationResult } = require('./result')

const DEFAULT_MAX_ITERATIONS = 5
// Fixed seed so train/valid/test splits are reproducible across runs.
const DATASET_SPLIT_SEED = 42
const DEFAULT_THREE_WAY_SPLIT = [0.6, 0.2, 0.2]
const DEFAULT_TWO_WAY_SPLIT = [0.8, 0.2]

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} evaluators
 * @returns {boolean}
 */
function hasEvaluators (evaluators) {
  if (Array.isArray(evaluators)) return evaluators.length > 0
  return isPlainObject(evaluators) && hasEntries(evaluators)
}

/**
 * @param {unknown} datasetSplit
 * @param {unknown} testDataset
 */
function validateDatasetSplit (datasetSplit, testDataset) {
  if (typeof datasetSplit === 'boolean' || datasetSplit === undefined) return
  if (!Array.isArray(datasetSplit)) {
    throw new TypeError('datasetSplit must be a boolean or an array of ratios')
  }
  if (!datasetSplit.every(ratio => typeof ratio === 'number' && ratio > 0 && ratio < 1)) {
    throw new Error('datasetSplit ratios must be numbers between 0 and 1 (exclusive).')
  }
  const sum = datasetSplit.reduce((total, ratio) => total + ratio, 0)
  if (sum < 0.99 || sum > 1.01) {
    throw new Error(`datasetSplit ratios must sum to 1.0, got ${sum.toFixed(4)}.`)
  }
  if (datasetSplit.length === 3 && testDataset !== undefined) {
    throw new Error(
      'Cannot use a 3-element datasetSplit with testDataset. ' +
      'Use a 2-element [train, valid] split when providing a separate test dataset, ' +
      'or a 3-element [train, valid, test] split without testDataset.'
    )
  }
  if (datasetSplit.length === 2 && testDataset === undefined) {
    throw new Error(
      'A 2-element datasetSplit requires testDataset. ' +
      'Use a 3-element [train, valid, test] split to split without a separate test dataset.'
    )
  }
  if (datasetSplit.length !== 2 && datasetSplit.length !== 3) {
    throw new Error('datasetSplit must have 2 or 3 elements.')
  }
}

/**
 * Deterministic Fisher-Yates shuffle driven by a mulberry32 PRNG.
 * @template T
 * @param {T[]} items
 * @param {number} seed
 * @returns {T[]}
 */
function seededShuffle (items, seed) {
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6D_2B_79_F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = tmp
  }
  return shuffled
}

/**
 * @typedef {object} PromptOptimizationConfig
 * @property {string} prompt Initial prompt template (required).
 * @property {string} [modelName] Model executing the task; forwarded to the optimization LLM as context.
 * @property {unknown} [evaluationOutputFormat] Output structure the optimized prompt must enforce.
 * @property {number} [runs] Number of runs per experiment.
 */

/**
 * @typedef {object} OptimizationTaskRequest
 * @property {string} systemPrompt
 * @property {string} userPrompt
 * @property {PromptOptimizationConfig} config
 * @property {Array<{role: string, content: string}>} messages `systemPrompt` and `userPrompt` as chat messages.
 * @property {string | null} model `config.modelName` when set.
 */

/**
 * Iteratively improves a prompt: runs a baseline experiment, then asks the
 * user-supplied `optimizationTask` for a better prompt and re-runs the
 * experiment, keeping the highest scoring prompt.
 */
class PromptOptimization {
  #experiments
  #client
  #task
  #optimizationTask
  #dataset
  #evaluators
  #summaryEvaluators
  #computeScore
  #labelize
  #stoppingCondition
  #config
  #initialPrompt
  #tags
  #projectName
  #maxIterations
  #testDataset
  #splitRatios
  #datasetSplitEnabled

  /**
   * @param {object} options
   * @param {string} options.name
   * @param {Function} options.task Experiment task `(input, config, metadata) => output`.
   * @param {(request: OptimizationTaskRequest) => string | Promise<string>} options.optimizationTask
   * @param {Dataset} options.dataset
   * @param {object} options.evaluators
   * @param {object} options.summaryEvaluators
   * @param {(summaryEvaluations: Record<string, {value: unknown, error: string | null}>) => number}
   *   options.computeScore
   * @param {(row: import('../experiments/result').Row) => string | null | undefined} [options.labelize]
   * @param {PromptOptimizationConfig} options.config
   * @param {Record<string, string>} [options.tags]
   * @param {number} [options.maxIterations]
   * @param {(summaryEvaluations: Record<string, {value: unknown, error: string | null}>) => boolean}
   *   [options.stoppingCondition]
   * @param {boolean | number[]} [options.datasetSplit]
   * @param {Dataset | string} [options.testDataset]
   * @param {object} deps
   * @param {import('../experiments').Experiments} deps.experiments
   * @param {import('../experiments/client').ExperimentsClient} deps.client
   * @param {string} deps.projectName
   */
  constructor (options, { experiments, client, projectName }) {
    if (!isPlainObject(options)) throw new TypeError('optimizePrompt options must be an object')
    const {
      name,
      task,
      optimizationTask,
      dataset,
      evaluators,
      summaryEvaluators,
      computeScore,
      labelize,
      config,
      tags,
      maxIterations = DEFAULT_MAX_ITERATIONS,
      stoppingCondition,
      datasetSplit = false,
      testDataset,
    } = options

    if (typeof name !== 'string' || name.length === 0) throw new TypeError('name must be a non-empty string')
    if (typeof task !== 'function') throw new TypeError('task must be a callable function.')
    if (typeof optimizationTask !== 'function') {
      throw new TypeError(
        'optimizationTask must be a callable function. ' +
        'It should call an LLM with the provided prompts and return an optimized prompt.'
      )
    }
    if (!(dataset instanceof Dataset)) throw new TypeError('dataset must be an LLMObs Dataset object.')
    if (testDataset !== undefined && typeof testDataset !== 'string' && !(testDataset instanceof Dataset)) {
      throw new TypeError('testDataset must be a dataset name (string) or an LLMObs Dataset object.')
    }
    validateDatasetSplit(datasetSplit, testDataset)
    if (!hasEvaluators(evaluators)) {
      throw new TypeError('evaluators must be a non-empty list or record of evaluators.')
    }
    if (!hasEvaluators(summaryEvaluators)) {
      throw new TypeError('summaryEvaluators must be a non-empty list or record of summary evaluators.')
    }
    if (typeof computeScore !== 'function') throw new TypeError('computeScore must be a callable function.')
    if (labelize !== undefined && labelize !== null && typeof labelize !== 'function') {
      throw new TypeError('labelize must be a function.')
    }
    if (stoppingCondition !== undefined && stoppingCondition !== null && typeof stoppingCondition !== 'function') {
      throw new TypeError('stoppingCondition must be a function.')
    }
    if (!Number.isInteger(maxIterations) || maxIterations < 0) {
      throw new Error('maxIterations must be a non-negative integer')
    }
    if (!isPlainObject(config) || !hasEntries(config)) throw new Error('config parameter is required')
    if (typeof config.prompt !== 'string') throw new Error("config must contain a string 'prompt' key")

    this.name = name
    this.#experiments = experiments
    this.#client = client
    this.#task = task
    this.#optimizationTask = optimizationTask
    this.#dataset = dataset
    this.#evaluators = evaluators
    this.#summaryEvaluators = summaryEvaluators
    this.#computeScore = computeScore
    this.#labelize = labelize ?? null
    this.#stoppingCondition = stoppingCondition ?? null
    this.#config = config
    this.#initialPrompt = config.prompt
    this.#tags = { ...tags, project_name: projectName }
    this.#projectName = projectName
    this.#maxIterations = maxIterations
    this.#testDataset = testDataset

    this.#datasetSplitEnabled = Boolean(datasetSplit) || testDataset !== undefined
    if (Array.isArray(datasetSplit)) {
      this.#splitRatios = datasetSplit
    } else if (testDataset !== undefined) {
      this.#splitRatios = DEFAULT_TWO_WAY_SPLIT
    } else if (datasetSplit) {
      this.#splitRatios = DEFAULT_THREE_WAY_SPLIT
    } else {
      this.#splitRatios = null
    }
  }

  /**
   * Run the optimization.
   * @param {{concurrency?: number}} [options] `concurrency` is forwarded to each experiment run.
   * @returns {Promise<OptimizationResult>}
   */
  run ({ concurrency } = {}) {
    log.info('Starting prompt optimization: %s', this.name)
    if (this.#datasetSplitEnabled) return this.#runWithSplit(concurrency)
    return this.#runWithoutSplit(concurrency)
  }

  /**
   * @param {number | undefined} concurrency
   * @returns {Promise<OptimizationResult>}
   */
  async #runWithoutSplit (concurrency) {
    const iterations = []
    let bestIteration = 0
    let bestPrompt = this.#initialPrompt
    let bestResults

    const baseline = await this.#runExperiment(0, bestPrompt, concurrency)
    const baselineSummary = baseline.results.summaryEvaluations ?? {}
    const baselineScore = this.#computeScore(baselineSummary)
    iterations.push({
      iteration: 0,
      prompt: bestPrompt,
      results: baseline.results,
      score: baselineScore,
      experimentUrl: baseline.url,
      summaryEvaluations: baselineSummary,
    })
    let bestScore = baselineScore || 0
    bestResults = baseline.results
    log.info('Baseline score: %s', bestScore)

    // Iterations are inherently sequential: each one starts from the best prompt so far.
    for (let i = 1; i <= this.#maxIterations; i++) {
      // eslint-disable-next-line no-await-in-loop
      const newPrompt = await this.#optimize(i, bestPrompt, bestResults)
      // eslint-disable-next-line no-await-in-loop
      const { results, url } = await this.#runExperiment(i, newPrompt, concurrency)
      const summaryEvaluations = results.summaryEvaluations ?? {}
      const newScore = this.#computeScore(summaryEvaluations)

      iterations.push({
        iteration: i,
        prompt: newPrompt,
        results,
        score: newScore,
        experimentUrl: url,
        summaryEvaluations,
      })
      log.info('Iteration %s (score: %s)', i, newScore)

      if (typeof newScore === 'number' && newScore > bestScore) {
        bestIteration = i
        bestScore = newScore
        bestPrompt = newPrompt
        bestResults = results
      }

      if (this.#stoppingCondition?.(summaryEvaluations)) {
        log.info('Stopping condition met after iteration %s', i)
        break
      }
    }

    return new OptimizationResult(this.name, this.#initialPrompt, iterations, bestIteration)
  }

  /**
   * @param {number | undefined} concurrency
   * @returns {Promise<OptimizationResult>}
   */
  async #runWithSplit (concurrency) {
    const { train, valid, test } = await this.#createSplitDatasets()

    const iterations = []
    let bestIteration = 0
    let bestPrompt = this.#initialPrompt
    let bestTrainResults

    const baselineTrain = await this.#runExperiment(0, bestPrompt, concurrency, train, 'train')
    const baselineValid = await this.#runExperiment(0, bestPrompt, concurrency, valid, 'valid')
    const baselineSummary = baselineValid.results.summaryEvaluations ?? {}
    const baselineScore = this.#computeScore(baselineSummary)
    iterations.push({
      iteration: 0,
      prompt: bestPrompt,
      results: baselineValid.results,
      score: baselineScore,
      experimentUrl: baselineValid.url,
      summaryEvaluations: baselineSummary,
      trainExperimentUrl: baselineTrain.url,
    })
    let bestScore = baselineScore || 0
    bestTrainResults = baselineTrain.results
    log.info('Baseline score (valid): %s', bestScore)

    for (let i = 1; i <= this.#maxIterations; i++) {
      // eslint-disable-next-line no-await-in-loop
      const newPrompt = await this.#optimize(i, bestPrompt, bestTrainResults)
      // eslint-disable-next-line no-await-in-loop
      const trainRun = await this.#runExperiment(i, newPrompt, concurrency, train, 'train')
      // eslint-disable-next-line no-await-in-loop
      const validRun = await this.#runExperiment(i, newPrompt, concurrency, valid, 'valid')
      const summaryEvaluations = validRun.results.summaryEvaluations ?? {}
      const newScore = this.#computeScore(summaryEvaluations)

      iterations.push({
        iteration: i,
        prompt: newPrompt,
        results: validRun.results,
        score: newScore,
        experimentUrl: validRun.url,
        summaryEvaluations,
        trainExperimentUrl: trainRun.url,
      })
      log.info('Iteration %s (valid score: %s)', i, newScore)

      if (typeof newScore === 'number' && newScore > bestScore) {
        bestIteration = i
        bestScore = newScore
        bestPrompt = newPrompt
        bestTrainResults = trainRun.results
      }

      if (this.#stoppingCondition?.(summaryEvaluations)) {
        log.info('Stopping condition met after iteration %s', i)
        break
      }
    }

    log.info('Running final test experiment with best prompt (iteration %s)', bestIteration)
    const testRun = await this.#runExperiment(bestIteration, bestPrompt, concurrency, test, 'test')
    const testScore = this.#computeScore(testRun.results.summaryEvaluations ?? {})
    log.info('Test score: %s', testScore)

    return new OptimizationResult(this.name, this.#initialPrompt, iterations, bestIteration, {
      results: testRun.results,
      score: testScore,
      experimentUrl: testRun.url,
    })
  }

  /**
   * @param {number} iteration
   * @param {string} currentPrompt
   * @param {import('../experiments/result').ExperimentResult} currentResults
   * @returns {Promise<string>}
   */
  #optimize (iteration, currentPrompt, currentResults) {
    return new OptimizationIteration({
      iteration,
      currentPrompt,
      currentResults,
      optimizationTask: this.#optimizationTask,
      config: this.#config,
      labelize: this.#labelize,
    }).run()
  }

  /**
   * @param {number} iteration
   * @param {string} prompt
   * @param {number | undefined} concurrency
   * @param {Dataset} [dataset]
   * @param {string} [suffix]
   * @returns {Promise<{results: import('../experiments/result').ExperimentResult, url: string | null}>}
   */
  async #runExperiment (iteration, prompt, concurrency, dataset = this.#dataset, suffix = '') {
    let iterationName = iteration === 0 ? 'baseline' : `iteration_${iteration}`
    if (suffix) iterationName = `${iterationName}_${suffix}`

    const experimentConfig = { ...this.#config, prompt }
    if (Object.hasOwn(this.#config, 'modelName')) experimentConfig.modelName = this.#config.modelName

    const runs = Number.isInteger(this.#config.runs) ? this.#config.runs : undefined

    const experiment = this.#experiments.experiment({
      name: `${this.name}_${iterationName}`,
      projectName: this.#projectName,
      dataset,
      task: this.#task,
      evaluators: this.#evaluators,
      summaryEvaluators: this.#summaryEvaluators,
      config: experimentConfig,
      tags: this.#tags,
      runs,
    })

    const results = await experiment.run({ throwOnErrors: true, concurrency })
    return { results, url: experiment.url() }
  }

  /**
   * @param {string} splitName
   * @param {import('../experiments/dataset').DatasetRecord[]} records
   * @returns {Dataset}
   */
  #makeSubDataset (splitName, records) {
    const source = this.#dataset
    return Dataset.fromExisting(
      this.#client,
      `[${splitName}] ${source.name()}`,
      source.description(),
      source.id(),
      source.projectId(),
      records.map(record => structuredClone(record)),
      source.version(),
      source.latestVersion(),
      source.filterTags()
    )
  }

  /**
   * Split the dataset into train/valid(/test) sub-datasets sharing the source dataset id.
   * @returns {Promise<{train: Dataset, valid: Dataset, test: Dataset}>}
   */
  async #createSplitDatasets () {
    if (this.#splitRatios === null) throw new Error('dataset split requested without split ratios')

    // Sub-datasets reuse the remote dataset id, so the source must exist remotely first.
    if (this.#dataset.id() === null) await this.#dataset.push()

    const records = seededShuffle(this.#dataset.records(), DATASET_SPLIT_SEED)
    const total = records.length

    let trainRecords
    let validRecords
    /** @type {Dataset} */
    let test
    if (this.#testDataset === undefined) {
      const [trainRatio, validRatio] = this.#splitRatios
      const trainEnd = Math.floor(trainRatio * total)
      const validEnd = Math.floor((trainRatio + validRatio) * total)
      trainRecords = records.slice(0, trainEnd)
      validRecords = records.slice(trainEnd, validEnd)
      test = this.#makeSubDataset('test', records.slice(validEnd))
    } else {
      const splitIndex = Math.floor(this.#splitRatios[0] * total)
      trainRecords = records.slice(0, splitIndex)
      validRecords = records.slice(splitIndex)
      const testDataset = this.#testDataset
      test = testDataset instanceof Dataset
        ? testDataset
        : await this.#experiments.pullDataset(testDataset, { projectName: this.#projectName })
    }

    const train = this.#makeSubDataset('train', trainRecords)
    const valid = this.#makeSubDataset('valid', validRecords)

    for (const [splitName, split] of Object.entries({ train, valid, test })) {
      if (split.records().length === 0) {
        throw new Error(
          `Dataset split '${splitName}' is empty. ` +
          `Dataset has ${total} records, which is too few for splitting.`
        )
      }
    }

    log.info(
      'Dataset split: %s train, %s valid, %s test records',
      train.records().length, valid.records().length, test.records().length
    )
    return { train, valid, test }
  }
}

module.exports = { PromptOptimization, OptimizationResult, DATASET_SPLIT_SEED, seededShuffle }
