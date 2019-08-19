'use strict'

const crypto = window.crypto

module.exports = (size) => {
  const buffer = new Uint8Array(size)

  crypto.getRandomValues(buffer)

  return buffer.map(byte => byte.toString(16)).join('')
}
