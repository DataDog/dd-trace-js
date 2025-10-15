'use strict'

let retryCounter = 0

describe('test', () => {
  it('can do multiple snapshots', () => {
    expect('hello').toMatchSnapshot()

    expect('good bye').toMatchSnapshot()
  })

  it('can do multiple snapshots in a different test', () => {
    expect(1 + 2).toMatchSnapshot()

    expect(1 + 3).toMatchSnapshot()
  })

  it('is not new', () => {
    expect('yes').toMatchSnapshot()
    expect('no').toMatchSnapshot()
  })

  it('has inline snapshot', () => {
    expect('yes').toMatchInlineSnapshot('"yes"')
    expect('no').toMatchInlineSnapshot('"no"')
  })

  it('has snapshot and is known', () => {
    expect('yes').toMatchInlineSnapshot('"yes"')
    expect('no').toMatchInlineSnapshot('"no"')
  })

  it('is flaky', () => {
    retryCounter++
    const sum = retryCounter > 2 ? 3 : 4
    if (retryCounter > 2) {
      expect(sum).toMatchSnapshot()
    } else {
      expect(sum).toMatchSnapshot()
    }
    expect('a').toMatchSnapshot()
  })
})
