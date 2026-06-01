const loadedFixture = require('./fixture.ts')

describe('transform config identity repro', () => {
  it('runs with coverage', () => {
    expect(loadedFixture()).toBe('ok')
  })
})
