'use strict'

const OperatorType = {
  MATCHES: 'MATCHES',
  NOT_MATCHES: 'NOT_MATCHES',
  GTE: 'GTE',
  GT: 'GT',
  LTE: 'LTE',
  LT: 'LT',
  ONE_OF: 'ONE_OF',
  NOT_ONE_OF: 'NOT_ONE_OF',
  IS_NULL: 'IS_NULL',
}

/**
 * @typedef {Object} MatchesCondition
 * @property {string} operator - OperatorType.MATCHES
 * @property {string} attribute
 * @property {string} value
 */

/**
 * @typedef {Object} NotMatchesCondition
 * @property {string} operator - OperatorType.NOT_MATCHES
 * @property {string} attribute
 * @property {string} value
 */

/**
 * @typedef {Object} OneOfCondition
 * @property {string} operator - OperatorType.ONE_OF
 * @property {string} attribute
 * @property {string[]} value
 */

/**
 * @typedef {Object} NotOneOfCondition
 * @property {string} operator - OperatorType.NOT_ONE_OF
 * @property {string} attribute
 * @property {string[]} value
 */

/**
 * @typedef {Object} NumericCondition
 * @property {string} operator - NumericOperator
 * @property {string} attribute
 * @property {number} value
 */

/**
 * @typedef {Object} NullCondition
 * @property {string} operator - OperatorType.IS_NULL
 * @property {string} attribute
 * @property {boolean} value
 */

/**
 * @typedef {MatchesCondition|NotMatchesCondition|OneOfCondition|NotOneOfCondition|NumericCondition|NullCondition} Condition
 */

/**
 * @typedef {Object} Rule
 * @property {Condition[]} conditions
 */

function matchesRule(rule, subjectAttributes) {
  const conditionEvaluations = evaluateRuleConditions(subjectAttributes, rule.conditions)
  // TODO: short-circuit return when false condition is found
  return !conditionEvaluations.includes(false)
}

function evaluateRuleConditions(subjectAttributes, conditions) {
  return conditions.map((condition) => evaluateCondition(subjectAttributes, condition))
}

function evaluateCondition(subjectAttributes, condition) {
  const value = subjectAttributes[condition.attribute]
  if (condition.operator === OperatorType.IS_NULL) {
    if (condition.value) {
      return value === null || value === undefined
    }
    return value !== null && value !== undefined
  }

  if (value !== null && value !== undefined) {
    switch (condition.operator) {
      case OperatorType.GTE:
      case OperatorType.GT:
      case OperatorType.LTE:
      case OperatorType.LT: {
        const comparator = (a, b) =>
          condition.operator === OperatorType.GTE
            ? a >= b
            : condition.operator === OperatorType.GT
              ? a > b
              : condition.operator === OperatorType.LTE
                ? a <= b
                : a < b
        return compareNumber(value, condition.value, comparator)
      }
      case OperatorType.MATCHES:
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return new RegExp(condition.value).test(String(value)) // dd-iac-scan ignore-line
      case OperatorType.NOT_MATCHES:
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return !new RegExp(condition.value).test(String(value)) // dd-iac-scan ignore-line
      case OperatorType.ONE_OF:
        return isOneOf(value.toString(), condition.value)
      case OperatorType.NOT_ONE_OF:
        return isNotOneOf(value.toString(), condition.value)
    }
  }
  return false
}

function isOneOf(attributeValue, conditionValues) {
  return conditionValues.includes(attributeValue)
}

function isNotOneOf(attributeValue, conditionValues) {
  return !isOneOf(attributeValue, conditionValues)
}

function compareNumber(attributeValue, conditionValue, compareFn) {
  return compareFn(Number(attributeValue), Number(conditionValue))
}

module.exports = {
  OperatorType,
  matchesRule
}