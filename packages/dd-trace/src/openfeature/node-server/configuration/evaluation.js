'use strict'

const {
  ErrorCode,
  StandardResolutionReasons,
} = require('@openfeature/server-sdk')
const { evaluateForSubject } = require('./evaluateForSubject')

function evaluate(config, type, flagKey, defaultValue, context, logger) {
  if (!config) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: ErrorCode.PROVIDER_NOT_READY,
    }
  }

  const { targetingKey: subjectKey, ...remainingContext } = context
  if (!subjectKey) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: ErrorCode.TARGETING_KEY_MISSING,
    }
  }

  // Include the subjectKey as an "id" attribute for rule matching
  const subjectAttributes = {
    id: subjectKey,
    ...remainingContext,
  }
  try {
    const resultWithDetails = evaluateForSubject(
      config.flags[flagKey],
      type,
      subjectKey,
      subjectAttributes,
      defaultValue,
      logger
    )
    return resultWithDetails
  } catch (error) {
    logger.error('Error evaluating flag', { error })
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
    }
  }
}

module.exports = {
  evaluate
}