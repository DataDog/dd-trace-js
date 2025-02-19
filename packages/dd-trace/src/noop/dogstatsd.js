module.exports = class NoopDogStatsDClient {
  increment () { }

  decrement () { }

  gauge () { }

  distribution () { }

  histogram () { }

  flush () { }
}
