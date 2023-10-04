@datadog:unskippable
Feature: Greetings
  Scenario: Say greetings
    When the greeter says greetings
    Then I should have heard "greetings"

  Scenario: Say yeah
    When the greeter says yeah
    Then I should have heard "yeah"

  Scenario: Say yo
    When the greeter says yo
    Then I should have heard "yo"

  @skip
  Scenario: Say skip
    When the greeter says yo
    Then I should have heard "yo"
