'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let tracer
  withVersions(plugin, 'mocha', version => {
    afterEach(() => {
      return agent.close()
    })
    beforeEach(() => {
      tracer = require('../../dd-trace')
      return agent.load('mocha')
    })

    describe('mocha', (done) => {
      const TEST_NAME = 'test_name'
      const TEST_SUITE = 'test-file.js'
      const ROOT_TEST_SUITE = 'root'
      it('should create a test span for a passing test', () => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              'test.name': TEST_NAME,
              'test.status': 'pass',
              'test.suite': TEST_SUITE,
              'test.type': 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${ROOT_TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)

      })
    })
  })
})
