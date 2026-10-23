import os

from ddtrace import patch
from ddtrace.llmobs import LLMObs


def start(integration):
    patch(**{integration: True})
    LLMObs.enable(agentless_enabled=False)


def finish():
    LLMObs.flush()
