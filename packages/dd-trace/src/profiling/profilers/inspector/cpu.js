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

  profile () {
    let profile

    this._session.post('Profiler.stop', (err, params) => {
      if (err) throw err
      profile = params.profile
    })

    this._session.post('Profiler.start')

    return this._serialize(profile)
  }

  async _serialize ({ startTime, endTime, nodes, samples, timeDeltas }) {
    const sampleType = [['sample', 'count'], ['wall', 'microseconds']]
    const periodType = ['wall', 'microseconds']
    const period = this._samplingInterval
    const profile = new Profile(sampleType, periodType, period)

    profile.addDuration((endTime - startTime) * 1000)

    for (const node of nodes) {
      // pprof has implicit root so skip root
      if (node.callFrame.functionName === '(root)') continue

      const { id, children, callFrame } = node
      const { functionName, url, lineNumber } = this._mapper ? await this._mapper.getSource(callFrame) : callFrame
      const functionId = profile.addFunction(functionName, url).id
      const locationId = profile.addLocation(functionId, id, lineNumber).id

      if (children) {
        for (const childId of children) {
          profile.addLink(locationId, childId)
        }
      }
    }

    for (let i = 0; i < samples.length; i++) {
      profile.addSample(samples[i], [1, timeDeltas[i]])
    }

    return profile.export()
  }
}

module.exports = { InspectorCpuProfiler }
