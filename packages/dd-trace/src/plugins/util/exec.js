const cp = require('child_process')
const log = require('../../log')
const { distributionMetric, incrementCountMetric } = require('../../ci-visibility/telemetry')
const { storage } = require('../../../../datadog-core')

const sanitizedExec = (
  cmd,
  flags,
  operationMetric,
  durationMetric,
  errorMetric
) => {
  const store = storage.getStore()
  storage.enterWith({ noop: true })

  let startTime
  if (operationMetric) {
    incrementCountMetric(operationMetric.name, operationMetric.tags)
  }
  if (durationMetric) {
    startTime = Date.now()
  }
  try {
    const result = cp.execFileSync(cmd, flags, { stdio: 'pipe' }).toString().replace(/(\r\n|\n|\r)/gm, '')
    if (durationMetric) {
      distributionMetric(durationMetric.name, durationMetric.tags, Date.now() - startTime)
    }
    return result
  } catch (e) {
    if (errorMetric) {
      incrementCountMetric(errorMetric.name, { ...errorMetric.tags, exitCode: e.status })
    }
    log.error(e)
    return ''
  } finally {
    storage.enterWith(store)
  }
}

module.exports = { sanitizedExec }
