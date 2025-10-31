'use strict'

const axios = require('axios')
const { satisfies } = require('semver')

const agent = require('../plugins/agent')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../../version')
const { withVersions } = require('../setup/mocha')
const { initApp, startServer } = require('./next.utils')

describe('test suite', () => {
  withVersions('next', 'next', '>=11.1', version => {
    if (version === '>=11.0.0 <13' && NODE_MAJOR === 24 &&
      NODE_MINOR === 0 && NODE_PATCH === 0) {
      return // node 24.0.0 fails, but 24.0.1 works
    }

    const realVersion = require(`../../../../versions/next@${version}`).version()

    const tests = [
      {
        appName: 'pages-dir',
        serverPath: 'server'
      }
    ]

    if (satisfies(realVersion, '>=13.2') && (NODE_MAJOR < 24 || satisfies(realVersion, '!=13.2'))) {
      tests.push({
        appName: 'app-dir',
        serverPath: '.next/standalone/server.js'
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
          axios
            .post(`http://127.0.0.1:${serverData.port}/api/test`, {
              key: 'testattack'
            }).catch(e => { done(e) })
        })

        it('in form data body', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          agent.subscribe(findBodyThreat)

          axios
            .post(`http://127.0.0.1:${serverData.port}/api/test-formdata`, new URLSearchParams({
              key: 'testattack'
            })).catch(e => {
              done(e)
            })
        })

        if (appName === 'app-dir') {
          it('in request body with .text() function', function (done) {
            this.timeout(5000)

            const findBodyThreat = getFindBodyThreatMethod(done)
            agent.subscribe(findBodyThreat)
            axios
              .post(`http://127.0.0.1:${serverData.port}/api/test-text`, {
                key: 'testattack'
              }).catch(e => {
                done(e)
              })
          })
        }

        it('in request query', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          axios
            .get(`http://127.0.0.1:${serverData.port}/api/test?param=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        it('in request query with array params, attack in the second  item', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          axios
            .get(`http://127.0.0.1:${serverData.port}/api/test?param[]=safe&param[]=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        it('in request query with array params, threat in the first item', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          axios
            .get(`http://127.0.0.1:${serverData.port}/api/test?param[]=testattack&param[]=safe`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })
      })
    })
  })
})
