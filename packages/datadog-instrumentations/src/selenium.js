const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const ciSeleniumDriverGetStartCh = channel('ci:selenium:driver:get')

const RUM_STOP_SESSION_SCRIPT = `
if (window.DD_RUM && window.DD_RUM.stopSession) {
  window.DD_RUM.stopSession();
  return true;
} else {
  return false;
}
`
const IS_RUM_ACTIVE_SCRIPT = 'return !!window.DD_RUM'

const DD_CIVISIBILITY_RUM_FLUSH_WAIT_MILLIS = 500
const DD_CIVISIBILITY_TEST_EXECUTION_ID_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

// TODO: can we increase the supported version range?
addHook({
  name: 'selenium-webdriver',
  versions: ['>=4.11.0']
}, (seleniumPackage, seleniumVersion) => {
  // TODO: do not turn this into async. Use promises
  shimmer.wrap(seleniumPackage.WebDriver.prototype, 'get', get => async function () {
    if (!ciSeleniumDriverGetStartCh.hasSubscribers) {
      return get.apply(this, arguments)
    }
    let traceId
    const setTraceId = (inputTraceId) => {
      traceId = inputTraceId
    }
    const getResult = await get.apply(this, arguments)

    const isRumActive = await this.executeScript(IS_RUM_ACTIVE_SCRIPT)
    const capabilities = await this.getCapabilities()

    ciSeleniumDriverGetStartCh.publish({
      setTraceId,
      seleniumVersion,
      browserName: capabilities.getBrowserName(),
      browserVersion: capabilities.getBrowserVersion(),
      isRumActive
    })

    if (traceId && isRumActive) {
      await this.manage().addCookie({
        name: DD_CIVISIBILITY_TEST_EXECUTION_ID_COOKIE_NAME,
        value: traceId
      })
    }

    return getResult
  })

  shimmer.wrap(seleniumPackage.WebDriver.prototype, 'quit', quit => async function () {
    if (!ciSeleniumDriverGetStartCh.hasSubscribers) {
      return quit.apply(this, arguments)
    }
    const isRumActive = await this.executeScript(RUM_STOP_SESSION_SCRIPT)

    if (isRumActive) {
      // We'll have time for RUM to flush the events (there's no callback to know when it's done)
      await new Promise(resolve => {
        setTimeout(() => {
          resolve()
        }, DD_CIVISIBILITY_RUM_FLUSH_WAIT_MILLIS)
      })
      await this.manage().deleteCookie(DD_CIVISIBILITY_TEST_EXECUTION_ID_COOKIE_NAME)
    }

    return quit.apply(this, arguments)
  })

  return seleniumPackage
})
