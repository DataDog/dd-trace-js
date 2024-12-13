module.exports = class NoopDogStatsDClient {
  increment () { }

  gauge () { }

  distribution () { }

  histogram () { }

  flush () { }
}
