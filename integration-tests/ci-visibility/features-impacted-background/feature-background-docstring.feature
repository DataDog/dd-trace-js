Feature: Impacted Feature Background DocString
  Background: The greeter has spoken
    When the greeter says impacted test with an argument
      """
      original content
      """

  Scenario: Top-level scenario
    Then I should have heard "impacted test"

  Rule: The greeting is repeated
    Scenario: Scenario inside a rule
      Then I should have heard "impacted test"
