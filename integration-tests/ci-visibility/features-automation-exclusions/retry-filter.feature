Feature: Excluded scenarios preserve native retry tag filters
  @datadog:no_auto_retry @retryable
  Scenario: matching retry filter
    Given an excluded failure

  @datadog:no_auto_retry
  Scenario: excluded by retry filter
    Given an excluded failure
