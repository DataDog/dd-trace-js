'use strict'

const { Readable } = require('stream')
const id = require('../../id')

class FormData extends Readable {
  #boundary
  #data

  constructor () {
    super()

    this.#boundary = id().toString()
    this.#data = []
  }

  append (key, value, options = {}) {
    this._appendBoundary()

    if (options.filename) {
      this._appendFile(key, value, options)
    } else {
      this._appendMetadata(key, value, options)
    }
  }

  get _boundary () { return this.#boundary }
  get _data () {
    return this.#data
  }

  size () {
    return this.#data.reduce((size, chunk) => size + chunk.length, 0)
  }

  getHeaders () {
    return { 'Content-Type': 'multipart/form-data; boundary=' + this.#boundary }
  }

  _appendBoundary () {
    this.#data.push(`--${this.#boundary}\r\n`)
  }

  _appendMetadata (key, value) {
    this.#data.push(`Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
  }

  _appendFile (key, value, { filename, contentType = 'application/octet-stream' }) {
    this.#data.push(
      `Content-Disposition: form-data; name="${key}"; filename="${filename}"\r\n`,
      `Content-Type: ${contentType}\r\n\r\n`,
      value,
      '\r\n'
    )
  }

  _read () {
    this.push(this.#data.shift())

    if (this.#data.length === 0) {
      this.push(`--${this.#boundary}--\r\n`)
      this.push(null)
    }
  }
}

module.exports = FormData
