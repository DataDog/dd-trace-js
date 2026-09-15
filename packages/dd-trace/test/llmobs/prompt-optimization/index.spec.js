'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../src/log')
const { createExperiments } = require('../../../src/llmobs/experiments')
const { ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset, DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const NoopExperiments = require('../../../src/llmobs/experiments/noop')
const {
  PromptOptimization,
  OptimizationResult,
  DATASET_SPLIT_SEED,
  seededShuffle,
} = require('../../../src/llmobs/prompt-optimization')
const { OPTIMIZATION_SYSTEM_PROMPT_TEMPLATE, TIPS } = require('../../../src/llmobs/prompt-optimization/system-prompt')

const APP_BASE = 'https://app.datadoghq.com'

const enabledConfig = {
  site: 'datadoghq.com',
  DD_API_KEY: 'k',
  DD_APP_KEY: 'a',
  llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'my-app' },
}

const llmobs = {
  enabled: true,
  trace: (options, fn) => fn({ name: 'span' }),
  exportSpan: () => ({ spanId: '000000000000abcd', traceId: '0000000000000000000000000000abcd' }),
  annotate: () => {},
  flush: () => {},
}

// Stub the control-plane client so no HTTP traffic happens. Every experiment gets a
// distinct id so URLs can be asserted per iteration.
function stubBackend () {
  const requests = []
  let experimentCounter = 0
  let recordCounter = 0

  sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj')
  sinon.stub(ExperimentsClient.prototype, 'createDataset').callsFake(async function (projectId, attributes) {
    requests.push({ method: 'createDataset', projectId, attributes })
    return Dataset.fromExisting(this, attributes.name, attributes.description, 'ds-1', projectId, [], 1, 1)
  })
  sinon.stub(ExperimentsClient.prototype, 'batchUpdateDatasetRecords').callsFake(
    async (projectId, datasetId, attributes) => {
      requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
      const records = (attributes.insert_records ?? []).map(record => new DatasetRecord(
        record.input, record.expected_output, record.metadata, record.id ?? `rec-${recordCounter++}`
      ))
      return { records, version: 2 }
    }
  )
  sinon.stub(ExperimentsClient.prototype, 'createExperiment').callsFake(async (attributes) => {
    const id = `exp-${++experimentCounter}`
    requests.push({ method: 'createExperiment', attributes, id })
    return { experimentId: id, rows: [], url: `${APP_BASE}/llm/experiments/${id}` }
  })
  sinon.stub(ExperimentsClient.prototype, 'postExperimentEvents').callsFake(async (experimentId, attributes) => {
    requests.push({ method: 'postExperimentEvents', experimentId, attributes })
  })
  sinon.stub(ExperimentsClient.prototype, 'updateExperiment').callsFake(async (experimentId, attributes) => {
    requests.push({ method: 'updateExperiment', experimentId, attributes })
  })

  return requests
}

function experimentNames (requests) {
  return requests.filter(request => request.method === 'createExperiment').map(request => request.attributes.name)
}

function experimentConfigs (requests) {
  return requests.filter(request => request.method === 'createExperiment').map(request => request.attributes.config)
}

// One `correct` evaluator metric is emitted per dataset record, so this yields the row count per experiment.
function rowCounts (requests) {
  return requests
    .filter(request => request.method === 'postExperimentEvents')
    .map(request => request.attributes.metrics.filter(metric => metric.label === 'correct').length)
}

function buildDataset (experiments, count = 3) {
  const dataset = experiments.createDataset('qa')
  for (let i = 0; i < count; i++) {
    dataset.addRecord({ question: `q${i}` }, `a${i}`, { row: i })
  }
  return dataset
}

// Task output is controlled by the prompt so evaluators produce prompt-dependent scores.
function baseOptions (experiments, overrides = {}) {
  return {
    name: 'opt',
    dataset: buildDataset(experiments),
    task: (input, config) => `${config.prompt}:${input.question}`,
    optimizationTask: () => 'improved',
    evaluators: {
      correct: (input, output, expectedOutput) => output.endsWith(expectedOutput.slice(1)),
    },
    summaryEvaluators: {
      stats: (inputs, outputs) => ({ accuracy: outputs.filter(output => output.startsWith('improved')).length }),
    },
    computeScore: (summary) => summary.stats.value.accuracy,
    config: { prompt: 'initial' },
    ...overrides,
  }
}

describe('LLMObs prompt optimization', () => {
  let experiments
  let requests

  beforeEach(() => {
    requests = stubBackend()
    experiments = createExperiments(enabledConfig, llmobs)
    sinon.stub(log, 'info')
    sinon.stub(log, 'warn')
    sinon.stub(log, 'error')
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('experiments.optimizePrompt()', () => {
    it('returns a PromptOptimization builder', () => {
      const optimization = experiments.optimizePrompt(baseOptions(experiments))
      assert.ok(optimization instanceof PromptOptimization)
      assert.equal(optimization.name, 'opt')
    })

    it('rejects a project override that does not match the dataset project', () => {
      const dataset = experiments.createDataset('qa', { projectName: 'other-project' })
      assert.throws(() => experiments.optimizePrompt(baseOptions(experiments, { dataset, projectName: 'mine' })), {
        message: "Prompt optimization project 'mine' does not match dataset project 'other-project'",
      })
    })

    it('returns an inert optimization when experiments are unavailable', async () => {
      const noop = new NoopExperiments('disabled')
      const result = await noop.optimizePrompt({ name: 'opt', config: { prompt: 'initial' } }).run()
      assert.ok(result instanceof OptimizationResult)
      assert.equal(result.bestPrompt, 'initial')
      assert.equal(result.bestScore, null)
      assert.equal(result.totalIterations, 0)
      sinon.assert.calledWithMatch(log.warn, 'LLMObs experiments unavailable: %s', 'disabled')
    })
  })

  describe('validation', () => {
    const cases = [
      [{ name: '' }, TypeError, /name must be a non-empty string/],
      [{ task: 'nope' }, TypeError, /task must be a callable function/],
      [{ optimizationTask: undefined }, TypeError, /optimizationTask must be a callable function/],
      [{ dataset: { records: () => [] } }, TypeError, /dataset must be an LLMObs Dataset object/],
      [{ testDataset: 42 }, TypeError, /testDataset must be a dataset name/],
      [{ evaluators: [] }, TypeError, /evaluators must be a non-empty list/],
      [{ evaluators: {} }, TypeError, /evaluators must be a non-empty list/],
      [{ summaryEvaluators: undefined }, TypeError, /summaryEvaluators must be a non-empty list/],
      [{ computeScore: null }, TypeError, /computeScore must be a callable function/],
      [{ labelize: 'x' }, TypeError, /labelize must be a function/],
      [{ stoppingCondition: 'x' }, TypeError, /stoppingCondition must be a function/],
      [{ maxIterations: -1 }, Error, /maxIterations must be a non-negative integer/],
      [{ maxIterations: 1.5 }, Error, /maxIterations must be a non-negative integer/],
      [{ config: undefined }, Error, /config parameter is required/],
      [{ config: {} }, Error, /config parameter is required/],
      [{ config: { modelName: 'm' } }, Error, /config must contain a string 'prompt' key/],
      [{ datasetSplit: 'yes' }, TypeError, /datasetSplit must be a boolean or an array/],
      [{ datasetSplit: [0.5, 0.5, 0] }, Error, /ratios must be numbers between 0 and 1/],
      [{ datasetSplit: [0.5, 0.2, 0.2] }, Error, /must sum to 1.0, got 0.9000/],
      [{ datasetSplit: [0.6, 0.2, 0.2], testDataset: 'test' }, Error, /Cannot use a 3-element datasetSplit/],
      [{ datasetSplit: [0.8, 0.2] }, Error, /A 2-element datasetSplit requires testDataset/],
      [{ datasetSplit: [0.2, 0.2, 0.2, 0.4] }, Error, /datasetSplit must have 2 or 3 elements/],
    ]

    for (const [overrides, errorType, message] of cases) {
      it(`rejects ${JSON.stringify(overrides, (_, value) => value === undefined ? 'undefined' : value)}`, () => {
        assert.throws(() => experiments.optimizePrompt(baseOptions(experiments, overrides)), errorType)
        assert.throws(() => experiments.optimizePrompt(baseOptions(experiments, overrides)), { message })
      })
    }

    it('accepts boundary split ratios that sum within tolerance', () => {
      experiments.optimizePrompt(baseOptions(experiments, { datasetSplit: [0.6, 0.2, 0.19] }))
      experiments.optimizePrompt(baseOptions(experiments, { datasetSplit: [0.6, 0.2, 0.21] }))
    })

    it('rejects non-object options', () => {
      assert.throws(() => experiments.optimizePrompt(null), { message: /options must be an object/ })
    })
  })

  describe('run() without dataset split', () => {
    it('runs a baseline plus maxIterations experiments and keeps the best prompt', async () => {
      const optimizationCalls = []
      const optimization = experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 2,
        optimizationTask: (request) => {
          optimizationCalls.push(request)
          return optimizationCalls.length === 1 ? 'improved' : 'worse'
        },
        tags: { team: 'llm' },
        config: { prompt: 'initial', modelName: 'gpt-4o', runs: 1 },
      }))

      const result = await optimization.run()

      assert.deepEqual(experimentNames(requests), ['opt_baseline', 'opt_iteration_1', 'opt_iteration_2'])
      assert.deepEqual(experimentConfigs(requests), [
        { prompt: 'initial', modelName: 'gpt-4o', runs: 1 },
        { prompt: 'improved', modelName: 'gpt-4o', runs: 1 },
        { prompt: 'worse', modelName: 'gpt-4o', runs: 1 },
      ])
      const createExperiment = requests.find(request => request.method === 'createExperiment')
      assert.deepEqual(createExperiment.attributes.metadata.tags.sort(), ['project_name:default-project', 'team:llm'])

      assert.equal(result.totalIterations, 3)
      assert.equal(result.bestIteration, 1)
      assert.equal(result.bestPrompt, 'improved')
      assert.equal(result.bestScore, 3)
      assert.equal(result.bestExperimentUrl, `${APP_BASE}/llm/experiments/exp-2`)
      assert.deepEqual(result.getScoreHistory(), [0, 3, 0])
      assert.deepEqual(result.getPromptHistory(), ['initial', 'improved', 'worse'])
      assert.equal(result.getHistory()[0].experimentUrl, `${APP_BASE}/llm/experiments/exp-1`)
      assert.deepEqual(result.getHistory()[1].summaryEvaluations, { stats: { value: { accuracy: 3 }, error: null } })
      assert.equal(result.getHistory()[1].results.experimentId, 'exp-2')
      assert.equal(result.getHistory()[1].trainExperimentUrl, undefined)
      assert.equal(result.testScore, null)
      assert.equal(result.testExperimentUrl, null)
      assert.equal(result.testResults, null)

      // The second optimization step starts from the best prompt so far, not the last one.
      assert.equal(optimizationCalls.length, 2)
      assert.match(optimizationCalls[1].userPrompt, /^Initial Prompt:\nimproved\n/)
      assert.equal(optimizationCalls[1].model, 'gpt-4o')
      assert.deepEqual(optimizationCalls[1].config, { prompt: 'initial', modelName: 'gpt-4o', runs: 1 })
      assert.deepEqual(optimizationCalls[1].messages, [
        { role: 'system', content: optimizationCalls[1].systemPrompt },
        { role: 'user', content: optimizationCalls[1].userPrompt },
      ])
    })

    it('runs only the baseline when maxIterations is 0', async () => {
      const result = await experiments.optimizePrompt(baseOptions(experiments, { maxIterations: 0 })).run()
      assert.deepEqual(experimentNames(requests), ['opt_baseline'])
      assert.equal(result.bestIteration, 0)
      assert.equal(result.bestPrompt, 'initial')
    })

    it('stops early when the stopping condition is met', async () => {
      const seen = []
      const result = await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 5,
        stoppingCondition: (summary) => {
          seen.push(summary)
          return summary.stats.value.accuracy >= 3
        },
      })).run()

      assert.deepEqual(experimentNames(requests), ['opt_baseline', 'opt_iteration_1'])
      assert.equal(result.totalIterations, 2)
      assert.deepEqual(seen, [{ stats: { value: { accuracy: 3 }, error: null } }])
      sinon.assert.calledWith(log.info, 'Stopping condition met after iteration %s', 1)
    })

    it('keeps the current prompt when optimizationTask throws or returns an empty value', async () => {
      let call = 0
      const result = await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 3,
        optimizationTask: () => {
          call++
          if (call === 1) throw new Error('llm down')
          if (call === 2) return ''
          return { newPrompt: 'not a string' }
        },
      })).run()

      assert.deepEqual(result.getPromptHistory(), ['initial', 'initial', 'initial', 'initial'])
      assert.equal(result.bestIteration, 0)
      sinon.assert.calledWithMatch(log.error, 'Iteration %s: Failed to run optimizationTask', 1)
      assert.equal(log.warn.callCount, 3)
    })

    it('awaits asynchronous optimizationTask callbacks', async () => {
      const result = await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 1,
        optimizationTask: async () => 'improved',
      })).run()
      assert.equal(result.bestPrompt, 'improved')
    })

    it('treats a null baseline score as 0 and ignores null iteration scores', async () => {
      let call = 0
      const result = await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 2,
        computeScore: () => (call++ === 2 ? 1 : null),
      })).run()

      assert.deepEqual(result.getScoreHistory(), [null, null, 1])
      assert.equal(result.bestIteration, 2)
      assert.equal(result.bestScore, 1)
    })

    it('forwards concurrency and surfaces task errors', async () => {
      const runSpy = sinon.spy(experiments.experiment({
        name: 'x', dataset: buildDataset(experiments), task: () => 1,
      }).constructor.prototype, 'run')

      await assert.rejects(experiments.optimizePrompt(baseOptions(experiments, {
        task: () => { throw new Error('task boom') },
      })).run({ concurrency: 2 }), { message: /task boom/ })

      sinon.assert.calledOnce(runSpy)
      assert.deepEqual(runSpy.firstCall.args[0], { throwOnErrors: true, concurrency: 2 })
    })
  })

  describe('run() with dataset split', () => {
    function splitOptions (overrides = {}) {
      return baseOptions(experiments, {
        dataset: buildDataset(experiments, 10),
        maxIterations: 1,
        ...overrides,
      })
    }

    it('splits 60/20/20 by default and runs train/valid/test experiments', async () => {
      const result = await experiments.optimizePrompt(splitOptions({ datasetSplit: true })).run()

      assert.deepEqual(experimentNames(requests), [
        'opt_baseline_train',
        'opt_baseline_valid',
        'opt_iteration_1_train',
        'opt_iteration_1_valid',
        'opt_iteration_1_test',
      ])

      assert.deepEqual(rowCounts(requests), [6, 2, 6, 2, 2])

      // Every sub-dataset reuses the pushed dataset id; only one dataset is created remotely.
      assert.equal(requests.filter(request => request.method === 'createDataset').length, 1)
      const datasetIds = requests
        .filter(request => request.method === 'createExperiment')
        .map(request => request.attributes.dataset_id)
      assert.deepEqual(new Set(datasetIds), new Set(['ds-1']))

      assert.equal(result.bestIteration, 1)
      assert.equal(result.bestScore, 2)
      assert.equal(result.bestExperimentUrl, `${APP_BASE}/llm/experiments/exp-4`)
      assert.equal(result.getHistory()[0].trainExperimentUrl, `${APP_BASE}/llm/experiments/exp-1`)
      assert.equal(result.getHistory()[1].trainExperimentUrl, `${APP_BASE}/llm/experiments/exp-3`)
      assert.equal(result.testScore, 2)
      assert.equal(result.testExperimentUrl, `${APP_BASE}/llm/experiments/exp-5`)
      assert.equal(result.testResults.experimentId, 'exp-5')
      sinon.assert.calledWith(log.info, 'Dataset split: %s train, %s valid, %s test records', 6, 2, 2)
    })

    it('shuffles deterministically with the fixed seed', () => {
      const first = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], DATASET_SPLIT_SEED)
      const second = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], DATASET_SPLIT_SEED)
      assert.deepEqual(first, second)
      assert.notDeepEqual(first, [1, 2, 3, 4, 5, 6, 7, 8])
      assert.deepEqual([...first].sort(), [1, 2, 3, 4, 5, 6, 7, 8])
    })

    it('uses the custom 3-way ratios', async () => {
      await experiments.optimizePrompt(splitOptions({ datasetSplit: [0.5, 0.3, 0.2] })).run()
      assert.deepEqual(rowCounts(requests), [5, 3, 5, 3, 2])
    })

    it('rejects when a split is empty', async () => {
      await assert.rejects(
        experiments.optimizePrompt(splitOptions({ dataset: buildDataset(experiments, 2), datasetSplit: true })).run(),
        { message: "Dataset split 'valid' is empty. Dataset has 2 records, which is too few for splitting." }
      )
    })

    it('splits 80/20 and pulls the external test dataset by name', async () => {
      const testDataset = Dataset.fromExisting(
        new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datadoghq.com', projectName: 'default-project' }),
        'holdout', '', 'ds-test', 'proj',
        [new DatasetRecord({ question: 'h' }, 'a', {}, 'h-1')], 1, 1
      )
      const pullDataset = sinon.stub(experiments, 'pullDataset').resolves(testDataset)

      const result = await experiments.optimizePrompt(splitOptions({ testDataset: 'holdout' })).run()

      sinon.assert.calledOnceWithExactly(pullDataset, 'holdout', { projectName: 'default-project' })
      assert.deepEqual(rowCounts(requests), [8, 2, 8, 2, 1])
      const testExperiment = requests.filter(request => request.method === 'createExperiment').at(-1)
      assert.equal(testExperiment.attributes.dataset_id, 'ds-test')
      assert.equal(result.testResults.rows.length, 1)
    })

    it('accepts a Dataset instance as testDataset with custom 2-way ratios', async () => {
      const testDataset = Dataset.fromExisting(
        new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datadoghq.com', projectName: 'default-project' }),
        'holdout', '', 'ds-test', 'proj',
        [new DatasetRecord({ question: 'h' }, 'a', {}, 'h-1')], 1, 1
      )
      await experiments.optimizePrompt(splitOptions({ testDataset, datasetSplit: [0.7, 0.3] })).run()
      assert.deepEqual(rowCounts(requests), [7, 3, 7, 3, 1])
    })
  })

  describe('optimization prompts', () => {
    it('builds the system prompt from the template with output format, model and a tip', async () => {
      sinon.stub(Math, 'random').returns(0)
      let request
      await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 1,
        optimizationTask: (req) => { request = req; return 'improved' },
        config: { prompt: 'initial', modelName: 'gpt-4o', evaluationOutputFormat: { verdict: 'boolean' } },
      })).run()

      const { systemPrompt } = request
      assert.ok(!systemPrompt.includes('{{STRUCTURE_PLACEHOLDER}}'))
      const templateHead = OPTIMIZATION_SYSTEM_PROMPT_TEMPLATE.split('{{STRUCTURE_PLACEHOLDER}}')[0]
      assert.equal(systemPrompt.slice(0, templateHead.length), templateHead)
      assert.ok(systemPrompt.includes(
        '## Prompt Output Format Requirements\n' +
        'The optimized prompt must guide the LLM to produce JSON output with this structure:\n\n\n' +
        '{"verdict":"boolean"}\n\n\n' +
        '**If this output format is not clearly specified in the initial prompt**\n' +
        '**add it as your first improvement step**'
      ))
      assert.ok(systemPrompt.includes(
        '\n\nIMPORTANT: The improved prompt will be applied to this evaluation model: gpt-4o\n' +
        'Consider the capabilities, limitations, and characteristics of this specific model when optimizing the prompt.'
      ))
      const tip = `\n\n**TIP: ${TIPS[Object.keys(TIPS)[0]]}**`
      assert.equal(systemPrompt.slice(-tip.length), tip)
    })

    it('omits the output format and model sections when not configured', async () => {
      let request
      await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 1,
        optimizationTask: (req) => { request = req; return 'improved' },
      })).run()

      assert.ok(!request.systemPrompt.includes('Prompt Output Format Requirements'))
      assert.ok(!request.systemPrompt.includes('IMPORTANT: The improved prompt'))
      assert.equal(request.model, null)
      assert.match(request.systemPrompt, /\n\n\*\*TIP: .+\*\*$/)
    })

    it('builds the user prompt with metrics and one example per label', async () => {
      sinon.stub(Math, 'random').returns(0)
      let request
      await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 1,
        optimizationTask: (req) => { request = req; return 'improved' },
        evaluators: {
          correct: () => ({ value: false, reasoning: 'mismatch' }),
        },
        summaryEvaluators: {
          stats: () => ({ accuracy: 0.5, f1: { macro: 0.4 } }),
          scalar: () => 3,
        },
        computeScore: (summary) => summary.stats.value.accuracy,
        labelize: (row) => (row.metadata?.row === 0 || row.input.question === 'q0' ? 'Bad' : 'Good'),
      })).run()

      assert.equal(request.userPrompt,
        'Initial Prompt:\ninitial\n\n\n' +
        'Performance Metrics:\n\n- accuracy: 0.5\n\n- f1: {"macro":0.4}\n\n\n\n' +
        '## Examples from Current Evaluation\n\n' +
        '### Bad\n\n' +
        'Input:\n{"question":"q0"}\nExpected Output:\na0\nActual Output:\ninitial:q0\n' +
        'Reasoning (correct):\nmismatch\n\n' +
        '### Good\n\n' +
        'Input:\n{"question":"q1"}\nExpected Output:\na1\nActual Output:\ninitial:q1\n' +
        'Reasoning (correct):\nmismatch\n'
      )
    })

    it('skips examples without a labelize function or with too many labels', async () => {
      const prompts = []
      await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 1,
        optimizationTask: (req) => { prompts.push(req.userPrompt); return 'improved' },
      })).run()
      assert.ok(!prompts[0].includes('## Examples'))

      await experiments.optimizePrompt(baseOptions(experiments, {
        dataset: buildDataset(experiments, 11),
        maxIterations: 1,
        optimizationTask: (req) => { prompts.push(req.userPrompt); return 'improved' },
        labelize: (row) => row.input.question,
      })).run()
      assert.ok(!prompts[1].includes('## Examples'))
      sinon.assert.calledWith(log.warn, 'Too many distinct labels: %s', 11)

      await experiments.optimizePrompt(baseOptions(experiments, {
        maxIterations: 1,
        optimizationTask: (req) => { prompts.push(req.userPrompt); return 'improved' },
        labelize: () => null,
      })).run()
      assert.ok(!prompts[2].includes('## Examples'))
    })
  })

  describe('OptimizationResult.summary()', () => {
    it('formats scores, urls and the best marker', async () => {
      const result = await experiments.optimizePrompt(baseOptions(experiments, { maxIterations: 1 })).run()
      assert.equal(result.summary(), [
        'Optimization: opt',
        'Total iterations: 2',
        'Best iteration: 1',
        'Best score: 3.0000',
        '\nBest iteration summary evaluations:\n{"stats":{"value":{"accuracy":3},"error":null}}',
        '\nScore progression:',
        `Iteration 0 (score: 0.0000): ${APP_BASE}/llm/experiments/exp-1`,
        `Iteration 1 (score: 3.0000): ${APP_BASE}/llm/experiments/exp-2 <- BEST`,
      ].join('\n'))
    })

    it('includes the test phase when dataset splitting is enabled', async () => {
      const result = await experiments.optimizePrompt(baseOptions(experiments, {
        dataset: buildDataset(experiments, 10),
        maxIterations: 0,
        datasetSplit: true,
      })).run()
      const summary = result.summary()
      assert.ok(summary.includes('Test score: 0.0000\n'))
      assert.ok(summary.includes(`Test experiment: ${APP_BASE}/llm/experiments/exp-3`))
      assert.ok(summary.includes('\nTest set summary evaluations:\n{"stats":{"value":{"accuracy":0},"error":null}}'))
    })

    it('prints N/A for missing scores', () => {
      const result = new OptimizationResult('n', 'p', [], 0)
      assert.match(result.summary(), /Best score: N\/A/)
      assert.equal(result.bestPrompt, 'p')
    })
  })
})
