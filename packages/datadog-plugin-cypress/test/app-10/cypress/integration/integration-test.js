/* eslint-disable */
context('can visit a page', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.task('dd:addTags', { addTagsBeforeEach: 'custom' })
  })
  afterEach(() => {
    cy.task('dd:addTags', { addTagsAfterEach: 'custom' })
  })
  it('renders a hello world', () => {
    cy.task('dd:addTags', { addTags: 'custom' })
    cy.get('.hello-world')
      .should('have.text', 'Hello World')
  })
  it('will fail', () => {
    cy.task('dd:addTags', { addTags: 'custom' })
    cy.get('.hello-world')
      .should('have.text', 'Bye World')
    cy.task('dd:addTags', { addTagsAfterFailure: 'custom' })
  })
})
