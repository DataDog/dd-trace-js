'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')



describe('Plugin', () => {
  describe('jest', () => {
    let jest
    withVersions(plugin, 'jest', version => {
      before(() => {
        return agent.load('jest')
      })

      after(() => {
        return agent.close()
      })

      beforeEach(() => {
        jest = require(`../../../versions/jest@${version}`).get()
      })
      const options = {
        projects: [__dirname],
        // useStderr: true,
        coverageReporters: [],
        // reporters: [],
        testEnvironment: '<rootDir>/packages/datadog-plugin-jest/test/testEnvironment.js',
        testRunner: `<rootDir>/versions/jest-circus@${version}/node_modules/jest-circus/runner`,
        testRegex: './jest.test.js'
      }

      it('should create a test span for each test', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
        agent
          .use(traces => {
            try {
              expect(traces[0][0].meta).to.contain({
                language: 'javascript',
                service: 'test',
                'test.name': 'example',
                'test.status': 'pass',
                'test.suite': 'packages/datadog-plugin-jest/test/jest.test.js',
                'test.type': 'test'
              })
              expect(traces[0][0].type).to.equal('test')
              expect(traces[0][0].name).to.equal('jest.test')
              done()
            } catch (e) {
              done(e)
            }
          })
        jest.runCLI(options, options.projects)
      })
    })
  })
})
