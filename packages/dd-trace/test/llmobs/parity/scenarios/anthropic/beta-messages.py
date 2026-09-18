import os

from anthropic import Anthropic

from common import finish, start


start("anthropic")
client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], base_url=os.environ["PROVIDER_BASE_URL"])
client.beta.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=16,
    messages=[{"role": "user", "content": "Hello from the beta parity harness."}],
)
finish()
