'use strict'

/* eslint import/no-extraneous-dependencies: ["error", {"packageDir": ['./']}] */

const axios = require('axios')
const getPort = require('get-port')
const { execSync, spawn } = require('child_process')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { writeFileSync } = require('fs')

describe('Plugin', function () {
  let server
  let port

  describe('next', () => {
    withVersions(plugin, 'next', version => {
      const startServer = withConfig => {
        before(async () => {
          port = await getPort()

          return agent.load('next')
        })

        before(function (done) {
          const cwd = __dirname

          server = spawn('node', ['server'], {
            cwd,
            env: {
              ...process.env,
              VERSION: version,
              PORT: port,
              DD_TRACE_AGENT_PORT: agent.server.address().port,
              WITH_CONFIG: withConfig
            }
          })

          server.on('error', done)
          server.stderr.on('data', () => {})
          server.stdout.on('data', () => done())
        })

        after(async () => {
          server.kill()
          await axios.get(`http://localhost:${port}/api/hello/world`).catch(() => {})
          await agent.close()
        })
      }

      before(async function () {
        this.timeout(120 * 1000) // Webpack is very slow and builds on every test run

        const cwd = __dirname
        const pkg = require(`${__dirname}/../../../versions/next@${version}/package.json`)

        delete pkg.workspaces

        writeFileSync(`${__dirname}/package.json`, JSON.stringify(pkg, null, 2))

        execSync('npm --loglevel=error install', { cwd })

        // building in-process makes tests fail for an unknown reason
        execSync('npx next build', {
          cwd,
          env: {
            ...process.env,
            version
          },
          stdio: ['pipe', 'ignore', 'pipe']
        })
      })

      after(() => {
        execSync(`rm ${__dirname}/package.json`)
        execSync(`rm ${__dirname}/package-lock.json`)
        execSync(`rm -rf ${__dirname}/node_modules`)
        execSync(`rm -rf ${__dirname}/.next`)
      })

      describe('without configuration', () => {
        startServer()

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
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '404')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/missing`)
              .catch(() => {})
          })

          it('should handle invalid catch all parameters', done => {
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
        startServer(true)

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
              expect(spans[0].meta).to.have.property('foo', 'bar')
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
