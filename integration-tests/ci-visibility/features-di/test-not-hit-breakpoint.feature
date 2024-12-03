
Feature: Greeting

  Scenario: Say hello
    When the greeter says hello
    Then I should have flakily heard "hello"
