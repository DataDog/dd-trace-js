'use strict'

const inspector = require('inspector')
const { Profile } = require('../../profile')

const session = new inspector.Session()

class InspectorHeapProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._samplingInterval = options.samplingInterval || 512 * 1024
  }

  start ({ mapper }) {
    this._mapper = mapper

    session.connect()
    session.post('HeapProfiler.enable')
    session.post('HeapProfiler.startSampling', {
      samplingInterval: this._samplingInterval
    })
  }

  stop () {
    session.post('HeapProfiler.stopSampling')
    session.post('HeapProfiler.disable')
    session.disconnect()

    this._mapper = null
  }

  profile () {
    let profile

    session.post('HeapProfiler.getSamplingProfile', (err, params) => {
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
