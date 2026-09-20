import { createHash } from 'node:crypto';
import Redis from 'ioredis';

const DEFAULT_MAX = 15;
const DEFAULT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_REDIS_URL = 'redis://192.168.0.62:6379/1';

// Increment and set the expiry atomically. Returning PTTL gives the API an
// accurate Retry-After value without a second Redis round trip.
const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

let redis;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRateLimitConfig() {
  return {
    max: positiveInteger(process.env.IMAGE_GEN_RATE_LIMIT_MAX, DEFAULT_MAX),
    windowSeconds: positiveInteger(
      process.env.IMAGE_GEN_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_WINDOW_SECONDS
    ),
  };
}

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });
    // The API handles command failures. Keep ioredis from treating connection
    // errors as unhandled events while Redis is temporarily unavailable.
    redis.on('error', () => {});
  }
  return redis;
}

// Await the TCP connection before sending a command. With enableOfflineQueue
// disabled the first request can arrive before ioredis has connected, which
// would otherwise reject immediately. This resolves once the client is ready,
// or rejects on timeout / connection failure so callers can fail closed.
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

function rateKey(userEmail) {
  const digest = createHash('sha256').update(userEmail).digest('hex');
  return `image-generate:rate:${digest}`;
}

/**
 * Consume one generation attempt for a user.
 * Throws when Redis is unavailable so callers can fail closed and protect the GPU.
 */
export async function checkImageGenerateRateLimit(userEmail) {
  const { max, windowSeconds } = getRateLimitConfig();
  const windowMs = windowSeconds * 1000;
  const client = await getReadyRedis();
  const [rawCount, rawTtl] = await client.eval(
    LIMIT_SCRIPT,
    1,
    rateKey(userEmail),
    String(windowMs)
  );
  const count = Number(rawCount);
  const ttlMs = Math.max(0, Number(rawTtl));

  return {
    allowed: count <= max,
    limit: max,
    remaining: Math.max(0, max - count),
    retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

/**
 * Read the user's current rate-limit usage WITHOUT consuming an attempt.
 * Powers the live quota display. Throws when Redis is unavailable so callers
 * can degrade gracefully (the page keeps its last known / static quota line).
 */
export async function getRateLimitStatus(userEmail) {
  const { max, windowSeconds } = getRateLimitConfig();
  const client = await getReadyRedis();
  const key = rateKey(userEmail);
  const [rawCount, rawTtl] = await Promise.all([client.get(key), client.pttl(key)]);
  const count = Math.max(0, Number(rawCount) || 0);
  const ttlMs = Number(rawTtl); // -2 = key missing, -1 = no expiry, else ms left
  return {
    limit: max,
    used: Math.min(count, max),
    remaining: Math.max(0, max - count),
    windowSeconds,
    resetsInSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0,
  };
}
