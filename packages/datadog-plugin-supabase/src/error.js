'use strict'

/**
 * @param {Error | { message?: string } | string | null | undefined} error Supabase operation error.
 * @param {string} type Error type used for non-Error SDK results.
 * @param {string} [message] Error message used for non-Error SDK results.
 * @returns {Error | undefined}
 */
function normalizeError (error, type, message) {
  if (!error) return
  if (error instanceof Error) return error

  const normalizedError = new Error(message || error?.message || String(error))
  normalizedError.name = type
  return normalizedError
}

module.exports = normalizeError
