import os

from openai import OpenAI

from common import finish, start


start("openai")
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=f'{os.environ["PROVIDER_BASE_URL"]}/v1')
client.responses.create(
    model="gpt-4o-mini",
    input="What is the weather in NYC?",
    tools=[
        {
            "type": "function",
            "name": "get_weather",
            "description": "Get current weather.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        }
    ],
)
finish()
