if (process.env.MOCHA_WORKER_ID) {
  require('./mocha/worker')
} else {
  require('./mocha/main')
}

// TODO add appropriate calls to wrapFunction whenever we're adding a callback
// wrapper. Right now this is less of an issue since that only has effect in
// SSI, where CI Vis isn't supported.
