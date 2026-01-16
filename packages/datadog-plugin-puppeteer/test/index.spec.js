'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('puppeteer', 'puppeteer', {
  category: 'not_applicable'
}, (meta) => {
  const { agent, tracer, span } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('PuppeteerNode.launch() - launch', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.launch',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.puppeteerNodeLaunch()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.launch',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.puppeteerNodeLaunchError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('CdpFrame.goto() - navigate', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.goto',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.cdpFrameGoto()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.goto',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.cdpFrameGotoError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Page.screenshot() - screenshot', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.screenshot',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pageScreenshot()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.screenshot',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pageScreenshotError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Page.evaluate() - evaluate', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.evaluate',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pageEvaluate()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.evaluate',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pageEvaluateError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Page.click() - click', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.click',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pageClick()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.click',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pageClickError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Page.type() - type', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.type',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pageType()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.type',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pageTypeError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Page.waitForSelector() - waitForSelector', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.waitForSelector',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pageWaitForSelector()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.waitForSelector',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pageWaitForSelectorError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Browser.newPage() - newPage', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.newPage',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.browserNewPage()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.newPage',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.browserNewPageError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Browser.close() - close', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.close',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.browserClose()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.close',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.browserCloseError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('CdpFrame.setContent() - setContent', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.setContent',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.cdpFrameSetContent()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.setContent',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.cdpFrameSetContentError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('CdpFrame.waitForNavigation() - waitForNavigation', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.waitForNavigation',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.cdpFrameWaitForNavigation()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'puppeteer.waitForNavigation',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.cdpFrameWaitForNavigationError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
