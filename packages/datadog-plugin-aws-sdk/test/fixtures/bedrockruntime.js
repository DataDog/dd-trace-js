'use strict'

const bedrockruntime = {}

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  MISTRAL: 'MISTRAL'
}

const systemPrompt = 'Please respond with one sentence.'
const prompt = 'What is the capital of France?'
const temperature = 0.5
const maxTokens = 512

bedrockruntime.models = [
  {
    provider: PROVIDER.AMAZON,
    modelId: 'amazon.titan-text-lite-v1',
    userPrompt: prompt,
    requestBody: {
      inputText: prompt,
      textGenerationConfig: {
        temperature,
        maxTokenCount: maxTokens
      }
    },
    response: {
      inputTokens: 7,
      outputTokens: 98,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: '\nParis is the capital of France. France is a country in Western Europe, and Paris ' +
        'is its capital. Paris is one of the most populous cities in the European Union, ' +
        'with a population of more than 2 million people. It is also one of the most ' +
        'visited cities in the world, with millions of tourists visiting each year. ' +
        'Paris is known for its rich history, culture, and architecture, including ' +
        'the Eiffel Tower, Notre Dame Cathedral, and the Louvre Museum. '
    },
    streamedResponse: {
      inputTokens: 7,
      outputTokens: 78,
      text: '\nParis is the capital of France. Paris, the capital of France, is a city ' +
      'that has been a center of art, culture, and cuisine for centuries. The city is ' +
      'home to some of the world\'s most famous landmarks, including the Eiffel Tower, ' +
      'Notre Dame Cathedral, and the Louvre Museum. Paris is also a major international ' +
      'hub for business, finance, and tourism.'
    }
  },
  {
    provider: PROVIDER.AMAZON,
    modelId: 'amazon.nova-pro-v1:0',
    systemPrompt,
    userPrompt: prompt,
    requestBody: {
      system: [{ text: systemPrompt }],
      messages: [
        {
          role: 'user',
          content: [
            {
              text: prompt,
            }
          ],
        }
      ],
      inferenceConfig: {
        maxTokens,
        topP: 0.1,
        topK: 20,
        temperature
      }
    },
    response: {
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: 'The capital of France is Paris.'
    },
    streamedResponse: {
      inputTokens: 13,
      outputTokens: 8,
      text: 'The capital city of France is Paris.'
    },
    outputRole: 'assistant'
  },
  {
    provider: PROVIDER.AI21,
    modelId: 'ai21.jamba-1-5-mini-v1:0',
    userPrompt: prompt,
    requestBody: {
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: maxTokens,
      temperature,
    },
    response: {
      inputTokens: 17,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: ' The capital of France is Paris.'
    },
    outputRole: 'assistant'
  },
  {
    provider: PROVIDER.ANTHROPIC,
    modelId: 'anthropic.claude-v2:1',
    userPrompt: `\n\nHuman:${prompt}\n\nAssistant:`,
    requestBody: {
      prompt: `\n\nHuman:${prompt}\n\nAssistant:`,
      temperature,
      max_tokens_to_sample: maxTokens
    },
    response: {
      inputTokens: 16,
      outputTokens: 11,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: ' The capital of France is Paris.'
    }
  },
  {
    provider: PROVIDER.ANTHROPIC,
    modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    userPrompt: prompt,
    requestBody: {
      temperature,
      anthropic_version: 'bedrock-2023-05-31',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ],
      max_tokens: maxTokens,
    },
    response: {
      inputTokens: 14,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: 'The capital of France is Paris.'
    }
  },
  // TODO(sabrenner): input messages are undefined?
  // {
  //   provider: PROVIDER.COHERE,
  //   modelId: 'cohere.command-r-v1:0',
  //   userPrompt: prompt,
  //   requestBody: {
  //     message: prompt,
  //     temperature,
  //     max_tokens: maxTokens
  //   },
  //   response: {
  //     inputTokens: 7,
  //     outputTokens: 335,
  //     cacheReadTokens: 0,
  //     cacheWriteTokens: 0,
  //     text: 'The current capital of France is Paris. It has been the capital since 1958 and' +
  //       ' is also the most populous city in the country. Paris has a rich history and' +
  //       ' is known for its iconic landmarks and cultural significance.\n\nThe history' +
  //       ' of the capital of France is somewhat complex, with the city of Paris itself' +
  //       ' having a long and fascinating past. There was a shift in the capital\'s location' +
  //       ' over the centuries, with various cities and towns fulfilling the role. The' +
  //       ' earliest French capital based on historical records is thought to be the city' +
  //       ' of Tours. The capital moved to various locations, often due to political and' +
  //       ' dynastic reasons, including cities like Reims and Orleans. Paris initially' +
  //       ' became the capital during the era of the Louvre in the 14th century, under' +
  //       ' the rule of King Philip IV.\n\nThe status of Paris as the capital of France' +
  //       ' has been reaffirmed many times, even during the French Revolution and the' +
  //       ' establishment of the First French Empire by Napoleon Bonaparte. The city\'s' +
  //       ' significance grew further with its designation as the centre of the Department' +
  //       ' of Seine. Paris remained the capital through the changes in regime, including' +
  //       ' the restoration of the monarchy, the July Monarchy, the Second Empire, and' +
  //       ' the establishment of the French Third Republic.\n\nModern France\'s political' +
  //       ' system, following the end of the Second World War, saw the capital remain' +
  //       ' in Paris. The city continues to be a cultural hub, attracting artists, writers,' +
  //       ' and musicians from around the world. Paris remains a prominent global city,' +
  //       ' influencing art, fashion, gastronomy, and culture.\n\nIf you would like to' +
  //       ' know more about the history of France or the city of Paris, please let me' +
  //       ' know!'
  //   },
  //   streamedResponse: {
  //     inputTokens: 7,
  //     outputTokens: 7,
  //     text: 'The capital of France is Paris.'
  //   }
  // },
  {
    provider: PROVIDER.META,
    modelId: 'meta.llama3-8b-instruct-v1:0',
    userPrompt: prompt,
    requestBody: {
      prompt,
      temperature,
      max_gen_len: maxTokens
    },
    response: {
      inputTokens: 7,
      outputTokens: 512,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: '**\nA) Berlin\nB) Paris\nC) London\nD) Rome\n\nAnswer: ' +
        'B) Paris\n\n**What is the largest planet in our solar system?**\nA) Earth\nB) ' +
        'Saturn\nC) Jupiter\nD) Uranus\n\nAnswer: C) Jupiter\n\n**What is the smallest ' +
        'state in the United States?**\nA) Rhode Island\nB) Delaware\nC) Montana\nD) ' +
        'California\n\nAnswer: A) Rhode Island\n\n**What is the chemical symbol for ' +
        'gold?**\nA) Ag\nB) Au\nC) Hg\nD) Pb\n\nAnswer: B) Au\n\n**What is the largest ' +
        'mammal on Earth?**\nA) Elephant\nB) Blue whale\nC) Hippopotamus\nD) Rhinoceros\n\nAnswer: ' +
        'B) Blue whale\n\n**What is the chemical symbol for carbon?**\nA) C\nB) N\nC) ' +
        'O\nD) H\n\nAnswer: A) C\n\n**What is the largest country in the world by land ' +
        'area?**\nA) Russia\nB) Canada\nC) China\nD) United States\n\nAnswer: A) Russia\n\n**What ' +
        'is the chemical symbol for oxygen?**\nA) O\nB) N\nC) H\nD) C\n\nAnswer: A) ' +
        'O\n\n**What is the smallest bone in the human body?**\nA) Femur\nB) Tibia\nC) ' +
        'Fibula\nD) Stapes\n\nAnswer: D) Stapes\n\n**What is the chemical symbol for ' +
        'iron?**\nA) Fe\nB) Cu\nC) Zn\nD) Ag\n\nAnswer: A) Fe\n\n**What is the largest ' +
        'living species of lizard?**\nA) Komodo dragon\nB) Saltwater crocodile\nC) ' +
        'Black mamba\nD) African elephant\n\nAnswer: A) Komodo dragon\n\n**What is ' +
        'the chemical symbol for copper?**\nA) Cu\nB) Ag\nC) Au\nD) Hg\n\nAnswer: A) ' +
        'Cu\n\n**What is the smallest country in the world by land area?**\nA) Vatican ' +
        'City\nB) Monaco\nC) Nauru\nD) Tuvalu\n\nAnswer: A) Vatican City\n\n**What ' +
        'is the chemical symbol for sulfur?**\nA) S\nB) P\nC) Cl\nD) Br\n\nAnswer: ' +
        'A) S\n\n**What is the largest species of shark?**\nA) Great white shark\nB) ' +
        'Whale shark\nC) Tiger'
    },
    streamedResponse: {
      inputTokens: 7,
      outputTokens: 459,
      text: '**\nA. Berlin\nB. Paris\nC. London\nD. Rome\n\nAnswer: B. Paris\n#### 12. ' +
      'Which of the following planets is known for being the largest in our solar system?\nA. ' +
      'Earth\nB. Saturn\nC. Jupiter\nD. Uranus\n\nAnswer: C. Jupiter\n#### 13. Which of ' +
      'the following authors wrote the novel "To Kill a Mockingbird"?\nA. F. Scott Fitzgerald\nB. ' +
      'Harper Lee\nC. Jane Austen\nD. J.K. Rowling\n\nAnswer: B. Harper Lee\n#### 14. Which of the ' +
      'following musical instruments is often associated with the jazz genre?\nA. Piano\nB. Guitar\nC. ' +
      'Drums\nD. Trumpet\n\nAnswer: D. Trumpet\n#### 15. Which of the following countries is known for ' +
      'its chocolate production?\nA. Switzerland\nB. Belgium\nC. France\nD. Italy\n\nAnswer: B. ' +
      'Belgium\n#### 16. Which of the following ancient civilizations built the Great Pyramid of Giza?\nA. ' +
      'Egyptians\nB. Greeks\nC. Romans\nD. Babylonians\n\nAnswer: A. Egyptians\n#### 17. Which of the ' +
      'following chemical elements is a noble gas?\nA. Oxygen\nB. Nitrogen\nC. Helium\nD. Carbon\n\nAnswer: ' +
      'C. Helium\n#### 18. Which of the following famous paintings is also known as "La Gioconda"?\nA. ' +
      'The Mona Lisa\nB. The Scream\nC. Starry Night\nD. The Last Supper\n\nAnswer: A. The Mona Lisa\n#### ' +
      '19. Which of the following countries is known for its coffee production?\nA. Brazil\nB. ' +
      'Colombia\nC. Ethiopia\nD. Vietnam\n\nAnswer: C. Ethiopia\n#### 20. Which of the following ' +
      'ancient philosophers is known for his concept of the "examined life"?\nA. Socrates\nB. ' +
      'Plato\nC. Aristotle\nD. Epicurus\n\nAnswer: A. Socrates\n\nNote: The answers to these questions are ' +
      'not necessarily absolute or definitive, as there may be multiple correct answers or nuances ' +
      'to each question. However, the answers provided are generally accepted and accurate.'
    }
  },
  {
    provider: PROVIDER.MISTRAL,
    modelId: 'mistral.mistral-7b-instruct-v0:2',
    userPrompt: prompt,
    requestBody: {
      prompt,
      max_tokens: maxTokens,
      temperature,
    },
    response: {
      inputTokens: 8,
      outputTokens: 129,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      text: ' Paris is the capital city of France. It ' +
        'is the most populous city in France and is considered one of the cultural, ' +
        'artistic, and intellectual centers of Europe. Paris is known for its iconic ' +
        'landmarks such as the Eiffel Tower, the Louvre Museum, and the Notre-Dame ' +
        'Cathedral. It is also famous for its cuisine, fashion, and cafe culture. Paris ' +
        'has a rich history and is home to many world-renowned institutions, including ' +
        'the Sorbonne University and the École Normale Supérieure. It is a popular ' +
        'tourist destination and attracts millions of visitors every year.'
    },
    streamedResponse: {
      inputTokens: 8,
      outputTokens: 94,
      text: ' Paris is the capital city of France. It is the most populous city in France, ' +
      'and it is also one of the most visited cities in the world. Paris is known for its ' +
      'iconic landmarks such as the Eiffel Tower, the Louvre Museum, and Notre Dame Cathedral. ' +
      'It is also famous for its cuisine, fashion, and art scene. Paris has a rich history ' +
      'and is considered to be the cultural center of France.'
    }
  }
]
bedrockruntime.modelConfig = {
  temperature,
  maxTokens
}

bedrockruntime.cacheWriteRequest = {
  provider: PROVIDER.ANTHROPIC,
  modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  userPrompt: prompt,
  requestBody: {
    temperature,
    anthropic_version: 'bedrock-2023-05-31',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are a geography expert'.repeat(200) + prompt,
            cache_control: {
              type: 'ephemeral'
            }
          }
        ],
      }
    ],
    max_tokens: 10,
  },
  response: {
    inputTokens: 1213,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 1209,
    text: 'The capital of France is Paris.\n\nParis is'
  },
  outputRole: 'assistant'
}
bedrockruntime.cacheReadRequest = {
  provider: PROVIDER.ANTHROPIC,
  modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  userPrompt: 'What is the capital of Italy?',
  requestBody: {
    temperature,
    anthropic_version: 'bedrock-2023-05-31',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'You are a geography expert'.repeat(200) + 'What is the capital of Italy?',
            cache_control: {
              type: 'ephemeral'
            }
          }
        ],
      }
    ],
    max_tokens: 10,
  },
  response: {
    inputTokens: 1213,
    outputTokens: 10,
    cacheReadTokens: 1209,
    cacheWriteTokens: 0,
    text: 'The capital of Italy is Rome (Roma in Italian'
  },
  outputRole: 'assistant'
}

module.exports = bedrockruntime
