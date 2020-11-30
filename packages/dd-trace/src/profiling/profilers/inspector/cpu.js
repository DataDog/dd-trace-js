'use strict'

const { Profile } = require('../../profile')

class InspectorCpuProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingInterval = options.samplingInterval || 10 * 1000
  }

  start ({ mapper }) {
    const { Session } = require('inspector')

    this._mapper = mapper

    this._session = new Session()
    this._session.connect()
    this._session.post('Profiler.enable')
    this._session.post('Profiler.setSamplingInterval', {
      interval: this._samplingInterval
    })
    this._session.post('Profiler.start')
  }

  stop () {
    this._session.post('Profiler.stop')
    this._session.post('Profiler.disable')
    this._session.disconnect()
    this._session = null

    this._mapper = null
  }

  profile (callback) {
    this._session.post('Profiler.stop', (err, params) => {
      if (err) return callback(err)

      this._session.post('Profiler.start')

      this._serialize(params.profile, callback)
    })
  }

  _serialize ({ startTime, endTime, nodes, samples, timeDeltas }, callback) {
    const sampleType = [['sample', 'count'], ['wall', 'microseconds']]
    const periodType = ['wall', 'microseconds']
    const period = this._samplingInterval
    const profile = new Profile(sampleType, periodType, period)
    const skippedLocationIds = new Set()

    profile.addDuration((endTime - startTime) * 1000)

    for (const node of nodes) {
      // pprof has implicit root so skip root
      if (node.callFrame.functionName === '(root)') continue

      const { id, children, callFrame } = node
      const { functionName, url, lineNumber } = callFrame // TODO: support source maps
      const functionId = profile.addFunction(functionName, url).id
      const locationId = profile.addLocation(functionId, id, lineNumber).id

      // skip redundant samples that are handled by pprof and/or the backend
      if (functionName === '(program)' || functionName === '(idle)') {
        skippedLocationIds.add(locationId)
      }

      if (children) {
        for (const childId of children) {
          profile.addLink(locationId, childId)
        }
      }
    }

    for (let i = 0; i < samples.length; i++) {
      if (skippedLocationIds.has(samples[i])) continue

      profile.addSample(samples[i], [1, timeDeltas[i]])
    }

    callback(null, profile.export())
  }
}

module.exports = { InspectorCpuProfiler }
