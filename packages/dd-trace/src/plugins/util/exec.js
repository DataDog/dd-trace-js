const cp = require('child_process')
const log = require('../../log')
const { distributionMetric, incrementCountMetric } = require('../../ci-visibility/telemetry')

const sanitizedExec = (
  cmd,
  flags,
  operationMetric,
  durationMetric,
  errorMetric
) => {
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
  }
}

module.exports = { sanitizedExec }
