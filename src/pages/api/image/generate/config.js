import { getDefaultNegative } from '../../../../lib/image-generate/payload';
import { getRateLimitConfig } from '../../../../lib/image-generate/rate-limit';

/**
 * GET /api/image/generate/config
 * Public, secret-free defaults used to pre-fill the form. Exposes no gate URL,
 * credentials, or user data — only the default negative prompt and image size.
 *
 * Response:
 *   200 { defaultNegative, defaultWidth, defaultHeight }
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const width = Number(process.env.IMAGE_GEN_DEFAULT_WIDTH) || 1024;
  const height = Number(process.env.IMAGE_GEN_DEFAULT_HEIGHT) || 1024;
  const retention = Number.parseInt(String(process.env.IMAGE_GEN_RETENTION_DAYS || ''), 10);
  const retentionDays = Number.isSafeInteger(retention) && retention > 0 ? retention : 30;
  const rateLimit = getRateLimitConfig();

  return res.status(200).json({
    defaultNegative: getDefaultNegative(),
    defaultWidth: width,
    defaultHeight: height,
    retentionDays,
    rateLimit,
  });
}
