Feature: Test automation exclusions
  @datadog_prevent_failure_suppression @datadog_no_auto_retry
  Scenario Outline: combined <row>
    Given an excluded failure
    Examples:
      | row |
      | one |
      | two |

  @datadog_no_auto_retry
  Scenario: quarantined exclusion
    Given an excluded failure

  # Keep coverage for the released colon spelling.
  @datadog:no_auto_retry
  Scenario: disabled exclusion
    Given an excluded failure

  # Keep coverage for the released colon spelling.
  @datadog:prevent_failure_suppression
  Scenario: protected retries
    Given an excluded failure

  @datadog_prevent_failure_suppression @datadog:no_auto_retry
  Scenario: protected passing
    Given an excluded pass

  Scenario: ordinary control
    Given an excluded failure
