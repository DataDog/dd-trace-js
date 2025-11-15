'use strict'

const inspector = require('./inspector_promises_polyfill')

/**
 * @typedef {import('node:events').EventEmitter & {
 *   connect: () => void,
 *   connectToMainThread: () => void
 *   disconnect: () => void,
 *   post: (method: string, params?: object) => Promise<any>,
 * }} CDPSession
 */
const session = /** @type {CDPSession} */ (new inspector.Session())

session.connectToMainThread()

module.exports = session
