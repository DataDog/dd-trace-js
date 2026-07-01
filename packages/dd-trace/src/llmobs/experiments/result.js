'use strict'

// One row of an experiment run.
class Row {
  constructor (fields) {
    this.index = fields.index
    this.spanId = fields.spanId
    this.traceId = fields.traceId
    this.startNs = fields.startNs
    this.durationNs = fields.durationNs
    this.input = fields.input
    this.output = fields.output
    this.expectedOutput = fields.expectedOutput
    this.errorType = fields.errorType
    this.errorMessage = fields.errorMessage
    this.evaluations = fields.evaluations
    this.evaluationErrors = fields.evaluationErrors
  }

  get isError () {
    return this.errorType !== null
  }
}

// Returned by Experiment.run().
class ExperimentResult {
  constructor (experimentId, rows, url) {
    this.experimentId = experimentId
    this.rows = rows
    this.url = url
  }
}

module.exports = { Row, ExperimentResult }
