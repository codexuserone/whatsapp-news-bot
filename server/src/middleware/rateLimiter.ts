import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
  windowStart: number;
}

interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  skipSuccessfulRequests?: boolean;
  keyGenerator?: (req: Request) => string;
  onLimitReached?: (req: Request, res: Response) => void;
}

// In-memory store (consider Redis for multi-instance deployments)
const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Simple in-memory rate limiter middleware
 * For multi-instance deployments, consider using Redis or a shared store
 */
export const rateLimit = (options: RateLimitOptions = {}) => {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute default
  const maxRequests = options.maxRequests || 100;
  
  return (req: Request, res: Response, next: NextFunction) => {
    const key = options.keyGenerator 
      ? options.keyGenerator(req)
      : `${req.ip || 'unknown'}:${req.path}`;
    
    const now = Date.now();
    const entry = store.get(key);
    
    if (!entry || entry.resetAt < now) {
      // New window
      store.set(key, {
        count: 1,
        resetAt: now + windowMs,
        windowStart: now
      });
      
      // Set headers
      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', (maxRequests - 1).toString());
      res.setHeader('X-RateLimit-Reset', new Date(now + windowMs).toISOString());
      
      return next();
    }
    
    // Existing window
    if (entry.count >= maxRequests) {
      // Rate limit exceeded
      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', new Date(entry.resetAt).toISOString());
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000).toString());
      
      if (options.onLimitReached) {
        options.onLimitReached(req, res);
      }
      
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000)
      });
    }
    
    // Increment counter
    entry.count++;
    
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', (maxRequests - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', new Date(entry.resetAt).toISOString());
    
    next();
  };
};

/**
 * Rate limiter for WhatsApp QR code endpoint
 * More restrictive to prevent abuse
 */
export const qrCodeRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 5,
  keyGenerator: (req) => `qr:${req.ip || 'unknown'}`
});

/**
 * Rate limiter for authentication endpoints
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 10,
  keyGenerator: (req) => `auth:${req.ip || 'unknown'}`
});

/**
 * Rate limiter for API endpoints
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
  keyGenerator: (req) => `api:${req.ip || 'unknown'}:${req.path}`
});

/**
 * Rate limiter for feed fetching
 * Prevents abuse of feed refresh endpoints
 */
export const feedRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60,
  keyGenerator: (req) => `feed:${req.ip || 'unknown'}:${req.method}:${req.path}`
});
