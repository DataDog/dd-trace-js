
Feature: Greeting

  Scenario: Say hello after multiple retries
    When the greeter says hello
    Then I should eventually have heard "hello"
