const StatsD = require('./statsd')

let statsd

const benchOps = {
  start (name, iterations = 1) {
    const start = process.hrtime.bigint()
    if (!statsd) {
      statsd = new StatsD()
      process.on('beforeExit', () => statsd.flush())
    }
    return {
      end () {
        const end = process.hrtime.bigint()
        const duration = Number(end - start)
        const ops = iterations * 1e9 / duration
        statsd.gauge(name + '.ops', ops)
      }
    }
  }
}

exports.benchOps = benchOps
