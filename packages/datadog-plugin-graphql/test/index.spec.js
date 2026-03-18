'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('graphql', 'graphql', {
  category: 'graphql',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('graphql.parse() - graphql.parse', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'graphql.parse',
          meta: {
            component: 'graphql',
            'graphql.source': ANY_STRING,
          },
        }
      )

      await testSetup.graphqlParse()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'graphql.parse',
          meta: {
            component: 'graphql',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.graphqlParseError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('graphql.validate() - graphql.validate', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'graphql.validate',
          meta: {
            component: 'graphql',
          },
        }
      )

      await testSetup.graphqlValidate()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'graphql.validate',
          meta: {
            component: 'graphql',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.graphqlValidateError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('graphql.execute() - graphql.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'graphql.execute',
          meta: {
            component: 'graphql',
          },
        }
      )

      await testSetup.graphqlExecute()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'graphql.execute',
          meta: {
            component: 'graphql',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.graphqlExecuteError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
