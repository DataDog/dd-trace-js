
Feature: Greeting with fake timers

  Scenario: Say hello with fake timers
    When the greeter says hello
    Then I should have heard "hello"
