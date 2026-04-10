'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('aws-durable-execution-sdk-js', '@aws/durable-execution-sdk-js', {
  category: 'orchestration',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('DurableContextImpl.step() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplStep()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'StepError',
          'error.message': 'Intentional step error',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplStepError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.runInChildContext() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplRunInChildContext()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'ChildContextError',
          'error.message': 'Intentional child context error',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplRunInChildContextError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCondition() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplWaitForCondition()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'Error',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplWaitForConditionError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCallback() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplWaitForCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'CallbackError',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplWaitForCallbackError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.createCallback() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplCreateCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'CallbackError',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplCreateCallbackError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.map() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplMap()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'ChildContextError',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplMapError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.parallel() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
        },
      })

      await testSetup.durableContextImplParallel()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'workflow.step.execute',
        meta: {
          component: 'aws-durable-execution-sdk-js',
          'span.kind': 'internal',
          'error.type': 'ChildContextError',
        },
        error: 1,
      })

      try {
        await testSetup.durableContextImplParallelError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
