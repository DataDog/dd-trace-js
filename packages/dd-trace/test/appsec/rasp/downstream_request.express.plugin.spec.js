'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('RASP - downstream request integration', () => {
  let sandbox, cwd, appFile

  before(async function () {
    this.timeout(60000)

    sandbox = await createSandbox(['express'], false, [path.join(__dirname, 'resources')])
    cwd = sandbox.folder
    appFile = path.join(cwd, 'resources', 'downstream-test-app.js')
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  async function setupTest (envOverrides = {}) {
    const agent = await new FakeAgent().start()
    const proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json'),
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        ...envOverrides
      }
    })
    const axios = Axios.create({ baseURL: proc.url })
    return { agent, proc, axios }
  }

  async function teardownTest (agent, proc) {
    proc.kill()
    await agent.stop()
  }

  function assertMessage (agent, withRequestHeaders = true, withResponseBody = true) {
    return agent.assertMessageReceived(({ payload }) => {
      const [span] = payload[0]
      assert.strictEqual(span.metrics['_dd.appsec.downstream_request'], 1)

      assert.exists(span.meta['_dd.appsec.trace.req_method'])
      assert.exists(span.meta['_dd.appsec.trace.res_status'])
      assert.exists(span.meta['_dd.appsec.trace.res_headers'])

      if (withRequestHeaders) {
        assert.exists(span.meta['_dd.appsec.trace.req_headers'])
      } else {
        assert.notExists(span.meta['_dd.appsec.trace.req_headers'])
      }
      if (withResponseBody) {
        assert.exists(span.meta['_dd.appsec.trace.res_body'])
      } else {
        assert.notExists(span.meta['_dd.appsec.trace.res_body'])
      }
    })
  }

  function assertTelemetry (agent) {
    let appsecTelemetryReceived = false

    return agent.assertTelemetryReceived(({ payload }) => {
      const namespace = payload.payload.namespace

      if (namespace === 'appsec') {
        appsecTelemetryReceived = true
        const series = payload.payload.series
        const hasTag = (serie, tag) => Array.isArray(serie.tags) && serie.tags.includes(tag)

        const evalSeries = series.filter(s => s.metric === 'rasp.rule.eval')
        assert.exists(evalSeries, 'Rasp rule eval series should exist')

        const evalVariants = new Set()
        for (const s of evalSeries) {
          if (hasTag(s, 'rule_variant:request')) evalVariants.add('request')
          if (hasTag(s, 'rule_variant:response')) evalVariants.add('response')
        }
        assert.isTrue(evalVariants.has('request'), 'rasp.rule.eval should include request variant')
        assert.isTrue(evalVariants.has('response'), 'rasp.rule.eval should include response variant')

        const matchSeries = series.filter(s => s.metric === 'rasp.rule.match')
        assert.exists(matchSeries, 'Rasp match eval series should exist')

        const matchVariants = new Set()
        for (const s of matchSeries) {
          if (hasTag(s, 'rule_variant:request')) matchVariants.add('request')
          if (hasTag(s, 'rule_variant:response')) matchVariants.add('response')
        }
        assert.isTrue(matchVariants.has('request'), 'rasp.rule.match should include request variant')
        assert.isTrue(matchVariants.has('response'), 'rasp.rule.match should include response variant')
      }
    }, 'generate-metrics', 30_000, 2).then(
      () => {
        assert.equal(appsecTelemetryReceived, true)
      })
  }

  describe('Downstream configuration', () => {
    describe('with body sampling enabled', () => {
      let agent, proc, axios

      beforeEach(async function () {
        this.timeout(60000)
        const setup = await setupTest({
          DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE: '1.0',
          DD_API_SECURITY_MAX_DOWNSTREAM_REQUEST_BODY_ANALYSIS: '10'
        })
        agent = setup.agent
        proc = setup.proc
        axios = setup.axios
      })

      afterEach(async () => {
        await teardownTest(agent, proc)
      })

      it('should set all tags', async () => {
        await axios.post('/with-body')

        await Promise.all([assertMessage(agent), assertTelemetry(agent)])
      })

      it('collects response body when stream is consumed via readable', async () => {
        await axios.post('/with-readable')

        await Promise.all([assertMessage(agent), assertTelemetry(agent)])
      })

      it('should not set headers and response body when it is not consumed', async () => {
        await axios.post('/without-body-and-headers')

        await Promise.all([assertMessage(agent, false, false), assertTelemetry(agent)])
      })
    })

    describe('with body sampling disabled', () => {
      let agent, proc, axios

      beforeEach(async function () {
        this.timeout(60000)
        const setup = await setupTest({
          DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE: '0.0',
          DD_API_SECURITY_MAX_DOWNSTREAM_REQUEST_BODY_ANALYSIS: '10'
        })
        agent = setup.agent
        proc = setup.proc
        axios = setup.axios
      })

      afterEach(async () => {
        await teardownTest(agent, proc)
      })

      it('still sets metric even when body sampling is disabled', async () => {
        await axios.post('/with-body')

        await Promise.all([assertMessage(agent, true, false), assertTelemetry(agent)])
      })
    })

    describe('with zero max count limit', () => {
      let agent, proc, axios

      beforeEach(async function () {
        this.timeout(60000)
        const setup = await setupTest({
          DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE: '1.0',
          DD_API_SECURITY_MAX_DOWNSTREAM_REQUEST_BODY_ANALYSIS: '0'
        })
        agent = setup.agent
        proc = setup.proc
        axios = setup.axios
      })

      afterEach(async () => {
        await teardownTest(agent, proc)
      })

      it('skips downstream analysis when limit is zero', async () => {
        await axios.post('/with-body')

        await Promise.all([assertMessage(agent, true, false), assertTelemetry(agent)])
      })
    })
  })
})
