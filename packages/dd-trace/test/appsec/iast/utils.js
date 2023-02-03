'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const getPort = require('get-port')
const agent = require('../../plugins/agent')
const axios = require('axios')
const iast = require('../../../src/appsec/iast')
const Config = require('../../../src/config')

function testInRequest (app, tests) {
  let http
  let listener
  let appListener
  const config = {}

  beforeEach(() => {
    return getPort().then(newPort => {
      config.port = newPort
    })
  })

  beforeEach(() => {
    listener = (req, res) => {
      const appResult = app && app(req, res)
      if (appResult && typeof appResult.then === 'function') {
        appResult.then(() => {
          res.writeHead(200)
          res.end()
        })
      } else {
        res.writeHead(200)
        res.end()
      }
    }
  })

  beforeEach(() => {
    return agent.load('http', undefined, { flushInterval: 1 })
      .then(() => {
        http = require('http')
      })
  })

  beforeEach(done => {
    const server = new http.Server(listener)
    appListener = server
      .listen(config.port, 'localhost', () => done())
  })

  afterEach(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
  })

  tests(config)
}

function prepareTests () {
  beforeEach(() => {
    iast.enable(new Config({
      experimental: {
        iast: {
          enabled: true,
          requestSampling: 100
        }
      }
    }))
  })

  afterEach(() => {
    iast.disable()
  })
}

function testThatRequestHasVulnerability (app, vulnerability) {
  function tests (config) {
    prepareTests()
    it(`should have ${vulnerability} vulnerability`, function (done) {
      agent
        .use(traces => {
          expect(traces[0][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
        })
        .then(done)
        .catch(done)
      axios.get(`http://localhost:${config.port}/`).catch(done)
    })
  }

  testInRequest(app, tests)
}

function testThatRequestHasNoVulnerability (app, vulnerability) {
  function tests (config) {
    prepareTests()

    it(`should not have ${vulnerability} vulnerability`, function (done) {
      agent
        .use(traces => {
          // iastJson == undefiend is valid
          const iastJson = traces[0][0].meta['_dd.iast.json'] || ''
          expect(iastJson).to.not.include(`"${vulnerability}"`)
        })
        .then(done)
        .catch(done)
      axios.get(`http://localhost:${config.port}/`).catch(done)
    })
  }

  testInRequest(app, tests)
}

function testOutsideRequestHasVulnerability (fnToTest, vulnerability) {
  beforeEach(async () => {
    await agent.load()
  })
  afterEach(() => {
    return agent.close({ ritmReset: false })
  })
  beforeEach(() => {
    const tracer = require('../../..')
    iast.enable(new Config({
      experimental: {
        iast: {
          enabled: true,
          requestSampling: 100
        }
      }
    }), tracer)
  })

  afterEach(() => {
    iast.disable()
  })
  it(`should detect ${vulnerability} vulnerability out of request`, function (done) {
    agent
      .use(traces => {
        expect(traces[0][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
      })
      .then(done)
      .catch(done)
    fnToTest()
  })
}

let index = 0
function copyFileToTmp (src) {
  const srcName = `dd-iast-${index++}-${path.basename(src)}`
  const dest = path.join(os.tmpdir(), srcName)
  fs.copyFileSync(src, dest)
  return dest
}

module.exports = {
  testThatRequestHasNoVulnerability,
  testThatRequestHasVulnerability,
  testOutsideRequestHasVulnerability,
  testInRequest,
  copyFileToTmp
}
