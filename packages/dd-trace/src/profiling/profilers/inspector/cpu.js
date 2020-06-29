'use strict'

const inspector = require('inspector')
const { Profile } = require('../../profile')

const session = new inspector.Session()

class InspectorCpuProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingInterval = options.samplingInterval || 10 * 1000
  }

  start ({ mapper }) {
    this._mapper = mapper

    if (process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier()
    }

    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.setSamplingInterval', {
      interval: this._samplingInterval
    })
    session.post('Profiler.start')
  }

  stop () {
    session.post('Profiler.stop')
    session.post('Profiler.disable')
    session.disconnect()

    this._mapper = null
  }

  profile () {
    let profile

    session.post('Profiler.stop', (err, params) => {
      if (err) throw err
      profile = params.profile
    })

    session.post('Profiler.start')

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
      const { functionName, url, lineNumber } = await this._mapper.getSource(callFrame)
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
