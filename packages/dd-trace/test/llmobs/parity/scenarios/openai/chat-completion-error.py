import os

from openai import OpenAI

from common import finish, start


start("openai")
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1',
    max_retries=0,
)
try:
    client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Say parity"}],
        max_tokens=8,
    )
except Exception:
    pass
finish()
