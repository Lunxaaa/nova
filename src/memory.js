import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { createEmbedding, summarizeConversation } from './openai.js';

const ensureDir = async (filePath) => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
};

const defaultStore = { users: {} };

async function readStore() {
  try {
    const raw = await fs.readFile(config.memoryFile, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await ensureDir(config.memoryFile);
      await fs.writeFile(config.memoryFile, JSON.stringify(defaultStore, null, 2));
      return JSON.parse(JSON.stringify(defaultStore));
    }
    throw error;
  }
}

async function writeStore(store) {
  await ensureDir(config.memoryFile);
  await fs.writeFile(config.memoryFile, JSON.stringify(store, null, 2));
}

function ensureUser(store, userId) {
  if (!store.users[userId]) {
    store.users[userId] = {
      shortTerm: [],
      longTerm: [],
      summary: '',
      lastUpdated: Date.now(),
    };
  }
  return store.users[userId];
}

function shortTermToText(shortTerm) {
  return shortTerm
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Bot'}: ${msg.content}`)
    .join('\n');
}

function estimateImportance(text) {
  const keywords = ['remember', 'promise', 'plan', 'goal', 'project', 'birthday'];
  const keywordBoost = keywords.reduce((score, word) => (text.toLowerCase().includes(word) ? score + 0.2 : score), 0);
  const lengthScore = Math.min(text.length / 400, 0.5);
  const emojiBoost = /:[a-z_]+:|😊|😂|❤️/i.test(text) ? 0.1 : 0;
  return Math.min(1, 0.2 + keywordBoost + lengthScore + emojiBoost);
}

async function pruneMemories(userMemory) {
  if (userMemory.longTerm.length <= config.maxMemories) {
    return;
  }
  userMemory.longTerm.sort((a, b) => a.importance - b.importance || a.timestamp - b.timestamp);
  while (userMemory.longTerm.length > config.maxMemories) {
    userMemory.longTerm.shift();
  }
}

async function maybeSummarize(userMemory) {
  const charCount = userMemory.shortTerm.reduce((sum, msg) => sum + msg.content.length, 0);
  if (charCount < config.summaryTriggerChars || userMemory.shortTerm.length < config.shortTermLimit) {
    return;
  }
  const transcript = shortTermToText(userMemory.shortTerm);
  const updatedSummary = await summarizeConversation(userMemory.summary, transcript);
  if (updatedSummary) {
    userMemory.summary = updatedSummary;
    userMemory.shortTerm = userMemory.shortTerm.slice(-4);
  }
}

function cosineSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const dot = a.reduce((sum, value, idx) => sum + value * (b[idx] || 0), 0);
  const magA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const magB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  if (!magA || !magB) return 0;
  return dot / (magA * magB);
}

async function retrieveRelevantMemories(userMemory, query) {
  if (!userMemory.longTerm.length || !query?.trim()) {
    return [];
  }
  const queryEmbedding = await createEmbedding(query);
  const scored = userMemory.longTerm
    .map((entry) => ({
      ...entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding) + entry.importance * 0.1,
    }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, config.relevantMemoryCount);
}

export async function appendShortTerm(userId, role, content) {
  const store = await readStore();
  const userMemory = ensureUser(store, userId);
  userMemory.shortTerm.push({ role, content, timestamp: Date.now() });
  if (userMemory.shortTerm.length > config.shortTermLimit * 2) {
    userMemory.shortTerm = userMemory.shortTerm.slice(-config.shortTermLimit * 2);
  }
  await maybeSummarize(userMemory);
  await writeStore(store);
}

export async function prepareContext(userId, incomingMessage) {
  const store = await readStore();
  const userMemory = ensureUser(store, userId);
  const relevant = await retrieveRelevantMemories(userMemory, incomingMessage);
  return {
    shortTerm: userMemory.shortTerm.slice(-config.shortTermLimit),
    summary: userMemory.summary,
    memories: relevant,
  };
}

export async function recordInteraction(userId, userMessage, botReply) {
  const store = await readStore();
  const userMemory = ensureUser(store, userId);
  const combined = `User: ${userMessage}\nBot: ${botReply}`;
  const embedding = await createEmbedding(combined);
  const importance = estimateImportance(combined);
  userMemory.longTerm.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: combined,
    embedding,
    importance,
    timestamp: Date.now(),
  });
  await pruneMemories(userMemory);
  userMemory.lastUpdated = Date.now();
  await writeStore(store);
}

export async function pruneLowImportanceMemories(userId) {
  const store = await readStore();
  const userMemory = ensureUser(store, userId);
  userMemory.longTerm = userMemory.longTerm.filter((entry) => entry.importance >= config.memoryPruneThreshold);
  await writeStore(store);
}
