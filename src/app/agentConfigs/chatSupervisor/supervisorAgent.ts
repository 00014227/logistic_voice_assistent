import { RealtimeItem, tool } from '@openai/agents/realtime';


import {
  exampleAccountInfo,
  examplePolicyDocs,
  exampleStoreLocations,
} from './sampleData';

export const supervisorAgentInstructions = `
You are an expert customer service supervisor agent for a logistics company called TransAsia Logistics.
You guide a junior voice agent who speaks directly with the customer.  
The junior agent reads your messages verbatim.

# Language Rules
- Automatically detect whether the user speaks Russian or Uzbek.
- Always respond only in the user's language.
- Switch languages if the user switches.
- Never mix languages in the same response.
- Maintain a neutral, concise, businesslike tone.
- Do not ask the question if customer provides already

# Domain Rules (Logistics, Transport & Customs Only)
You must assist with ANY questions related to:
- sending cargo
- calculating shipping cost
- international freight rates
- DDP / DAP / CIF / FOB pricing
- customs clearance and taxes
- weight/volume/dimensions assessments
- type of cargo requirements
- delivery times and transit routes
- warehousing, consolidation, packaging
- pickup/delivery coordination
- tracking and account information

This includes:  
requesting shipment details, giving preliminary recommendations, approximate price ranges, transport type suggestions, and customs guidance.

If the user asks about anything unrelated (selling goods, politics, religion, crypto, medical or legal advice, personal relationships, spam),  
you must politely decline and redirect them back to logistics.

Russian example:
"Извините, я могу помогать только по перевозкам, логистике и таможенному оформлению. Какой груз хотите отправить?"

Uzbek example:
"Kechirasiz, men faqat logistika, yetkazib berish va bojxona bo‘yicha yordam bera olaman. Qaysi yukni yubormoqchisiz?"

# Key Requirement: When the user wants to ship cargo or calculate cost
If the user says anything like:
- "хочу отправить груз"
- "нужно перевезти товар"
- "рассчитайте стоимость"
- "мне нужен DDP"
- "сколько стоит доставка"
- "qancha turadi"
- "yuk jo‘natmoqchiman"

Then you MUST:
1. Ask all required details (one by one, clearly):  
   - origin and destination  
   - weight  
   - dimensions or volume (m³)  
   - type of cargo  
   - Incoterms (if applicable)  
   - ready date / desired delivery date  

2. Provide recommendations when applicable (transport mode, packaging, route).

3. Give a **preliminary price estimate** (rough range, not exact).  
   Example:  
   Russian: "Предварительно ориентировочная стоимость составляет от … до …"  
   Uzbek: "Taxminiy narx … dan … gacha bo‘lishi mumkin."

4. **Always finish with:**  
   Russian: "Для точного расчёта с вами свяжется наш оператор."  
   Uzbek: "Aniq hisob-kitob uchun operatorimiz siz bilan bog‘lanadi."

This must be included every time the user requests a shipping price.

# Tool Usage Rules
- If providing factual account details or internal policy info: ALWAYS call a tool before answering.
- NEVER answer logistics facts from your own knowledge; use tool results.
- If a tool requires parameters you don't have, instruct the junior agent to ask the user for missing information (phone, zip code, etc.).
- Never call a tool with empty or default values.
- You may escalate to a human if the user asks.

# Conversation Behavior
- The junior agent already handles greetings.
- Keep responses extremely concise for voice.
- No bullet lists. Speak in short, natural sentences.
- Your message must sound like you are speaking directly to the user.
- Use citations when referencing retrieved documents.

# Prohibited Topics
Decline and redirect if the user discusses:
- politics
- religion
- personal/romantic topics
- legal/financial advice (outside logistics)
- medical topics
- crypto
- selling or promoting unrelated items
- insults or inappropriate content

# Sample Helper Phrases (modify naturally)
Russian:
"Секунду, уточню информацию."
"Чтобы продолжить, уточните, пожалуйста…"
"Предварительно могу сказать…"

Uzbek:
"Hozir tekshirib ko‘raman."
"Davom etish uchun iltimos aniqlab bering…"
"Taxminiy aytadigan bo‘lsam…"

# Output Format
Your output must be ONLY one of:
- A message for the junior agent to read out loud, OR
- A tool call (if needed), followed by a message after tool output.

Your message must be short, accurate, and strictly in the user’s language.
`;



export const supervisorAgentTools = [
  {
    type: "function",
    name: "lookupPolicyDocument",
    description:
      "Tool to look up internal documents and policies by topic or keyword.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "The topic or keyword to search for in company policies or documents.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "getUserAccountInfo",
    description:
      "Tool to get user account information. This only reads user accounts information, and doesn't provide the ability to modify or delete any values.",
    parameters: {
      type: "object",
      properties: {
        phone_number: {
          type: "string",
          description:
            "Formatted as '(xxx) xxx-xxxx'. MUST be provided by the user, never a null or empty string.",
        },
      },
      required: ["phone_number"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "findNearestStore",
    description:
      "Tool to find the nearest store location to a customer, given their zip code.",
    parameters: {
      type: "object",
      properties: {
        zip_code: {
          type: "string",
          description: "The customer's 5-digit zip code.",
        },
      },
      required: ["zip_code"],
      additionalProperties: false,
    },
  },
];

async function fetchResponsesMessage(body: any) {
  const response = await fetch('/api/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    // Preserve the previous behaviour of forcing sequential tool calls.
    body: JSON.stringify({ ...body, parallel_tool_calls: false }),
  });

  if (!response.ok) {
    console.warn('Server returned an error:', response);
    return { error: 'Something went wrong.' };
  }

  const completion = await response.json();
  return completion;
}

function getToolResponse(fName: string) {
  switch (fName) {
    case "getUserAccountInfo":
      return exampleAccountInfo;
    case "lookupPolicyDocument":
      return examplePolicyDocs;
    case "findNearestStore":
      return exampleStoreLocations;
    default:
      return { result: true };
  }
}

/**
 * Iteratively handles function calls returned by the Responses API until the
 * supervisor produces a final textual answer. Returns that answer as a string.
 */
async function handleToolCalls(
  body: any,
  response: any,
  addBreadcrumb?: (title: string, data?: any) => void,
) {
  let currentResponse = response;

  while (true) {
    if (currentResponse?.error) {
      return { error: 'Something went wrong.' } as any;
    }

    const outputItems: any[] = currentResponse.output ?? [];

    // Gather all function calls in the output.
    const functionCalls = outputItems.filter((item) => item.type === 'function_call');

    if (functionCalls.length === 0) {
      // No more function calls – build and return the assistant's final message.
      const assistantMessages = outputItems.filter((item) => item.type === 'message');

      const finalText = assistantMessages
        .map((msg: any) => {
          const contentArr = msg.content ?? [];
          return contentArr
            .filter((c: any) => c.type === 'output_text')
            .map((c: any) => c.text)
            .join('');
        })
        .join('\n');

      return finalText;
    }

    // For each function call returned by the supervisor model, execute it locally and append its
    // output to the request body as a `function_call_output` item.
    for (const toolCall of functionCalls) {
      const fName = toolCall.name;
      const args = JSON.parse(toolCall.arguments || '{}');
      const toolRes = getToolResponse(fName);

      // Since we're using a local function, we don't need to add our own breadcrumbs
      if (addBreadcrumb) {
        addBreadcrumb(`[supervisorAgent] function call: ${fName}`, args);
      }
      if (addBreadcrumb) {
        addBreadcrumb(`[supervisorAgent] function call result: ${fName}`, toolRes);
      }

      // Add function call and result to the request body to send back to realtime
      body.input.push(
        {
          type: 'function_call',
          call_id: toolCall.call_id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
        {
          type: 'function_call_output',
          call_id: toolCall.call_id,
          output: JSON.stringify(toolRes),
        },
      );
    }

    // Make the follow-up request including the tool outputs.
    currentResponse = await fetchResponsesMessage(body);
  }
}

export const getNextResponseFromSupervisor = tool({
  name: 'getNextResponseFromSupervisor',
  description:
    'Determines the next response whenever the agent faces a non-trivial decision, produced by a highly intelligent supervisor agent. Returns a message describing what to do next.',
  parameters: {
    type: 'object',
    properties: {
      relevantContextFromLastUserMessage: {
        type: 'string',
        description:
          'Key information from the user described in their most recent message. This is critical to provide as the supervisor agent with full context as the last message might not be available. Okay to omit if the user message didn\'t add any new information.',
      },
    },
    required: ['relevantContextFromLastUserMessage'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { relevantContextFromLastUserMessage } = input as {
      relevantContextFromLastUserMessage: string;
    };

    const addBreadcrumb = (details?.context as any)?.addTranscriptBreadcrumb as
      | ((title: string, data?: any) => void)
      | undefined;

    const history: RealtimeItem[] = (details?.context as any)?.history ?? [];
    const filteredLogs = history.filter((log) => log.type === 'message');

    const body: any = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message',
          role: 'system',
          content: supervisorAgentInstructions,
        },
        {
          type: 'message',
          role: 'user',
          content: `==== Conversation History ====
          ${JSON.stringify(filteredLogs, null, 2)}
          
          ==== Relevant Context From Last User Message ===
          ${relevantContextFromLastUserMessage}
          `,
        },
      ],
      tools: supervisorAgentTools,
    };

    const response = await fetchResponsesMessage(body);
    if (response.error) {
      return { error: 'Something went wrong.' };
    }

    const finalText = await handleToolCalls(body, response, addBreadcrumb);
    if ((finalText as any)?.error) {
      return { error: 'Something went wrong.' };
    }

    return { nextResponse: finalText as string };
  },
});
  