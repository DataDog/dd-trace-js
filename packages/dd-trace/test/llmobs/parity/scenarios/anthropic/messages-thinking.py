import os

from anthropic import Anthropic

from common import finish, start


start("anthropic")
client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], base_url=os.environ["PROVIDER_BASE_URL"])
client.messages.create(
    model="claude-3-7-sonnet-20250219",
    max_tokens=32,
    thinking={"type": "enabled", "budget_tokens": 1024},
    messages=[{"role": "user", "content": "Say parity."}],
)
finish()
