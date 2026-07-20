/* eslint-disable */
import React from 'react'

function ValidationButton () {
  return <button type="button">component instrumentation works</button>
}

describe('component instrumentation suite', () => {
  it('renders', () => {
    cy.mount(<ValidationButton />)
    cy.contains('button', 'component instrumentation works').should('be.visible')
  })
})
