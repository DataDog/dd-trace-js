'use strict'

/* eslint import/no-extraneous-dependencies: ["error", {"packageDir": ['./']}] */

const axios = require('axios')
const getPort = require('get-port')
const { execSync } = require('child_process')
const { parse } = require('url')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { writeFileSync } = require('fs')

describe('Plugin', function () {
  let next
  let app
  let listener
  let port

  describe('next', () => {
    withVersions(plugin, 'next', version => {
      const setup = config => {
        before(() => {
          return agent.load('next', config)
        })

        after(() => {
          listener.close()
          return agent.close()
        })

        before(async function () {
          this.timeout(120 * 1000) // Webpack is very slow and builds on every test run

          const { createServer } = require('http')
          const cwd = __dirname
          const pkg = require(`${__dirname}/../../../versions/next@${version}/package.json`)

          delete pkg.workspaces

          writeFileSync(`${__dirname}/package.json`, JSON.stringify(pkg, null, 2))

          execSync('npm --loglevel=warn install', { cwd })

          // building in-process makes tests fail for an unknown reason
          execSync('npx next build', {
            cwd,
            env: {
              ...process.env,
              version
            },
            stdio: ['pipe', 'ignore', 'pipe']
          })

          next = require('next') // eslint-disable-line import/no-extraneous-dependencies
          app = next({ dir: __dirname, dev: false, quiet: true })

          const handle = app.getRequestHandler()

          await app.prepare()

          listener = createServer((req, res) => {
            const parsedUrl = parse(req.url, true)

            handle(req, res, parsedUrl)
          })
        })

        after(() => {
          execSync(`rm ${__dirname}/package.json`)
          execSync(`rm ${__dirname}/package-lock.json`)
          execSync(`rm -rf ${__dirname}/node_modules`)
          execSync(`rm -rf ${__dirname}/.next`)

          for (const key in require.cache) {
            if (key.includes(`${__dirname}/node_modules`) || key.includes(`${__dirname}/.next`)) {
              delete require.cache[key]
            }
          }
        })

        before(done => {
          getPort()
            .then(_port => {
              port = _port
              listener.listen(port, 'localhost', () => done())
            })
        })
      }

      describe('without configuration', () => {
        setup()

        describe('for api routes', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /api/hello/[name]')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/hello/world`)
              .catch(done)
          })

          it('should propagate context', done => {
            axios
              .get(`http://localhost:${port}/api/hello/world`)
              .then(res => {
                expect(res.data.name).to.equal('next.request')
                done()
              })
              .catch(done)
          })

          it('should handle routes not found', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /404')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/missing`)
              .catch(() => {})
          })

          it.only('should handle invalid catch all parameters', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /_error')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '400')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/invalid/%ff`)
              .catch(() => {})
          })
        })

        describe('for pages', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /hello/[name]')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/hello/world`)
              .catch(done)
          })

          it('should handle pages not found', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /404')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '404')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/missing`)
              .catch(() => {})
          })
        })
      })

      describe('with configuration', () => {
        const config = {}

        before(() => {
          config.validateStatus = code => false
          config.hooks = {
            request: sinon.spy()
          }
        })

        setup(config)

        it('should execute the hook and validate the status', done => {
          agent
            .use(traces => {
              const spans = traces[0]

              expect(spans[0]).to.have.property('name', 'next.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET /api/hello/[name]')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property('span.kind', 'server')
              expect(spans[0].meta).to.have.property('http.method', 'GET')
              expect(spans[0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/api/hello/world`)
            .catch(done)
        })
      })
    })
  })
})
