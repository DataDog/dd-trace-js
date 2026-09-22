import os

from openai import AzureOpenAI

from common import finish, start


start("openai")
client = AzureOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    api_version="2024-02-01",
    azure_endpoint=f'{os.environ["PROVIDER_BASE_URL"]}/azure',
)
client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Say parity"}],
    max_tokens=8,
    temperature=0,
)
finish()
