'use strict'

const tracerVersion = require('../../../package.json').version
const telemetry = require('../src/telemetry')
const http = require('http')

describe('telemetry', () => {
  let traceAgent
  let origSetInterval

  beforeEach(done => {
    origSetInterval = setInterval
    let expectedRequests
    let resolveDoneIntervals
    const doneIntervals = new Promise((resolve, reject) => {
      resolveDoneIntervals = resolve
    })
    global.setInterval = (fn, interval) => {
      expect(interval).to.equal(60000)
      let intervals = 0
      return origSetInterval(() => {
        fn()
        // we want a few more intervals than requests
        if (++intervals === expectedRequests + 3) {
          resolveDoneIntervals()
        }
      }, 0)
    }
    let requestCount = 0
    traceAgent = http.createServer(async (req, res) => {
      try {
        if (++requestCount > expectedRequests) {
          throw new Error(`expected only ${expectedRequests} requests`)
        }
        const chunks = []
        for await (const chunk of req) {
          chunks.push(chunk)
        }
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        await traceAgent.handlers.shift()(req)
        res.end(() => {
          if (traceAgent.handlers.length === 0) {
            traceAgent.resolveHandled()
          }
        })
      } catch (e) {
        traceAgent.rejectHandled(e)
      }
    }).listen(0, done)

    // Only call this once per test
    traceAgent.handle = function (...handlers) {
      expectedRequests = handlers.length
      this.handlers = handlers
      return Promise.all([
        doneIntervals,
        new Promise((resolve, reject) => {
          this.resolveHandled = resolve
          this.rejectHandled = reject
        })
      ])
    }
  })

  afterEach(() => {
    traceAgent.close()
    global.setInterval = origSetInterval
  })

  it('should work', async () => {
    const instrumentedMap = new Map([
      [{ name: 'foo' }, {}],
      [{ name: 'bar' }, {}]
    ])
    const interval = telemetry({
      hostname: 'localhost',
      port: traceAgent.address().port,
      service: 'test service',
      version: '1.2.3-beta4',
      env: 'preprod',
      experimental: {
        runtimeIdValue: '1a2b3c'
      }
    }, {
      _instrumented: instrumentedMap
    })

    const backendHost = 'tracer-telemetry-edge.datadoghq.com'
    const backendUrl = `https://${backendHost}/api/v1/intake/apm-app-env`
    const testSeq = (seqId, ...instrumented) => req => {
      expect(req.method).to.equal('POST')
      expect(req.url).to.equal(backendUrl)
      expect(req.headers.host).to.equal(backendHost)
      expect(Math.floor(Date.now() / 1000 - req.headers['dd-tracer-timestamp'])).to.equal(0)
      expect(req.headers['content-type']).to.equal('application/json')

      expect(req.body.runtime_id).to.equal('1a2b3c')
      expect(req.body.seq_id).to.equal(seqId)
      expect(req.body.service_name).to.equal('test service')
      expect(req.body.env).to.equal('preprod')
      expect(req.body.started_at).to.equal(Math.floor(Date.now() / 1000) - Math.floor(process.uptime()))
      expect(req.body.tracer_version).to.equal(tracerVersion)
      expect(req.body.language_name).to.equal('node_js')
      expect(req.body.integrations).to.deep.equal(instrumented.map(name => ({
        name, enabled: true, auto_enabled: true
      })))
      // TODO dependencies
      expect(req.body.service_version).to.equal('1.2.3-beta4')
      expect(req.body.language_version).to.equal(process.versions.node)
      expect(req.body.configuration).to.deep.equal({
        hostname: 'localhost',
        port: traceAgent.address().port,
        service: 'test service',
        env: 'preprod',
        version: '1.2.3-beta4',
        'experimental.runtimeIdValue': '1a2b3c'
      })

      // Next iteration, baz will be set
      instrumentedMap.set({ name: 'baz' }, {})
    }
    await traceAgent.handle(
      testSeq(0, 'foo', 'bar'),
      testSeq(1, 'foo', 'bar', 'baz')
    )
    clearInterval(interval)
  })
})
