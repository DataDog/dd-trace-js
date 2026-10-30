Feature: Test automation exclusions
  @datadog:prevent_failure_suppression @datadog:no_auto_retry
  Scenario Outline: combined <row>
    Given an excluded failure
    Examples:
      | row |
      | one |
      | two |

  @datadog:no_auto_retry
  Scenario: quarantined exclusion
    Given an excluded failure

  @datadog:no_auto_retry
  Scenario: disabled exclusion
    Given an excluded failure

  @datadog:prevent_failure_suppression
  Scenario: protected retries
    Given an excluded failure

  @datadog:prevent_failure_suppression @datadog:no_auto_retry
  Scenario: protected passing
    Given an excluded pass

  Scenario: ordinary control
    Given an excluded failure
