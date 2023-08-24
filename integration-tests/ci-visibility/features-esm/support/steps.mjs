import assert from 'assert'
import { When, Then, Before } from '@cucumber/cucumber'

class Greeter {
  sayFarewell () {
    return 'farewell'
  }
  sayGreetings () {
    return 'greetings'
  }
  sayYo () {
    return 'yo'
  }
  sayYeah () {
    return 'yeah whatever'
  }
}

Before('@skip', function () {
  return 'skipped'
})

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says farewell', function () {
  this.whatIHeard = new Greeter().sayFarewell()
})

When('the greeter says yo', function () {
  this.whatIHeard = new Greeter().sayYo()
})

When('the greeter says yeah', function () {
  this.whatIHeard = new Greeter().sayYeah()
})

When('the greeter says greetings', function () {
  this.whatIHeard = new Greeter().sayGreetings()
})
