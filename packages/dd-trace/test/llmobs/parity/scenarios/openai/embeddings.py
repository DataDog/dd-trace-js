import os

from openai import OpenAI

from common import finish, start


start("openai")
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1')
client.embeddings.create(model="text-embedding-3-small", input="Parity embedding.", encoding_format="float")
finish()
