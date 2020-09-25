'use strict'

const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('exporters/file', () => {
  let FileExporter
  let fs
  let encoder

  beforeEach(() => {
    fs = {
      writeFile: sinon.stub().yields()
    }

    encoder = {
      encode: sinon.stub()
    }

    FileExporter = proxyquire('../../../src/profiling/exporters/file', {
      fs,
      '../encoders/pprof': {
        Encoder: sinon.stub().returns(encoder)
      }
    }).FileExporter
  })

  it('should export to a file per profile type', done => {
    const exporter = new FileExporter()
    const profiles = {
      test: 'profile'
    }

    encoder.encode.withArgs('profile').yields(null, 'buffer')

    exporter.export({ profiles }, () => {
      sinon.assert.calledOnce(fs.writeFile)
      sinon.assert.calledWith(fs.writeFile, 'test.pb.gz', 'buffer')

      done()
    })
  })
})
