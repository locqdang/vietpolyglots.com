// Server-side rate limiter for the prompt assistant. A separate, tighter limit
// than image generation because each call loads/uses the LLM gate (GPU + token
// cost). Mirrors rate-limit.js: atomic INCR + PEXPIRE + PTTL via a Lua script,
// keyed on a sha256 of the user email, fail-closed when Redis is unavailable.

import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { getPromptAssistantConfig } from './prompt-assistant-config';

const DEFAULT_REDIS_URL = 'redis://192.168.0.62:6379/1';

const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });
    redis.on('error', () => {});
  }
  return redis;
}

async function getReadyRedis() {
  const client = getRedis();
  if (client.status === 'ready') return client;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis not ready in time')), 3000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('end', () => {
      clearTimeout(timer);
      reject(new Error('Redis connection closed'));
    });
  });
  return client;
}

export function promptAssistantRateKey(userEmail) {
  const digest = createHash('sha256').update(userEmail).digest('hex');
  return `prompt-assistant:rate:${digest}`;
}

/**
 * Consume one assistant attempt for a user.
 * Throws when Redis is unavailable so callers can fail closed (503) rather than
 * allowing unlimited LLM calls.
 */
export async function checkPromptAssistantRateLimit(userEmail) {
  const { rateLimitMax, rateLimitWindowSeconds } = getPromptAssistantConfig();
  const windowMs = rateLimitWindowSeconds * 1000;
  const client = await getReadyRedis();
  const [rawCount, rawTtl] = await client.eval(
    LIMIT_SCRIPT,
    1,
    promptAssistantRateKey(userEmail),
    String(windowMs)
  );
  const count = Number(rawCount);
  const ttlMs = Math.max(0, Number(rawTtl));

  return {
    allowed: count <= rateLimitMax,
    limit: rateLimitMax,
    remaining: Math.max(0, rateLimitMax - count),
    retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}
