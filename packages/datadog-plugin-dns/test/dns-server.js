'use strict'

const dgram = require('node:dgram')
const { once } = require('node:events')

const A = 1
const PTR = 12
const ANY = 255
const IN = 1
const RESPONSE_FLAGS = 0x8180
const NXDOMAIN_FLAGS = 0x8183

/**
 * @returns {Promise<{ address: string, close: () => Promise<void> }>}
 */
async function startDnsServer () {
  const socket = dgram.createSocket('udp4')
  socket.on('message', (message, remote) => {
    const response = createResponse(message)
    if (response !== undefined) {
      socket.send(response, remote.port, remote.address)
    }
  })
  socket.bind(0, '127.0.0.1')
  await once(socket, 'listening')

  const { port } = socket.address()
  return {
    address: `127.0.0.1:${port}`,
    close: () => new Promise(resolve => socket.close(resolve)),
  }
}

/**
 * @param {Buffer} request
 * @returns {Buffer|undefined}
 */
function createResponse (request) {
  const question = readQuestion(request)
  if (question === undefined) return

  const answer = getAnswer(question.name, question.type)
  const questionLength = question.end - 12
  const answerLength = answer === undefined ? 0 : 12 + answer.data.length
  const response = Buffer.alloc(12 + questionLength + answerLength)

  response.writeUInt16BE(request.readUInt16BE(0), 0)
  response.writeUInt16BE(answer === undefined ? NXDOMAIN_FLAGS : RESPONSE_FLAGS, 2)
  response.writeUInt16BE(1, 4)
  response.writeUInt16BE(answer === undefined ? 0 : 1, 6)
  request.copy(response, 12, 12, question.end)

  if (answer !== undefined) {
    const offset = 12 + questionLength
    response.writeUInt16BE(0xc00c, offset)
    response.writeUInt16BE(answer.type, offset + 2)
    response.writeUInt16BE(IN, offset + 4)
    response.writeUInt32BE(0, offset + 6)
    response.writeUInt16BE(answer.data.length, offset + 10)
    answer.data.copy(response, offset + 12)
  }

  return response
}

/**
 * @param {Buffer} request
 * @returns {{ name: string, type: number, end: number }|undefined}
 */
function readQuestion (request) {
  if (request.length < 17 || request.readUInt16BE(4) !== 1) return

  const labels = []
  let offset = 12
  while (offset < request.length) {
    const length = request[offset++]
    if (length === 0) break
    if ((length & 0xc0) !== 0 || offset + length > request.length) return
    labels.push(request.toString('ascii', offset, offset + length))
    offset += length
  }
  if (offset + 4 > request.length) return

  return {
    name: labels.join('.'),
    type: request.readUInt16BE(offset),
    end: offset + 4,
  }
}

/**
 * @param {string} name
 * @param {number} type
 * @returns {{ type: number, data: Buffer }|undefined}
 */
function getAnswer (name, type) {
  if (name === 'trace.test' && (type === A || type === ANY)) {
    return { type: A, data: Buffer.from([127, 0, 0, 1]) }
  }
  if (name === '1.0.0.127.in-addr.arpa' && type === PTR) {
    return { type: PTR, data: encodeName('localhost') }
  }
}

/**
 * @param {string} name
 * @returns {Buffer}
 */
function encodeName (name) {
  const labels = name.split('.')
  let length = 1
  for (const label of labels) {
    length += 1 + Buffer.byteLength(label)
  }

  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  for (const label of labels) {
    const labelLength = buffer.write(label, offset + 1, 'ascii')
    buffer[offset] = labelLength
    offset += labelLength + 1
  }
  buffer[offset] = 0
  return buffer
}

module.exports = { startDnsServer }
