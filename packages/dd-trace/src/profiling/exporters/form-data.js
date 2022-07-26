'use strict'

const { Readable } = require('stream')
const id = require('../../id')

class FormData extends Readable {
  constructor () {
    super()

    this._boundary = id().toString()
    this._data = []
  }

  append (key, value, options = {}) {
    this._appendBoundary()

    if (options.filename) {
      this._appendFile(key, value, options)
    } else {
      this._appendMetadata(key, value, options)
    }
  }

  getHeaders () {
    return { 'Content-Type': 'multipart/form-data; boundary=' + this._boundary }
  }

  _appendBoundary () {
    this._data.push(`--${this._boundary}\r\n`)
  }

  _appendMetadata (key, value) {
    this._data.push(`Content-Disposition: form-data; name="${key}" \r\n\r\n${value}\r\n`)
  }

  _appendFile (key, value, { filename, contentType = 'application/octet-stream' }) {
    this._data.push(`Content-Disposition: form-data; name="${key}"; filename="${filename}"\r\n`)
    this._data.push(`Content-Type: ${contentType}\r\n\r\n`)
    this._data.push(value)
    this._data.push('\r\n')
  }

  _read () {
    this.push(this._data.shift())

    if (this._data.length === 0) {
      this.push(`--${this._boundary}--\r\n`)
      this.push(null)
    }
  }
}

module.exports = FormData
