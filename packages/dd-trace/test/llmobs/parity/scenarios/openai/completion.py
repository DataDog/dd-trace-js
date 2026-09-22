import os

from openai import OpenAI

from common import finish, start


start("openai")
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1')
client.completions.create(
    model="gpt-3.5-turbo-instruct",
    prompt="Say parity",
    max_tokens=8,
    temperature=0,
)
finish()
