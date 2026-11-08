'use strict'

const assert = require('node:assert/strict')

const { satisfies } = require('semver')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../../version')
const { json } = require('../../src/appsec/blocking/templates')
const agent = require('../plugins/agent')
const { withVersions } = require('../setup/mocha')
const httpRequest = require('../setup/helpers/http-client')
const { initApp, startServer } = require('./next.utils')
const { getWebSpan } = require('./utils')

describe('test suite', () => {
  withVersions('next', 'next', '>=11.1', version => {
    const realVersion = require(`../../../../versions/next@${version}`).version()

    if (satisfies(realVersion, '>=12 <13') && NODE_MAJOR === 24 &&
      NODE_MINOR === 0 && NODE_PATCH === 0) {
      return // next 12.x fails on node 24.0.0, but 24.0.1 works
    }

    if (satisfies(realVersion, '>=12 <13') && NODE_MAJOR >= 26) {
      return // next 12.x fails to build on Node.js 26
    }

    if (satisfies(realVersion, '>=16') && NODE_MAJOR < 20) {
      return
    }

    const tests = [
      {
        appName: 'pages-dir',
        serverPath: 'server',
      },
    ]

    if (satisfies(realVersion, '>=13.2') && (NODE_MAJOR < 24 || satisfies(realVersion, '!=13.2'))) {
      tests.push({
        appName: 'app-dir',
        serverPath: '.next/standalone/server.js',
      })
    }

    function getFindBodyThreatMethod (done) {
      return function findBodyThreat (traces) {
        let attackFound = false

        traces.forEach(trace => {
          trace.forEach(span => {
            if (span.meta['_dd.appsec.json']) {
              attackFound = true
            }
          })
        })

        if (attackFound) {
          agent.unsubscribe(findBodyThreat)
          done()
        }
      }
    }

    tests.forEach(({ appName, serverPath }) => {
      describe(`should detect threats in ${appName}`, () => {
        initApp(appName, version, realVersion)

        const serverData = startServer(appName, serverPath, version)

        it('in request body', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          agent.subscribe(findBodyThreat)
          httpRequest
            .post(`http://127.0.0.1:${serverData.port}/api/test`, {
              key: 'testattack',
            }).catch(e => { done(e) })
        })

        it('in form data body', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          agent.subscribe(findBodyThreat)

          httpRequest
            .post(`http://127.0.0.1:${serverData.port}/api/test-formdata`, new URLSearchParams({
              key: 'testattack',
            })).catch(e => {
              done(e)
            })
        })

        {
          const requestTextTest = appName === 'app-dir' ? it : it.skip

          requestTextTest('in request body with .text() function', function (done) {
            this.timeout(5000)

            const findBodyThreat = getFindBodyThreatMethod(done)
            agent.subscribe(findBodyThreat)
            httpRequest
              .post(`http://127.0.0.1:${serverData.port}/api/test-text`, {
                key: 'testattack',
              }).catch(e => {
                done(e)
              })
          })
        }

        it('in request query', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          httpRequest
            .get(`http://127.0.0.1:${serverData.port}/api/test?param=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        it('in request query with array params, attack in the second  item', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          httpRequest
            .get(`http://127.0.0.1:${serverData.port}/api/test?param[]=safe&param[]=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        it('in request query with array params, threat in the first item', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          httpRequest
            .get(`http://127.0.0.1:${serverData.port}/api/test?param[]=testattack&param[]=safe`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        describe('with a blocking rule', () => {
          async function assertBlocked (request) {
            const [response] = await Promise.all([
              request,
              agent.assertSomeTraces(traces => {
                assertObjectContains(getWebSpan(traces).meta, {
                  'appsec.blocked': 'true',
                  'http.status_code': '403',
                })
              }),
            ])

            assert.strictEqual(response.status, 403)
            assert.deepStrictEqual(response.data.errors, JSON.parse(json).errors)
          }

          it('should block an attack in request query', () => {
            return assertBlocked(
              httpRequest.get(`http://127.0.0.1:${serverData.port}/api/test?param=blockattack`, {
                validateStatus: false,
              })
            )
          })
        })
      })
    })
  })
})
