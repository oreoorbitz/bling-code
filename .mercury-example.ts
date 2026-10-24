/*

API
Your key, drop-in code and the LLMs.txt for inception/mercury-3.

1
Get your API key
Create an API key from your OpenRouter dashboard and set it as an environment variable:

Create API Key

Copy
export OPENROUTER_API_KEY=sk-or-v1-...
2
Make your first request
Use inception/mercury-3 with the OpenRouter API:

OpenRouter supports reasoning-enabled models that can show their step-by-step thinking process. Use the reasoning parameter in your request to enable reasoning, and access the reasoning_details array in the response to see the model's internal reasoning before the final answer. When continuing a conversation, preserve the complete reasoning_details when passing messages back to the model so it can continue reasoning from where it left off. Learn more about reasoning tokens.

In the examples below, the OpenRouter-specific headers are optional. Setting them allows your app to appear on the OpenRouter leaderboards.

TypeScript SDK
Python
TypeScript (fetch)
cURL
Python (OpenAI)
TypeScript (OpenAI)

Copy
import { OpenRouter } from "@openrouter/sdk";

const openrouter = new OpenRouter({
  apiKey: "<OPENROUTER_API_KEY>"
});

// Stream the response to get reasoning tokens in usage
const stream = await openrouter.chat.send({
  chatRequest: {
    model: "inception/mercury-3",
    messages: [
      {
        role: "user",
        content: "How many r's are in the word 'strawberry'?"
      }
    ],
    stream: true
  }
});

let response = "";
for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    response += content;
    process.stdout.write(content);
  }

  // Usage information comes in the final chunk
  if (chunk.usage) {
    console.log("\nReasoning tokens:", chunk.usage.completionTokensDetails?.reasoningTokens);
  }
}
Using third-party SDKs
For information about using third-party SDKs and frameworks with OpenRouter, please see our frameworks documentation.

3
Enable streaming
Add "stream": true to your request body to receive responses as server-sent events:


Copy
curl -N https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
  "model": "inception/mercury-3",
  "stream": true,
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}'
Endpoint
Sends a request for a model response for the given chat conversation. Supports both streaming and non-streaming modes.

POST
https://openrouter.ai/api/v1/chat/completions
Authorization
Bearer $OPENROUTER_API_KEY
Content-Type
application/json
HTTP-Referer
optional — your site URL, for rankings
X-Title
optional — your site name, for rankings
Model
inception/mercury-3
Creates a streaming or non-streaming response using the OpenAI Responses API format.

Docs
POST
https://openrouter.ai/api/v1/responses
Authorization
Bearer $OPENROUTER_API_KEY
Content-Type
application/json
HTTP-Referer
optional — your site URL, for rankings
X-Title
optional — your site name, for rankings
Model
inception/mercury-3
Creates a message using the Anthropic Messages API format. Supports text, images, PDFs, tools, and extended thinking.

Docs
POST
https://openrouter.ai/api/v1/messages
Authorization
Bearer $OPENROUTER_API_KEY
Content-Type
application/json
HTTP-Referer
optional — your site URL, for rankings
X-Title
optional — your site name, for rankings
Model
inception/mercury-3
Parameters
Name	Type	Default	Description
reasoning	map	—	Controls reasoning behavior for models that support thinking tokens, including whether reasoning is enabled, the reasoning effort, maximum reasoning tokens, and whether reasoning is excluded from the response.
max_tokens	integer	—	This sets the upper limit for the number of tokens the model can generate in response.
stop	array	—	Stop generation immediately if the model encounter any token specified in the stop array.
temperature	float	1	This setting influences the variety in the model's responses.
tools	array	—	Tool calling parameter, following OpenAI's tool calling request shape.
tool_choice	string or object	—	Controls which (if any) tool is called by the model.
response_format	map	—	Forces the model to produce specific output format.
*/
