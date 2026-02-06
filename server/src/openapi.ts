const spec = {
  openapi: '3.0.3',
  info: {
    title: 'WhatsApp News Bot API',
    version: '1.0.0'
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'system' },
    { name: 'whatsapp' },
    { name: 'feeds' },
    { name: 'templates' },
    { name: 'targets' },
    { name: 'schedules' },
    { name: 'queue' },
    { name: 'logs' },
    { name: 'settings' },
    { name: 'shabbos' }
  ],
  components: {
    schemas: {
      Uuid: { type: 'string', format: 'uuid' },
      IsoDateTime: { type: 'string', format: 'date-time' },
      TimeOfDay: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      ScheduleDeliveryMode: { type: 'string', enum: ['immediate', 'batched'], default: 'immediate' },
      FeedSummary: {
        type: 'object',
        properties: {
          id: { $ref: '#/components/schemas/Uuid' },
          name: { type: 'string' },
          url: { type: 'string' }
        }
      },
      TemplateSummary: {
        type: 'object',
        properties: {
          id: { $ref: '#/components/schemas/Uuid' },
          name: { type: 'string' },
          content: { type: 'string' }
        }
      },
      TargetSummary: {
        type: 'object',
        properties: {
          id: { $ref: '#/components/schemas/Uuid' },
          name: { type: 'string' },
          phone_number: { type: 'string' },
          type: { type: 'string' }
        }
      },
      ScheduleInput: {
        type: 'object',
        required: ['name', 'feed_id', 'template_id', 'target_ids'],
        properties: {
          name: { type: 'string' },
          cron_expression: { type: 'string', nullable: true },
          timezone: { type: 'string', default: 'UTC' },
          feed_id: { $ref: '#/components/schemas/Uuid' },
          target_ids: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/components/schemas/Uuid' }
          },
          template_id: { $ref: '#/components/schemas/Uuid' },
          active: { type: 'boolean', default: true },
          delivery_mode: { $ref: '#/components/schemas/ScheduleDeliveryMode' },
          batch_times: {
            type: 'array',
            items: { $ref: '#/components/schemas/TimeOfDay' },
            default: ['07:00', '15:00', '22:00']
          }
        }
      },
      Schedule: {
        type: 'object',
        properties: {
          id: { $ref: '#/components/schemas/Uuid' },
          name: { type: 'string' },
          feed_id: { $ref: '#/components/schemas/Uuid', nullable: true },
          template_id: { $ref: '#/components/schemas/Uuid', nullable: true },
          target_ids: {
            type: 'array',
            items: { $ref: '#/components/schemas/Uuid' }
          },
          cron_expression: { type: 'string', nullable: true },
          timezone: { type: 'string' },
          active: { type: 'boolean' },
          delivery_mode: { $ref: '#/components/schemas/ScheduleDeliveryMode' },
          batch_times: { type: 'array', items: { $ref: '#/components/schemas/TimeOfDay' } },
          last_run_at: { $ref: '#/components/schemas/IsoDateTime', nullable: true },
          next_run_at: { $ref: '#/components/schemas/IsoDateTime', nullable: true },
          last_queued_at: { $ref: '#/components/schemas/IsoDateTime', nullable: true },
          last_dispatched_at: { $ref: '#/components/schemas/IsoDateTime', nullable: true },
          created_at: { $ref: '#/components/schemas/IsoDateTime' },
          updated_at: { $ref: '#/components/schemas/IsoDateTime' },
          feed: { $ref: '#/components/schemas/FeedSummary', nullable: true },
          template: { $ref: '#/components/schemas/TemplateSummary', nullable: true },
          targets: { type: 'array', items: { $ref: '#/components/schemas/TargetSummary' } }
        }
      }
    }
  },
  paths: {
    '/health': {
      get: {
        tags: ['system'],
        summary: 'Health check',
        responses: { 200: { description: 'OK' } }
      }
    },
    '/ping': {
      get: {
        tags: ['system'],
        summary: 'Ping',
        responses: { 200: { description: 'OK' } }
      }
    },
    '/ready': {
      get: {
        tags: ['system'],
        summary: 'Readiness',
        responses: { 200: { description: 'OK' } }
      }
    },
    '/api/whatsapp/status': {
      get: { tags: ['whatsapp'], summary: 'Get WhatsApp status', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/qr': {
      get: { tags: ['whatsapp'], summary: 'Get WhatsApp QR code', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/groups': {
      get: { tags: ['whatsapp'], summary: 'List WhatsApp groups', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/channels': {
      get: { tags: ['whatsapp'], summary: 'List WhatsApp channels', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/channels/diagnostics': {
      get: { tags: ['whatsapp'], summary: 'List WhatsApp channels with diagnostics', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/disconnect': {
      post: { tags: ['whatsapp'], summary: 'Disconnect WhatsApp', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/hard-refresh': {
      post: { tags: ['whatsapp'], summary: 'Hard refresh WhatsApp session', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/takeover': {
      post: { tags: ['whatsapp'], summary: 'Take over WhatsApp session lease', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/send-test': {
      post: { tags: ['whatsapp'], summary: 'Send test message', responses: { 200: { description: 'OK' } } }
    },
    '/api/whatsapp/send-status': {
      post: { tags: ['whatsapp'], summary: 'Send status broadcast', responses: { 200: { description: 'OK' } } }
    },
    '/api/feeds': {
      get: { tags: ['feeds'], summary: 'List feeds', responses: { 200: { description: 'OK' } } },
      post: { tags: ['feeds'], summary: 'Create feed', responses: { 200: { description: 'OK' } } }
    },
    '/api/feeds/test': {
      post: { tags: ['feeds'], summary: 'Test feed', responses: { 200: { description: 'OK' } } }
    },
    '/api/feeds/{id}': {
      put: { tags: ['feeds'], summary: 'Update feed', responses: { 200: { description: 'OK' } } },
      delete: { tags: ['feeds'], summary: 'Delete feed', responses: { 200: { description: 'OK' } } }
    },
    '/api/feeds/{id}/refresh': {
      post: { tags: ['feeds'], summary: 'Refresh feed', responses: { 200: { description: 'OK' } } }
    },
    '/api/templates': {
      get: { tags: ['templates'], summary: 'List templates', responses: { 200: { description: 'OK' } } },
      post: { tags: ['templates'], summary: 'Create template', responses: { 200: { description: 'OK' } } }
    },
    '/api/templates/{id}': {
      put: { tags: ['templates'], summary: 'Update template', responses: { 200: { description: 'OK' } } },
      delete: { tags: ['templates'], summary: 'Delete template', responses: { 200: { description: 'OK' } } }
    },
    '/api/templates/available-variables': {
      get: { tags: ['templates'], summary: 'List template variables', responses: { 200: { description: 'OK' } } }
    },
    '/api/targets': {
      get: { tags: ['targets'], summary: 'List targets', responses: { 200: { description: 'OK' } } },
      post: { tags: ['targets'], summary: 'Create target', responses: { 200: { description: 'OK' } } }
    },
    '/api/targets/{id}': {
      put: { tags: ['targets'], summary: 'Update target', responses: { 200: { description: 'OK' } } },
      delete: { tags: ['targets'], summary: 'Delete target', responses: { 200: { description: 'OK' } } }
    },
    '/api/schedules': {
      get: {
        tags: ['schedules'],
        summary: 'List schedules',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Schedule' } }
              }
            }
          }
        }
      },
      post: {
        tags: ['schedules'],
        summary: 'Create schedule',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ScheduleInput' }
            }
          }
        },
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Schedule' }
              }
            }
          }
        }
      }
    },
    '/api/schedules/{id}': {
      put: {
        tags: ['schedules'],
        summary: 'Update schedule',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ScheduleInput' }
            }
          }
        },
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Schedule' }
              }
            }
          }
        }
      },
      delete: { tags: ['schedules'], summary: 'Delete schedule', responses: { 200: { description: 'OK' } } }
    },
    '/api/schedules/{id}/dispatch': {
      post: { tags: ['schedules'], summary: 'Dispatch schedule', responses: { 200: { description: 'OK' } } }
    },
    '/api/schedules/{id}/diagnostics': {
      get: { tags: ['schedules'], summary: 'Schedule diagnostics', responses: { 200: { description: 'OK' } } }
    },
    '/api/queue': {
      get: { tags: ['queue'], summary: 'List queue', responses: { 200: { description: 'OK' } } }
    },
    '/api/queue/clear': {
      delete: { tags: ['queue'], summary: 'Clear queue', responses: { 200: { description: 'OK' } } }
    },
    '/api/queue/retry-failed': {
      post: { tags: ['queue'], summary: 'Retry failed queue items', responses: { 200: { description: 'OK' } } }
    },
    '/api/queue/stats': {
      get: { tags: ['queue'], summary: 'Queue stats', responses: { 200: { description: 'OK' } } }
    },
    '/api/queue/{id}': {
      delete: { tags: ['queue'], summary: 'Delete queue item', responses: { 200: { description: 'OK' } } }
    },
    '/api/logs': {
      get: { tags: ['logs'], summary: 'List logs', responses: { 200: { description: 'OK' } } }
    },
    '/api/feed-items': {
      get: { tags: ['feeds'], summary: 'List feed items', responses: { 200: { description: 'OK' } } }
    },
    '/api/feed-items/by-feed/{feedId}': {
      get: { tags: ['feeds'], summary: 'List feed items by feed', responses: { 200: { description: 'OK' } } }
    },
    '/api/feed-items/available-fields': {
      get: { tags: ['feeds'], summary: 'List feed item fields', responses: { 200: { description: 'OK' } } }
    },
    '/api/settings': {
      get: { tags: ['settings'], summary: 'Get settings', responses: { 200: { description: 'OK' } } },
      put: { tags: ['settings'], summary: 'Update settings', responses: { 200: { description: 'OK' } } }
    },
    '/api/shabbos/status': {
      get: { tags: ['shabbos'], summary: 'Get Shabbos status', responses: { 200: { description: 'OK' } } }
    },
    '/api/shabbos/upcoming': {
      get: { tags: ['shabbos'], summary: 'Get upcoming Shabbos', responses: { 200: { description: 'OK' } } }
    },
    '/api/shabbos/settings': {
      get: { tags: ['shabbos'], summary: 'Get Shabbos settings', responses: { 200: { description: 'OK' } } },
      put: { tags: ['shabbos'], summary: 'Update Shabbos settings', responses: { 200: { description: 'OK' } } }
    }
  }
};

module.exports = spec;
export {};
