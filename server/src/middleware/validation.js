const Joi = require('joi');

const JID_PATTERN = /^([0-9+\s\-\(\)]+|status@broadcast|[0-9\-]+@g\.us|[0-9]+@s\.whatsapp\.net)$/i;

// Validation schemas
const schemas = {
  // Schedule validation
  schedule: Joi.object({
    name: Joi.string().min(1).max(255).required(),
    cron_expression: Joi.string().optional().allow('', null),
    timezone: Joi.string().default('UTC'),
    feed_id: Joi.string().uuid().optional().allow('', null),
    target_ids: Joi.array().items(Joi.string().uuid()).min(1).required(),
    template_id: Joi.string().uuid().required(),
    active: Joi.boolean().default(true)
  }),

  // Feed validation
  feed: Joi.object({
    name: Joi.string().min(1).max(255).required(),
    url: Joi.string().uri().required(),
    type: Joi.string().valid('rss', 'atom', 'json').default('rss'),
    active: Joi.boolean().default(true),
    fetch_interval: Joi.number().integer().min(60).default(300)
  }),

  // Target validation
  target: Joi.object({
    name: Joi.string().min(1).max(255).required(),
    phone_number: Joi.string().pattern(JID_PATTERN).required(),
    type: Joi.string().valid('individual', 'group', 'channel', 'status').required(),
    active: Joi.boolean().default(true),
    notes: Joi.string().max(1000).optional().allow('', null)
  }),

  // Template validation
  template: Joi.object({
    name: Joi.string().min(1).max(255).required(),
    content: Joi.string().min(1).max(5000).required(),
    description: Joi.string().max(1000).optional().allow('', null),
    active: Joi.boolean().default(true)
  }),

  // WhatsApp test message validation
  testMessage: Joi.object({
    jid: Joi.string().pattern(JID_PATTERN).required(),
    message: Joi.string().min(1).max(4096).required()
  }),

  statusMessage: Joi.object({
    message: Joi.string().max(4096).optional().allow('', null),
    imageUrl: Joi.string().uri().optional().allow('', null)
  }).custom((value, helpers) => {
    if (!value.message && !value.imageUrl) {
      return helpers.error('any.required');
    }
    return value;
  }, 'status message validation'),

  // Settings validation
  settings: Joi.object().pattern(
    Joi.string(),
    Joi.alternatives().try(
      Joi.string(),
      Joi.number(),
      Joi.boolean(),
      Joi.object(),
      Joi.array()
    )
  )
};

// Validation middleware factory
const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context.value
      }));

      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    req.body = value;
    next();
  };
};

// Sanitization helpers
const sanitizePhoneNumber = (phone) => {
  // Remove all non-numeric characters except + for international numbers
  return phone.replace(/[^0-9+]/g, '');
};

const sanitizeUrl = (url) => {
  // Basic URL sanitization
  const urlPattern = /^https?:\/\/.+/;
  if (!urlPattern.test(url)) {
    throw new Error('Invalid URL format');
  }
  return url;
};

const sanitizeHtml = (text) => {
  // Basic HTML sanitization - remove script tags and dangerous attributes
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
};

module.exports = {
  schemas,
  validate,
  sanitizePhoneNumber,
  sanitizeUrl,
  sanitizeHtml
};
