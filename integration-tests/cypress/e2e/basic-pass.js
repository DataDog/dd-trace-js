/* eslint-disable */
describe('basic pass suite', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.task('dd:addTags', { addTagsBeforeEach: 'customBeforeEach' })
  })

  afterEach(() => {
    cy.task('dd:addTags', { addTagsAfterEach: 'customAfterEach' })
  })

  it('can pass', () => {
    cy.task('dd:addTags', { customTag: 'customValue' })
    cy.get('.hello-world')
      .should('have.text', 'Hello World')
  })
})

