import os

from openai import OpenAI

from common import finish, start


start("openai")
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1')
stream = client.responses.create(
    model="gpt-4o-mini",
    input="Say parity",
    stream=True,
)
for event in stream:
    del event
finish()
