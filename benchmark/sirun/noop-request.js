'use strict'

const requestPath = require.resolve('../../packages/dd-trace/src/exporters/common/request')

/**
 * @param {Buffer|string|import('node:stream').Readable|Array<Buffer|string>} data
 * @param {object} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
 */
function noopRequest (data, options, callback) {
  callback(null, '{"rate_by_service":{}}', 200)
}

Object.defineProperty(noopRequest, 'writable', { value: true })

require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: noopRequest,
}
