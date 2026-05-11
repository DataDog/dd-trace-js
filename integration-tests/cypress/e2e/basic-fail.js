/* eslint-disable */
describe('basic fail suite', () => {
  beforeEach(() => {
    cy.visitTestPage()
    cy.task('dd:addTags', { addTagsBeforeEach: 'customBeforeEach' })
  })

  afterEach(() => {
    cy.task('dd:addTags', { addTagsAfterEach: 'customAfterEach' })
  })

  it('can fail', () => {
    cy.task('dd:addTags', { customTag: 'customValue' })
    cy.get('.hello-world')
      .should('have.text', 'Hello warld')
    cy.task('dd:addTags', { addTagsAfterFailure: 'customAfterFailure' })
  })
})

