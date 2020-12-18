'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS
} = require('../../dd-trace/src/plugins/util/test')
const { expect } = require('chai')
const path = require('path')

const mochaTestFile = path.join(__dirname, 'mocha-test.js')

describe('Plugin', () => {
  let Mocha
  withVersions(plugin, 'mocha', version => {
    afterEach(() => {
      // This needs to be done when using the programmatic API:
      // https://github.com/mochajs/mocha/wiki/Using-Mocha-programmatically
      // > If you want to run tests multiple times, you may need to clear Node's require cache
      // before subsequent calls in whichever manner best suits your needs.
      delete require.cache[require.resolve(mochaTestFile)]
      return agent.close()
    })
    beforeEach(() => {
      return agent.load('mocha').then(() => {
        Mocha = require(`../../../versions/mocha@${version}`).get()
      })
    })

    describe('mocha', () => {
      const MOCHA_TEST_NAME = 'can run tests'
      const MOCHA_TEST_SUITE = 'mocha-test.js'
      const MOCHA_ROOT_TEST_SUITE = 'dumb'
      it('should create a test span for a passing test', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: MOCHA_TEST_NAME,
              [TEST_STATUS]: 'pass',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'mocha'
            })
            expect(traces[0][0].meta[TEST_SUITE].endsWith(MOCHA_TEST_SUITE)).to.equal(true)
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('mocha.test')
            expect(traces[0][0].resource).to.equal(`${MOCHA_ROOT_TEST_SUITE} ${MOCHA_TEST_NAME}`)
          }).then(done).catch(done)
        const mocha = new Mocha()
        mocha.addFile(mochaTestFile)
        mocha.run()
      })
    })
  })
})
