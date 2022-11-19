'use strict'

require('../../setup/core')

const { expect } = require('chai')

const FormData = require('../../../src/exporters/common/form-data')

async function streamToString (stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString()
}

describe('exporters/form-data', () => {
  it('should have a valid boundary', () => {
    const form = new FormData()

    expect(form._boundary)
      .to.be.a('string')
      .and.not.be.empty
  })

  it('should get expected headers', () => {
    const form = new FormData()

    expect(form.getHeaders()).to.deep.equal({
      'Content-Type': 'multipart/form-data; boundary=' + form._boundary
    })
  })

  it('should encode key/value fields correctly', async () => {
    const form = new FormData()

    const key = 'foo'
    const value = 'bar'

    form.append(key, value)

    expect(await streamToString(form)).to.equal([
      `--${form._boundary}`,
      `Content-Disposition: form-data; name="${key}"`,
      '',
      value,
      `--${form._boundary}--`,
      ''
    ].join('\r\n'))
  })

  it('should encode files correctly', async () => {
    const form = new FormData()

    const key = 'foo'
    const file = Buffer.from('this is a file')
    const filename = 'file.txt'

    form.append(key, file, { filename })

    expect(await streamToString(form)).to.equal([
      `--${form._boundary}`,
      `Content-Disposition: form-data; name="${key}"; filename="${filename}"`,
      'Content-Type: application/octet-stream',
      '',
      file,
      `--${form._boundary}--`,
      ''
    ].join('\r\n'))
  })

  it('should encode multiple files and fields correctly', async () => {
    const form = new FormData()

    const fields = [
      { key: 'foo', value: 'bar' },
      { key: 'baz', value: 'buz' },
      { key: 'file', value: 'file', filename: 'file.txt' }
    ]

    for (const { key, value, filename } of fields) {
      form.append(key, value, { filename })
    }

    expect(await streamToString(form)).to.equal([
      `--${form._boundary}`,
      `Content-Disposition: form-data; name="${fields[0].key}"`,
      '',
      fields[0].value,
      `--${form._boundary}`,
      `Content-Disposition: form-data; name="${fields[1].key}"`,
      '',
      fields[1].value,
      `--${form._boundary}`,
      `Content-Disposition: form-data; name="${fields[2].key}"; filename="${fields[2].filename}"`,
      'Content-Type: application/octet-stream',
      '',
      fields[2].value,
      `--${form._boundary}--`,
      ''
    ].join('\r\n'))
  })
})
