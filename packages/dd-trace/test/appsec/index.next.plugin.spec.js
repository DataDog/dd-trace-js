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

        describe('with a response blocking rule', () => {
          it('should report the blocking status code when a Next.js 404 page is blocked', async () => {
            const [response] = await Promise.all([
              httpRequest.get(`http://127.0.0.1:${serverData.port}/api/blockresponse`, { validateStatus: false }),
              agent.assertSomeTraces(traces => {
                assertObjectContains(getWebSpan(traces), {
                  error: 0,
                  meta: {
                    'appsec.blocked': 'true',
                    'http.status_code': '403',
                  },
                })

                for (const span of traces.flat()) {
                  if (span.meta['http.status_code'] === undefined) continue
                  assert.strictEqual(span.meta['http.status_code'], '403', `${span.name} span status code`)
                }
              }),
            ])

            assert.strictEqual(response.status, 403)
            assert.deepStrictEqual(response.data.errors, JSON.parse(json).errors)
          })
        })

        describe('with a blocking rule', () => {
          const appDirTest = appName === 'app-dir' ? it : it.skip
          const appDirBodyBlockingTest = appName === 'app-dir' && satisfies(realVersion, '>=13.3') ? it : it.skip

          async function assertBlocked (request, spanMeta) {
            const [response] = await Promise.all([
              request,
              agent.assertSomeTraces(traces => {
                assertObjectContains(getWebSpan(traces).meta, {
                  'appsec.blocked': 'true',
                  ...spanMeta,
                })

                for (const span of traces.flat()) {
                  assert.strictEqual(span.meta['error.type'], undefined, `${span.name} span has an error`)
                }
              }),
            ])

            assert.strictEqual(response.status, 403)
            assert.deepStrictEqual(response.data.errors, JSON.parse(json).errors)
          }

          it('should block an attack in request query', () => {
            return assertBlocked(
              httpRequest.get(`http://127.0.0.1:${serverData.port}/api/test?param=blockattack`, {
                validateStatus: false,
              }),
              { 'http.status_code': '403' }
            )
          })

          for (const param of ['constructor', '__proto__']) {
            it(`should block an attack in a query parameter named ${param}`, () => {
              return assertBlocked(
                httpRequest.get(`http://127.0.0.1:${serverData.port}/api/test?${param}=blockattack`, {
                  validateStatus: false,
                }),
                { 'http.status_code': '403' }
              )
            })
          }

          appDirBodyBlockingTest('should block an attack in request body', () => {
            return assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test`, {
                key: 'blockattack',
              }, { validateStatus: false })
            )
          })

          appDirBodyBlockingTest('should block an attack in form data body', () => {
            return assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test-formdata`, new URLSearchParams({
                key: 'blockattack',
              }), { validateStatus: false })
            )
          })

          appDirBodyBlockingTest('should block an attack in request body with .text() function', () => {
            return assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test-text`, {
                key: 'blockattack',
              }, { validateStatus: false })
            )
          })

          appDirBodyBlockingTest('should block an attack in a cloned request body', () => {
            return assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test-clone`, {
                key: 'blockattack',
              }, { validateStatus: false })
            )
          })

          appDirBodyBlockingTest('should block an attack read from a clone before the request body', () => {
            return assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test-clone-peek`, {
                key: 'blockattack',
              }, { validateStatus: false })
            )
          })

          appDirBodyBlockingTest('should block an attack in the body of a clone of a cloned request', () => {
            return assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test-clone-chain`, {
                key: 'blockattack',
              }, { validateStatus: false })
            )
          })

          appDirBodyBlockingTest('should let Next.js error handling report a blocked request body', async () => {
            await assertBlocked(
              httpRequest.post(`http://127.0.0.1:${serverData.port}/api/test`, {
                key: 'blockattack',
              }, { validateStatus: false })
            )

            assert.match(serverData.stderr, /BlockedRequestError\]?: Request blocked by Datadog App and API Protection/)
          })

          appDirTest('should not block an attack in a request created by the route handler', async () => {
            const response = await httpRequest.post(`http://127.0.0.1:${serverData.port}/api/internal-request`)

            assert.strictEqual(response.status, 200)
            assert.deepStrictEqual(response.data.data, { key: 'blockattack' })
          })

          appDirTest('should not block an attack in a NextRequest created by the route handler', async () => {
            const response = await httpRequest.post(`http://127.0.0.1:${serverData.port}/api/internal-next-request`)

            assert.strictEqual(response.status, 200)
            assert.deepStrictEqual(response.data.data, { key: 'blockattack' })
          })
        })
      })
    })
  })
})
