import os

from openai import OpenAI

from common import finish, start


start("openai")
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1')
client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello from the parity harness."}],
    temperature=0,
    max_tokens=16,
)
finish()
