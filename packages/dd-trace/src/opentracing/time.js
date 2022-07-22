const now = require('performance-now')
const dateNow = Date.now

let originalPerformanceNow, originalProcessHrTime

if (performance) {
  originalPerformanceNow = performance.now
} else if (process.hrtime) {
  originalProcessHrTime = process.hrtime
}

module.exports = {
  dateNow,
  now: function () {
    let currentPerformanceNow, currentProcessHrTime

    if (performance) {
      currentPerformanceNow = performance.now
      performance.now = originalPerformanceNow
    } else if (process.hrtime) {
      currentProcessHrTime = process.hrtime
      process.hrtime = originalProcessHrTime
    }

    const result = now()

    if (performance) {
      performance.now = currentPerformanceNow
    } else if (process.hrtime) {
      process.hrtime = currentProcessHrTime
    }
    return result
  }
}
