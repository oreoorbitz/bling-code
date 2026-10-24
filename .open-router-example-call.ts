import { OpenRouter } from "@openrouter/sdk";

const openrouter = new OpenRouter({
  apiKey: "<OPENROUTER_API_KEY>"
});

// Stream the response to get reasoning tokens in usage
const stream = await openrouter.chat.send({
  chatRequest: {
    model: "inclusionai/ling-3.1-flash",
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


// Enabling streaming:
/*
curl -N https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
  "model": "inclusionai/ling-3.1-flash",
  "stream": true,
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}'
*/


/*
Other context:
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
inclusionai/ling-3.1-flash
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
inclusionai/ling-3.1-flash
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
inclusionai/ling-3.1-flash
Parameters
Name	Type	Default	Description
reasoning	map	—	Controls reasoning behavior for models that support thinking tokens, including whether reasoning is enabled, the reasoning effort, maximum reasoning tokens, and whether reasoning is excluded from the response.
max_tokens	integer	—	This sets the upper limit for the number of tokens the model can generate in response.
temperature	float	1	This setting influences the variety in the model's responses.
top_p	float	1	This setting limits the model's choices to a percentage of likely tokens: only the top tokens whose probabilities add up to P.
stop	array	—	Stop generation immediately if the model encounter any token specified in the stop array.
frequency_penalty	float	0	This setting aims to control the repetition of tokens based on how often they appear in the input.
presence_penalty	float	0	Adjusts how often the model repeats specific tokens already used in the input.
repetition_penalty	float	1	Helps to reduce the repetition of tokens from the input.
top_k	integer	0	This limits the model's choice of tokens at each step, making it choose from a smaller set.
seed	integer	—	If specified, the inferencing will sample deterministically, such that repeated requests with the same seed and parameters should return the same result.
min_p	float	0	Represents the minimum probability for a token to be considered, relative to the probability of the most likely token.
logit_bias	map	—	Accepts a JSON object that maps tokens (specified by their token ID in the tokenizer) to an associated bias value from -100 to 100.
tools	array	—	Tool calling parameter, following OpenAI's tool calling request shape.
tool_choice	string or object	—	Controls which (if any) tool is called by the model.
response_format	map	—	Forces the model to produce specific ou
*/
