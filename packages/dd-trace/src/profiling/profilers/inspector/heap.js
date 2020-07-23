'use strict'

const { Profile } = require('../../profile')

class InspectorHeapProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._samplingInterval = options.samplingInterval || 512 * 1024
  }

  start ({ mapper }) {
    const { Session } = require('inspector')

    this._mapper = mapper

    this._session = new Session()
    this._session.connect()
    this._session.post('HeapProfiler.enable')
    this._session.post('HeapProfiler.startSampling', {
      samplingInterval: this._samplingInterval
    })
  }

  stop () {
    this._session.post('HeapProfiler.stopSampling')
    this._session.post('HeapProfiler.disable')
    this._session.disconnect()
    this._session = null

    this._mapper = null
  }

  profile () {
    let profile

    this._session.post('HeapProfiler.getSamplingProfile', (err, params) => {
      if (err) throw err
      profile = params.profile
    })

    return this._serialize(profile)
  }

  async _serialize ({ head, samples }) {
    const sampleType = [['space', 'bytes']]
    const periodType = ['space', 'bytes']
    const period = this._samplingInterval
    const profile = new Profile(sampleType, periodType, period)
    const nodes = head.children.slice() // pprof has implicit root so skip root

    let node

    while ((node = nodes.shift())) {
      const { id, selfSize, callFrame, children } = node
      const { functionName, url, lineNumber } = await this._mapper.getSource(callFrame)
      const functionId = profile.addFunction(functionName, url).id
      const locationId = profile.addLocation(functionId, id, lineNumber).id

      if (children) {
        for (const child of children) {
          nodes.push(child)
          profile.addLink(locationId, child.id)
        }
      }

      if (selfSize) {
        profile.addSample(locationId, [selfSize])
      }
    }

    return profile.export()
  }
}

module.exports = { InspectorHeapProfiler }
