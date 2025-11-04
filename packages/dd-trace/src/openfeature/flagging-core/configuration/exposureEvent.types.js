'use strict'

/**
 * @typedef {Object} ExposureEvent
 * @property {Object} allocation
 * @property {string} allocation.key
 * @property {Object} flag
 * @property {string} flag.key
 * @property {Object} variant
 * @property {string} variant.key
 * @property {Object} subject
 * @property {string} subject.id
 * @property {Object} subject.attributes - EvaluationContext
 */

/**
 * @typedef {ExposureEvent} ExposureEventWithTimestamp
 * @property {number} timestamp - Unix timestamp in milliseconds
 */

// No exports needed - these are just JSDoc type definitions
module.exports = {}