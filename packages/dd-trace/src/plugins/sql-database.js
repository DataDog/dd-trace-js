'use strict'

const { storage } = require('../../../datadog-core')

const DatabasePlugin = require('./database')

const TRANSACTION_BEGIN = 1
const TRANSACTION_COMMIT = 2
const TRANSACTION_ROLLBACK = 4
const BEGIN_RE = /BEGIN(?:[ \t\r\n\v\f]+(?:WORK|TRANSACTION))?/iy
const BEGIN_WORK_RE = /BEGIN(?:[ \t\r\n\v\f]+WORK)?/iy
const START_RE = /START[ \t\r\n\v\f]+TRANSACTION/iy
const COMMIT_RE = /COMMIT(?:[ \t\r\n\v\f]+(?:WORK|TRANSACTION))?/iy
const COMMIT_WORK_RE = /COMMIT(?:[ \t\r\n\v\f]+WORK)?/iy
const ROLLBACK_RE = /ROLLBACK(?:[ \t\r\n\v\f]+(?:WORK|TRANSACTION))?/iy
const ROLLBACK_WORK_RE = /ROLLBACK(?:[ \t\r\n\v\f]+WORK)?/iy

/**
 * @typedef {{ parentStore?: object, currentStore?: object, ignoredTransactionOperation?: boolean }} TransactionContext
 */

class SQLDatabasePlugin extends DatabasePlugin {
  #ignoredTransactionMask = 0

  /**
   * @override
   * @param {boolean | import('../config/config-base') & {enabled: boolean}} config
   */
  configure (config) {
    super.configure(config)
    const operations = this.config.ignoredTransactionOperations
    let mask = 0
    if (Array.isArray(operations)) {
      for (const operation of operations) {
        if (typeof operation !== 'string') continue
        switch (operation.toLowerCase()) {
          case 'begin': mask |= TRANSACTION_BEGIN; break
          case 'commit': mask |= TRANSACTION_COMMIT; break
          case 'rollback': mask |= TRANSACTION_ROLLBACK; break
        }
      }
    }
    this.#ignoredTransactionMask = mask
  }

  /**
   * @param {unknown} query
   */
  shouldIgnoreTransaction (query) {
    if (this.#ignoredTransactionMask === 0 || typeof query !== 'string') return false

    const postgres = this.system === 'postgres'
    const start = skipTrivia(query, 0, postgres)
    if (start < 0) return false

    const first = query.charCodeAt(start) | 32
    let pattern
    if (first === 98 && (this.#ignoredTransactionMask & TRANSACTION_BEGIN)) {
      pattern = postgres ? BEGIN_RE : BEGIN_WORK_RE
    } else if (first === 115 && (this.#ignoredTransactionMask & TRANSACTION_BEGIN) &&
      (query.charCodeAt(start + 1) | 32) === 116) {
      pattern = START_RE
    } else if (first === 99 && (this.#ignoredTransactionMask & TRANSACTION_COMMIT)) {
      pattern = postgres ? COMMIT_RE : COMMIT_WORK_RE
    } else if (first === 114 && (this.#ignoredTransactionMask & TRANSACTION_ROLLBACK)) {
      pattern = postgres ? ROLLBACK_RE : ROLLBACK_WORK_RE
    } else {
      return false
    }

    pattern.lastIndex = start
    if (!pattern.test(query)) return false
    let end = skipTrivia(query, pattern.lastIndex, postgres)
    if (end < 0) return false
    if (query.charCodeAt(end) === 59) end = skipTrivia(query, end + 1, postgres)
    return end === query.length
  }

  /**
   * @param {unknown} ctx
   */
  skipTransaction (ctx) {
    const context = /** @type {TransactionContext} */ (ctx)
    context.ignoredTransactionOperation = true
    context.parentStore = storage('legacy').getStore()
    context.currentStore = context.parentStore
    return context.parentStore
  }

  /**
   * @param {unknown} ctx
   */
  finish (ctx) {
    const context = /** @type {TransactionContext & Parameters<DatabasePlugin['finish']>[0]} */ (ctx)
    if (context?.ignoredTransactionOperation) return
    super.finish(context)
  }

  /**
   * @param {unknown} ctx
   */
  error (ctx) {
    const context = /** @type {TransactionContext & Parameters<DatabasePlugin['error']>[0]} */ (ctx)
    if (context?.ignoredTransactionOperation) return
    super.error(context)
  }
}

/**
 * @param {string} query
 * @param {number} offset
 * @param {boolean} postgres
 */
function skipTrivia (query, offset, postgres) {
  while (offset < query.length) {
    const code = query.charCodeAt(offset)
    if (code === 32 || (code >= 9 && code <= 13)) {
      offset++
    } else if (code === 45 && query.charCodeAt(offset + 1) === 45 &&
      (postgres || query.charCodeAt(offset + 2) <= 32)) {
      offset += 2
      while (offset < query.length) {
        const next = query.charCodeAt(offset)
        if (next === 10 || (postgres && next === 13)) break
        offset++
      }
    } else if (!postgres && code === 35) {
      offset++
      while (offset < query.length && query.charCodeAt(offset) !== 10) offset++
    } else if (code === 47 && query.charCodeAt(offset + 1) === 42) {
      const marker = query.charCodeAt(offset + 2)
      if (!postgres && (marker === 33 || marker === 43 ||
        ((marker | 32) === 109 && query.charCodeAt(offset + 3) === 33))) return -1
      offset = skipBlockComment(query, offset + 2, postgres)
      if (offset < 0) return -1
    } else {
      break
    }
  }
  return offset
}

/**
 * @param {string} query
 * @param {number} offset
 * @param {boolean} postgres
 */
function skipBlockComment (query, offset, postgres) {
  let depth = 1
  while (offset < query.length && depth > 0) {
    const current = query.charCodeAt(offset)
    const next = query.charCodeAt(offset + 1)
    if (current === 47 && next === 42) {
      if (!postgres) return -1
      depth++
      offset += 2
    } else if (current === 42 && next === 47) {
      depth--
      offset += 2
    } else {
      offset++
    }
  }
  return depth === 0 ? offset : -1
}

module.exports = SQLDatabasePlugin
