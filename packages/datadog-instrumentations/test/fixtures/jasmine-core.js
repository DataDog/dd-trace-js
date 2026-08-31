'use strict'

function Spec () {}

Spec.prototype.execute = function (queueRunnerFactory, onComplete) {
  queueRunnerFactory(onComplete)
}

Spec.prototype.status = function () {
  return 'passed'
}

function createModernJasmine () {
  class Spec {
    executionFinished () {
      this.result.status = 'passed'
    }
  }

  class TreeRunner {
    _executeSpec (spec, onComplete) {
      spec.executionFinished()
      onComplete()
    }
  }

  return { Spec, TreeRunner }
}

module.exports = { createModernJasmine, Spec }
