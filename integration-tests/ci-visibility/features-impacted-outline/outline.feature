Feature: Modified outline examples
  Scenario Outline: Shared scenario name
    When the outline example <outcome> runs

    Examples:
      | outcome |
      | pass    |
      | fail    |
      | skip    |
