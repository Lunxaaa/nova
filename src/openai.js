import OpenAI from 'openai';
import { config } from './config.js';

const client = new OpenAI({ apiKey: config.openAiKey });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, attempts = 3, delayMs = 1500) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      if (status === 429 || status >= 500) {
        const backoff = delayMs * (i + 1);
        console.warn(`[openai] Rate limited or server error. Retry ${i + 1}/${attempts} in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

export async function chatCompletion(messages, options = {}) {
  const {
    model = config.chatModel,
    temperature = 0.7,
    maxTokens = 400,
  } = options;

  const response = await withRetry(() => client.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  }));

  return response?.choices?.[0]?.message?.content?.trim() || '';
}

export async function createEmbedding(text) {
  if (!text || !text.trim()) {
    return [];
  }
  const response = await withRetry(() => client.embeddings.create({
    model: config.embedModel,
    input: text,
  }));
  return response?.data?.[0]?.embedding || [];
}

export async function summarizeConversation(summarySoFar, transcriptChunk) {
  const system = {
    role: 'system',
    content: 'You compress Discord chats. Keep tone casual, capture facts, goals, and emotional state. Max 120 words.'
  };
  const prompt = `Existing summary (can be empty): ${summarySoFar || 'None'}\nNew messages:\n${transcriptChunk}`;
  const user = { role: 'user', content: prompt };
  return chatCompletion([system, user], { temperature: 0.4, maxTokens: 180 });
}
