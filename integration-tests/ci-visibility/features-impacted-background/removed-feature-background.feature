Feature: Removed Feature Background
  Background: The greeter has spoken
    When the greeter says impacted test

  Scenario: Top-level scenario
    When the greeter says impacted test
    Then I should have heard "impacted test"

  Rule: The greeting is repeated
    Scenario: Scenario inside a rule
      When the greeter says impacted test
      Then I should have heard "impacted test"
