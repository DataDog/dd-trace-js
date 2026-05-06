describe('efd duration retries', () => {
  it('instant test', () => {
    expect(1 + 1).to.equal(2)
  })

  it('slightly slow test', () => {
    cy.wait(5100)
    expect(1 + 1).to.equal(2)
  })
})
