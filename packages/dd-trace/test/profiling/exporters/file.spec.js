'use strict'

require('../../setup/core')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('exporters/file', () => {
  let FileExporter
  let fs

  beforeEach(() => {
    fs = {
      writeFile: sinon.stub().yields()
    }

    FileExporter = proxyquire('../../../src/profiling/exporters/file', {
      fs
    }).FileExporter
  })

  it('should export to a file per profile type', async () => {
    const exporter = new FileExporter()
    const buffer = Buffer.from('profile')
    const profiles = {
      test: buffer
    }

    await exporter.export({ profiles })

    sinon.assert.calledOnce(fs.writeFile)
    sinon.assert.calledWith(fs.writeFile, 'test.pb.gz', buffer)
  })
})
