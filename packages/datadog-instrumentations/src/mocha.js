if (process.env.MOCHA_WORKER_ID) {
  require('./mocha/worker')
} else {
  require('./mocha/main')
}
