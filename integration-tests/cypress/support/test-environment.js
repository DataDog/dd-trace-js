'use strict'

/* global Cypress */
const useExpose = Number(Cypress.version.split('.')[0]) >= 16

/**
 * @param {string} name Environment variable name
 * @returns {unknown} Environment variable value
 */
function getTestEnvironment (name) {
  return useExpose ? Cypress.expose(name) : Cypress.env(name)
}

/**
 * @param {string} name Environment variable name
 * @param {unknown} value Environment variable value
 */
function setTestEnvironment (name, value) {
  if (useExpose) {
    Cypress.expose(name, value)
  } else {
    Cypress.env(name, value)
  }
}

module.exports = { getTestEnvironment, setTestEnvironment }
