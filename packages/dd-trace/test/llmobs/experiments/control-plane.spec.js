'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { ExperimentsClient, API_BASE_PATH, UNSTABLE_API_BASE_PATH } =
  require('../../../src/llmobs/experiments/client')
const { parseCsv, readCsvRecords } = require('../../../src/llmobs/experiments/csv')
const { DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const { experimentSummaryFromResource, parseExperimentEvents } = require('../../../src/llmobs/experiments/pull')
const { ExperimentResult, Row } = require('../../../src/llmobs/experiments/result')

const API_BASE = 'https://api.datadoghq.com'

function jsonResponse (body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(body) }
}

describe('LLMObs experiments control-plane client', () => {
  let client
  let fetchStub

  beforeEach(() => {
    client = new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datadoghq.com', projectName: 'p' })
    fetchStub = sinon.stub(global, 'fetch')
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('publishCustomEvaluator', () => {
    it('PUTs an evaluator_config resource to the unstable config endpoint', async () => {
      fetchStub.resolves(jsonResponse({}))
      const evaluation = { eval_name: 'my-eval', applications: [] }

      await client.publishCustomEvaluator(evaluation)

      sinon.assert.calledOnce(fetchStub)
      const [url, init] = fetchStub.firstCall.args
      assert.equal(url, `${API_BASE}${UNSTABLE_API_BASE_PATH}/config/evaluators/custom`)
      assert.equal(init.method, 'PUT')
      assert.equal(init.headers['DD-API-KEY'], 'k')
      assert.equal(init.headers['DD-APPLICATION-KEY'], 'a')
      assert.equal(init.headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(init.body), {
        data: { type: 'evaluator_config', attributes: { evaluation } },
      })
    })

    it('wraps HTTP failures with the evaluator name', async () => {
      fetchStub.resolves(jsonResponse({ errors: ['bad'] }, { ok: false, status: 400 }))
      await assert.rejects(client.publishCustomEvaluator({ eval_name: 'my-eval' }), {
        message: /Failed to publish evaluator my-eval: PUT .* HTTP 400/,
      })
    })
  })

  describe('getExperiment', () => {
    it('GETs the experiment by id filter and returns the first resource', async () => {
      fetchStub.resolves(jsonResponse({ data: [{ id: 'exp-1', attributes: { name: 'n' } }] }))

      const resource = await client.getExperiment('exp 1')

      const [url, init] = fetchStub.firstCall.args
      assert.equal(url, `${API_BASE}${API_BASE_PATH}/experiments?filter[id]=exp%201`)
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      assert.deepEqual(resource, { id: 'exp-1', attributes: { name: 'n' } })
    })

    it('rejects when no experiment matches', async () => {
      fetchStub.resolves(jsonResponse({ data: [] }))
      await assert.rejects(client.getExperiment('missing'), { message: 'No experiments found for ID missing' })
    })

    it('wraps transport failures', async () => {
      fetchStub.rejects(new Error('fetch failed'))
      await assert.rejects(client.getExperiment('exp-1'), {
        message: /Failed to get experiment with ID exp-1: GET .* failed: fetch failed/,
      })
    })
  })

  describe('getExperimentEvents', () => {
    it('requests eval metrics by default', async () => {
      fetchStub.resolves(jsonResponse({ data: { attributes: { spans: [] } } }))
      const body = await client.getExperimentEvents('exp-1')
      assert.equal(
        fetchStub.firstCall.args[0],
        `${API_BASE}${UNSTABLE_API_BASE_PATH}/experiments/exp-1/events?include[eval_metrics]=true`
      )
      assert.deepEqual(body, { data: { attributes: { spans: [] } } })
    })

    it('omits the query when eval metrics are not requested', async () => {
      fetchStub.resolves(jsonResponse({}))
      await client.getExperimentEvents('exp-1', { includeEvalMetrics: false })
      assert.equal(fetchStub.firstCall.args[0], `${API_BASE}${UNSTABLE_API_BASE_PATH}/experiments/exp-1/events`)
    })
  })

  describe('listExperiments', () => {
    it('encodes filters the same way as dd-trace-py', async () => {
      fetchStub.resolves(jsonResponse({ data: [{ id: '1' }] }))

      const results = await client.listExperiments({
        experimentName: 'my exp',
        metadataFilter: { tags: ['git.commit.sha:abc'] },
        parentExperimentIds: ['p1', 'p2'],
        projectId: 'proj',
        datasetId: 'ds',
        isDeleted: true,
        pageLimit: 10,
      })

      assert.deepEqual(results, [{ id: '1' }])
      const url = new URL(fetchStub.firstCall.args[0])
      assert.equal(url.pathname, `${API_BASE_PATH}/experiments`)
      assert.equal(url.search, '?page[limit]=10&filter[experiment]=my+exp' +
        '&filter[metadata]=%7B%22tags%22%3A[%22git.commit.sha%3Aabc%22]%7D' +
        '&filter[parent_experiment_id]=p1&filter[parent_experiment_id]=p2' +
        '&filter[project_id]=proj&filter[dataset_id]=ds&filter[is_deleted]=true')
    })

    it('clamps the page limit to [1, 5000] and omits empty filters', async () => {
      fetchStub.resolves(jsonResponse({ data: [] }))
      await client.listExperiments({ pageLimit: 0, metadataFilter: {} })
      assert.equal(new URL(fetchStub.firstCall.args[0]).search, '?page[limit]=1')
      await client.listExperiments({ pageLimit: 10_000 })
      assert.equal(new URL(fetchStub.secondCall.args[0]).search, '?page[limit]=5000')
    })

    it('follows meta.after cursors and stops at maxResults', async () => {
      fetchStub.onFirstCall().resolves(jsonResponse({ data: [{ id: '1' }, { id: '2' }], meta: { after: 'c1' } }))
      fetchStub.onSecondCall().resolves(jsonResponse({ data: [{ id: '3' }, { id: '4' }], meta: { after: 'c2' } }))

      const results = await client.listExperiments({ pageLimit: 2, maxResults: 3 })

      assert.deepEqual(results.map(r => r.id), ['1', '2', '3'])
      sinon.assert.calledTwice(fetchStub)
      assert.equal(new URL(fetchStub.secondCall.args[0]).search, '?page[limit]=2&page[cursor]=c1')
    })

    it('stops when there is no cursor', async () => {
      fetchStub.onFirstCall().resolves(jsonResponse({ data: [{ id: '1' }], meta: { after: 'c1' } }))
      fetchStub.onSecondCall().resolves(jsonResponse({ data: [{ id: '2' }], meta: {} }))
      const results = await client.listExperiments()
      assert.deepEqual(results.map(r => r.id), ['1', '2'])
      sinon.assert.calledTwice(fetchStub)
    })

    it('rejects maxResults below 1 and wraps HTTP failures', async () => {
      await assert.rejects(client.listExperiments({ maxResults: 0 }), {
        message: 'max_results must be at least 1, got 0',
      })
      fetchStub.resolves(jsonResponse({}, { ok: false, status: 500 }))
      await assert.rejects(client.listExperiments(), { message: /Failed to list experiments: GET .* HTTP 500/ })
    })
  })

  describe('bulkUploadDatasetRecords', () => {
    it('POSTs a multipart CSV matching the Python writer', async () => {
      fetchStub.resolves(jsonResponse({}))
      const records = [
        new DatasetRecord({ q: 'a,b' }, 'yes', { k: 1 }, 'rec-1'),
        new DatasetRecord('plain "quoted"', null, {}, 'rec-2'),
      ]

      await client.bulkUploadDatasetRecords('ds-1', records, false)

      const [url, init] = fetchStub.firstCall.args
      assert.equal(url, `${API_BASE}${UNSTABLE_API_BASE_PATH}/datasets/ds-1/records/upload?deduplicate=false`)
      assert.equal(init.method, 'POST')
      assert.equal(init.headers['Content-Type'], 'multipart/form-data; boundary=----------boundary------')
      assert.equal(init.body,
        '------------boundary------\r\n' +
        'Content-Disposition: form-data; name="file"; filename="records.csv"\r\n' +
        'Content-Type: text/csv\r\n' +
        '\r\n' +
        'input,expected_output,metadata,id\r\n' +
        '"{""q"":""a,b""}","""yes""","{""k"":1}",rec-1\r\n' +
        '"""plain \\""quoted\\""""","""""",{},rec-2\r\n' +
        '\r\n' +
        '------------boundary--------\r\n'
      )
    })

    it('wraps failures', async () => {
      fetchStub.resolves(jsonResponse({}, { ok: false, status: 413 }))
      await assert.rejects(client.bulkUploadDatasetRecords('ds-1', [], true), {
        message: /Failed to upload dataset from file: POST .* HTTP 413/,
      })
    })
  })
})

describe('LLMObs experiments CSV reader', () => {
  it('parses quoted fields, doubled quotes, embedded newlines and CRLF', () => {
    const text = 'a,b,c\r\n1,"x,y","he said ""hi"""\n2,"multi\nline",\r\n'
    assert.deepEqual(parseCsv(text, ','), [
      ['a', 'b', 'c'],
      ['1', 'x,y', 'he said "hi"'],
      ['2', 'multi\nline', ''],
    ])
  })

  it('supports custom delimiters and rejects multi-character ones', () => {
    assert.deepEqual(parseCsv('a;b\n1;2\n', ';'), [['a', 'b'], ['1', '2']])
    assert.throws(() => parseCsv('"a', ','), { message: /unterminated/ })
    assert.throws(() => parseCsv('a', ',,'), { message: /single character/ })
  })

  it('maps rows onto the header, skipping blank lines and padding short rows', () => {
    const { header, rows } = readCsvRecords('q,a\n1,2\n\n3\n', ',')
    assert.deepEqual(header, ['q', 'a'])
    assert.deepEqual(rows, [{ q: '1', a: '2' }, { q: '3', a: '' }])
    assert.throws(() => readCsvRecords('', ','), { message: /header is missing/ })
    assert.throws(() => readCsvRecords(' , \n1,2\n', ','), { message: /header is missing/ })
  })
})

describe('LLMObs pulled experiment parsing', () => {
  it('maps an experiment resource onto a camelCase summary', () => {
    const summary = experimentSummaryFromResource({
      id: 'exp-1',
      attributes: {
        name: 'exp',
        project_id: 'proj',
        dataset_id: 'ds',
        dataset_version: '3',
        description: 'd',
        config: { a: 1 },
        run_count: 2,
        metadata: { tags: ['project_name:my-project', 'dataset_name:my-dataset', 'novalue'] },
        parent_experiment_id: 'parent',
        aggregate_data: { score: 1 },
        status: 'completed',
        created_at: '2024-01-01T00:00:00Z',
      },
    })
    assert.equal(summary.id, 'exp-1')
    assert.equal(summary.projectId, 'proj')
    assert.equal(summary.datasetVersion, 3)
    assert.equal(summary.runCount, 2)
    assert.deepEqual(summary.tags, { project_name: 'my-project', dataset_name: 'my-dataset' })
    assert.equal(summary.parentExperimentId, 'parent')
    assert.deepEqual(summary.aggregateData, { score: 1 })
    assert.equal(summary.error, null)
    assert.equal(summary.updatedAt, null)
  })

  it('converts span events and eval metrics into rows, keeping the latest metric per label', () => {
    const result = parseExperimentEvents({
      data: {
        attributes: {
          spans: [
            {
              span_id: 's1',
              trace_id: 't1',
              start_ns: 10,
              duration: 5,
              meta: { input: { q: 1 }, output: 'out', expected_output: 'exp' },
              eval_metrics: [
                { label: 'score', metric_type: 'score', score_value: 0.2, timestamp_ms: 1 },
                { label: 'score', metric_type: 'score', score_value: 0.9, timestamp_ms: 2, assessment: 'pass' },
                { label: 'broken', metric_type: 'boolean', boolean_value: null, error: { message: 'boom' } },
                { label: 'cat', metric_type: 'categorical', categorical_value: 'good', reasoning: 'because' },
              ],
            },
            {
              span_id: 's2',
              trace_id: 't2',
              meta: { input: {}, error: { message: 'task failed', stack: 'stack' } },
              eval_metrics: [],
            },
          ],
          summary_metrics: [{ label: 'avg', metric_type: 'score', score_value: 0.55 }],
        },
      },
    }, 'exp-1', 'https://app/exp-1')

    assert.ok(result instanceof ExperimentResult)
    assert.equal(result.experimentId, 'exp-1')
    assert.equal(result.url, 'https://app/exp-1')
    assert.equal(result.rows.length, 2)

    const [first, second] = result.rows
    assert.ok(first instanceof Row)
    assert.equal(first.index, 0)
    assert.equal(first.spanId, 's1')
    assert.equal(first.startNs, 10)
    assert.equal(first.durationNs, 5)
    assert.deepEqual(first.input, { q: 1 })
    assert.equal(first.output, 'out')
    assert.equal(first.expectedOutput, 'exp')
    assert.deepEqual(first.evaluations, { score: 0.9, cat: 'good' })
    assert.deepEqual(first.evaluationErrors, { broken: 'boom' })
    assert.equal(first.evaluationDetails.score.assessment, 'pass')
    assert.equal(first.evaluationDetails.cat.reasoning, 'because')
    assert.equal(first.isError, false)

    assert.equal(second.errorType, 'Error')
    assert.equal(second.errorMessage, 'task failed')
    assert.equal(second.errorStack, 'stack')
    assert.equal(second.output, null)
    assert.equal(second.isError, true)

    assert.equal(result.summaryEvaluations.avg.value, 0.55)
    assert.equal(result.runs.length, 1)
    assert.equal(result.runs[0].hasError, true)
    assert.equal(result.runs[0].rows.length, 2)
  })

  it('returns an empty result for responses without spans', () => {
    const result = parseExperimentEvents({}, 'exp-1', null)
    assert.deepEqual(result.rows, [])
    assert.equal(result.runs[0].hasError, false)
  })
})

describe('LLMObs experiments facade control-plane methods', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')

  const log = require('../../../src/log')
  const { createExperiments } = require('../../../src/llmobs/experiments')
  const { Dataset } = require('../../../src/llmobs/experiments/dataset')
  const { BooleanStructuredOutput, LLMJudge } = require('../../../src/llmobs/evaluators')
  const NoopExperiments = require('../../../src/llmobs/experiments/noop')

  const enabledConfig = (llmobs = {}) => ({
    site: 'datadoghq.com',
    DD_API_KEY: 'k',
    DD_APP_KEY: 'a',
    service: 'my-service',
    llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'my-app', ...llmobs },
  })

  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmobs-csv-'))
  })

  afterEach(() => {
    sinon.restore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function judge () {
    return new LLMJudge({
      name: 'my-judge',
      userPrompt: 'Rate {{output_data}}',
      provider: 'openai',
      model: 'gpt-4o',
      structuredOutput: new BooleanStructuredOutput({ description: 'ok?' }),
      modelCall () {},
    })
  }

  describe('publishEvaluator', () => {
    it('publishes the LLMJudge payload and returns the UI url', async () => {
      const publish = sinon.stub(ExperimentsClient.prototype, 'publishCustomEvaluator').resolves()
      const experiments = createExperiments(enabledConfig())

      const result = await experiments.publishEvaluator(judge(), { agentService: 'agent-svc' })

      sinon.assert.calledOnce(publish)
      const evaluation = publish.firstCall.args[0]
      assert.equal(evaluation.eval_name, 'my-judge')
      assert.equal(evaluation.applications[0].application_name, 'agent-svc')
      assert.equal(result.uiUrl,
        'https://app.datadoghq.com/llm/evaluations/custom?evalName=my-judge&applicationName=agent-svc')
    })

    it('falls back to mlApp (deprecated, warns) then the configured ml app', async () => {
      const publish = sinon.stub(ExperimentsClient.prototype, 'publishCustomEvaluator').resolves()
      const warn = sinon.stub(log, 'warn')
      const experiments = createExperiments(enabledConfig())

      await experiments.publishEvaluator(judge(), { mlApp: 'legacy', evalName: 'renamed' })
      assert.equal(publish.firstCall.args[0].applications[0].application_name, 'legacy')
      assert.equal(publish.firstCall.args[0].eval_name, 'renamed')
      sinon.assert.calledWith(warn, sinon.match(/deprecated/))

      await experiments.publishEvaluator(judge())
      assert.equal(publish.secondCall.args[0].applications[0].application_name, 'my-app')
    })

    it('rejects non-publishable evaluators and blank agent services', async () => {
      const experiments = createExperiments(enabledConfig({ mlApp: undefined }))
      await assert.rejects(experiments.publishEvaluator({}), { name: 'TypeError', message: /LLMJudge/ })
      await assert.rejects(experiments.publishEvaluator(judge(), { agentService: '  ' }), {
        message: /agentService/,
      })
    })
  })

  describe('pullExperiment', () => {
    it('combines metadata and events into a pulled experiment', async () => {
      sinon.stub(ExperimentsClient.prototype, 'getExperiment').resolves({
        id: 'exp-1',
        attributes: { name: 'exp', project_id: 'proj', metadata: { tags: ['project_name:tagged'] } },
      })
      sinon.stub(ExperimentsClient.prototype, 'getExperimentEvents').resolves({
        data: { attributes: { spans: [{ span_id: 's1', trace_id: 't1', meta: { input: {}, output: 'o' } }] } },
      })
      const experiments = createExperiments(enabledConfig())

      const pulled = await experiments.pullExperiment('exp-1')

      assert.equal(pulled.id, 'exp-1')
      assert.equal(pulled.name, 'exp')
      assert.equal(pulled.projectName, 'tagged')
      assert.equal(pulled.url, 'https://app.datadoghq.com/llm/experiments/exp-1')
      assert.equal(pulled.result.url, pulled.url)
      assert.equal(pulled.result.rows.length, 1)
      assert.equal(pulled.result.rows[0].output, 'o')
    })

    it('falls back to the configured project name and validates the id', async () => {
      sinon.stub(ExperimentsClient.prototype, 'getExperiment').resolves({ id: 'exp-1', attributes: {} })
      sinon.stub(ExperimentsClient.prototype, 'getExperimentEvents').resolves({})
      const experiments = createExperiments(enabledConfig({ projectName: 'configured' }))
      const pulled = await experiments.pullExperiment('exp-1')
      assert.equal(pulled.projectName, 'configured')
      await assert.rejects(experiments.pullExperiment(''), { message: 'experimentId is required.' })
    })
  })

  describe('listExperiments', () => {
    it('resolves the project and maps resources to summaries', async () => {
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj-1')
      const list = sinon.stub(ExperimentsClient.prototype, 'listExperiments').resolves([
        { id: 'e1', attributes: { name: 'one', project_id: 'proj-1' } },
      ])
      const experiments = createExperiments(enabledConfig())

      const summaries = await experiments.listExperiments({ experimentName: 'one', maxResults: 5 })

      assert.equal(summaries.length, 1)
      assert.equal(summaries[0].id, 'e1')
      assert.equal(summaries[0].name, 'one')
      sinon.assert.calledWithMatch(list, { experimentName: 'one', projectId: 'proj-1', pageLimit: 100, maxResults: 5 })
    })

    it('surfaces project resolution failures and invalid maxResults', async () => {
      const experiments = createExperiments(enabledConfig())
      await assert.rejects(experiments.listExperiments({ maxResults: 0 }), { message: /max_results/ })
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').rejects(new Error('nope'))
      await assert.rejects(experiments.listExperiments({ projectName: 'other' }), {
        message: "Failed to resolve project 'other' for listExperiments(): nope",
      })
    })
  })

  describe('createDatasetFromCsv', () => {
    function writeCsv (content, name = 'data.csv') {
      const csvPath = path.join(tmpDir, name)
      fs.writeFileSync(csvPath, content)
      return csvPath
    }

    function stubCreate () {
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj-1')
      sinon.stub(ExperimentsClient.prototype, 'createDataset').resolves({
        id: () => 'ds-1',
        latestVersion: () => 0,
      })
      return sinon.stub(ExperimentsClient.prototype, 'bulkUploadDatasetRecords').resolves()
    }

    it('reads the CSV, builds records and bulk uploads them', async () => {
      const upload = stubCreate()
      const csvPath = writeCsv('id;question;answer;source\nr1;"what?";"that";web\nr2;why;because;book\n')
      const experiments = createExperiments(enabledConfig())

      const dataset = await experiments.createDatasetFromCsv({
        csvPath,
        datasetName: 'csv-dataset',
        inputDataColumns: ['question'],
        expectedOutputColumns: ['answer'],
        metadataColumns: ['source'],
        idColumn: 'id',
        csvDelimiter: ';',
        description: 'from csv',
        deduplicate: false,
      })

      assert.ok(dataset instanceof Dataset)
      assert.equal(dataset.name(), 'csv-dataset')
      assert.equal(dataset.description(), 'from csv')
      assert.equal(dataset.id(), 'ds-1')
      assert.equal(dataset.projectId(), 'proj-1')
      assert.equal(dataset.records().length, 2)

      sinon.assert.calledOnce(upload)
      const [datasetId, records, deduplicate] = upload.firstCall.args
      assert.equal(datasetId, 'ds-1')
      assert.equal(deduplicate, false)
      const shape = r => ({ id: r.id, input: r.input, expectedOutput: r.expectedOutput, metadata: r.metadata })
      assert.deepEqual(records.map(shape), [
        { id: 'r1', input: { question: 'what?' }, expectedOutput: { answer: 'that' }, metadata: { source: 'web' } },
        { id: 'r2', input: { question: 'why' }, expectedOutput: { answer: 'because' }, metadata: { source: 'book' } },
      ])
    })

    it('skips the upload for an empty CSV body and defaults optional columns', async () => {
      const upload = stubCreate()
      const csvPath = writeCsv('question\n')
      const experiments = createExperiments(enabledConfig())
      const dataset = await experiments.createDatasetFromCsv({
        csvPath, datasetName: 'empty', inputDataColumns: ['question'],
      })
      assert.equal(dataset.records().length, 0)
      sinon.assert.notCalled(upload)
    })

    it('validates options and column names against the header', async () => {
      stubCreate()
      const csvPath = writeCsv('question,answer\nq,a\n')
      const experiments = createExperiments(enabledConfig())
      const base = { csvPath, datasetName: 'd', inputDataColumns: ['question'] }

      await assert.rejects(experiments.createDatasetFromCsv({ ...base, csvPath: '' }), { message: /csvPath/ })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, datasetName: '' }), { message: /datasetName/ })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, inputDataColumns: [] }), {
        message: /at least one column/,
      })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, inputDataColumns: 'question' }), {
        name: 'TypeError',
      })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, inputDataColumns: ['missing'] }), {
        message: 'Input columns not found in CSV header: ["missing"]',
      })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, expectedOutputColumns: ['x'] }), {
        message: 'Expected output columns not found in CSV header: ["x"]',
      })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, metadataColumns: ['x'] }), {
        message: 'Metadata columns not found in CSV header: ["x"]',
      })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, idColumn: 'x' }), {
        message: "ID column 'x' not found in CSV header",
      })
      await assert.rejects(experiments.createDatasetFromCsv({ ...base, csvPath: writeCsv('', 'empty.csv') }), {
        message: /header is missing/,
      })
    })

    it('wraps dataset creation failures', async () => {
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj-1')
      sinon.stub(ExperimentsClient.prototype, 'createDataset').rejects(new Error('boom'))
      const csvPath = writeCsv('question\nq\n')
      const experiments = createExperiments(enabledConfig())
      const options = { csvPath, datasetName: 'd', inputDataColumns: ['question'] }
      await assert.rejects(experiments.createDatasetFromCsv(options), { message: "Failed to create dataset 'd': boom" })
    })
  })

  describe('no-op experiments', () => {
    it('warns and returns inert values for the control-plane methods', async () => {
      const warn = sinon.stub(log, 'warn')
      const noop = new NoopExperiments('disabled')
      assert.ok(createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } }) instanceof NoopExperiments)

      assert.deepEqual(await noop.publishEvaluator(judge()), { uiUrl: null })
      const pulled = await noop.pullExperiment('exp-1')
      assert.equal(pulled.id, 'exp-1')
      assert.deepEqual(pulled.result, { experimentId: null, rows: [], summaryEvaluations: {}, runs: [], url: null })
      assert.deepEqual(await noop.listExperiments(), [])
      const dataset = await noop.createDatasetFromCsv({ csvPath: 'x.csv', datasetName: 'd', description: 'desc' })
      assert.equal(dataset.name(), 'd')
      assert.equal(dataset.description(), 'desc')
      assert.equal(dataset.id(), null)
      assert.deepEqual(dataset.records(), [])
      assert.equal(warn.callCount, 4)
      sinon.assert.alwaysCalledWith(warn, 'LLMObs experiments unavailable: %s', 'disabled')
    })
  })
})
