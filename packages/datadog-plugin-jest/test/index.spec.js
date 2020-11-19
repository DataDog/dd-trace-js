'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const resolve = require('resolve')
const path = require('path')

describe('Plugin', () => {
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

    const testRunnerPath = resolve.sync('jest-circus/runner', {
      basedir: path.resolve(`${__dirname}/../../../versions/jest-circus@${version}`)
    })

    const options = {
      projects: [__dirname],
      useStderr: true,
      coverageReporters: [],
      reporters: [],
      testEnvironment: '<rootDir>/packages/datadog-plugin-jest/test/testEnvironment.js',
      testRunner: testRunnerPath,
      testRegex: './jest.test.js'
    }

    describe('jest', () => {
      it('should create a test span for each test', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
        agent
          .use(traces => {
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
          }).then(done).catch(done)
        jest.runCLI(options, options.projects)
      })
    })
  })
})
