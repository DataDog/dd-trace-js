'use strict'

/* global cy */
afterEach(() => cy.task('dd:addTags', { 'manual.early_teardown': 'preserved' }))
require('./support-indirect-helper')
