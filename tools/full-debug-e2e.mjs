import path from 'path';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const requireFromServer = createRequire(path.resolve('server/package.json'));
const { createClient } = requireFromServer('@supabase/supabase-js');

const BASE_URL = process.env.DEBUG_BASE_URL || 'https://whatsapp-news-bot-3-69qh.onrender.com';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TEST_GROUP_ID = process.env.TEST_GROUP_ID || '120363407220244757@g.us';
const KEEP_DEBUG_DATA = String(process.env.KEEP_DEBUG_DATA || '').toLowerCase() === 'true';

const now = new Date();
const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const PREFIX = `[E2E DEBUG ${stamp}]`;

const report = {
  startedAt: now.toISOString(),
  finishedAt: null,
  baseUrl: BASE_URL,
  prefix: PREFIX,
  blockers: [],
  findings: [],
  steps: []
};

const created = {
  feeds: [],
  templates: [],
  schedules: [],
  targets: []
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const summarize = (value, max = 1200) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const pushStep = (name, ok, data, error) => {
  report.steps.push({
    name,
    ok,
    data: data === undefined ? undefined : summarize(data),
    error: error ? summarize(error) : undefined,
    at: new Date().toISOString()
  });
};

const pushFinding = (severity, title, details) => {
  report.findings.push({ severity, title, details, at: new Date().toISOString() });
};

const pushBlocker = (title, details) => {
  report.blockers.push({ title, details, at: new Date().toISOString() });
};

const apiRequest = async (method, route, body, expectedStatuses = [200], timeoutMs = 45000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      'content-type': 'application/json'
    },
    signal: controller.signal,
    body: body === undefined ? undefined : JSON.stringify(body)
  }).finally(() => clearTimeout(timeoutId));

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${method} ${route} failed (${response.status}): ${summarize(parsed)}`);
  }

  return {
    status: response.status,
    data: parsed
  };
};

const step = async (name, handler) => {
  try {
    const data = await handler();
    pushStep(name, true, data, null);
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushStep(name, false, null, message);
    return null;
  }
};

const withRetry = async (attempts, delayMs, handler) => {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await handler();
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
};

const upsertNamedTarget = async (targets, type, namePattern, fallbackPayload) => {
  const existing = targets.find((target) => target.type === type && namePattern.test(String(target.name || '')));
  if (existing) return existing;
  if (!fallbackPayload) return null;
  const createdTarget = await apiRequest('POST', '/api/targets', fallbackPayload, [200, 201]);
  const target = createdTarget.data;
  if (target?.id) created.targets.push(target.id);
  return target;
};

const cleanupCreatedData = async () => {
  if (KEEP_DEBUG_DATA) {
    pushFinding('info', 'Cleanup skipped', 'KEEP_DEBUG_DATA=true so temporary debug entities were kept.');
    return;
  }

  const cleanup = async (kind, ids, route) => {
    for (const id of ids.reverse()) {
      try {
        let deleted = false;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const response = await apiRequest('DELETE', `${route}/${id}`, undefined, [200, 204, 429]);
          if (response.status !== 429) {
            deleted = true;
            break;
          }
          const retryAfterSec = Number(response.data?.retryAfter || 2);
          if (attempt < 4) {
            await sleep(Math.max(retryAfterSec, 1) * 1000);
          }
        }

        if (!deleted) {
          throw new Error(`DELETE ${route}/${id} rate-limited repeatedly`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushFinding('warning', `Cleanup failed (${kind})`, `${id}: ${message}`);
      }
    }
  };

  await cleanup('schedule', created.schedules, '/api/schedules');
  await cleanup('template', created.templates, '/api/templates');
  await cleanup('feed', created.feeds, '/api/feeds');
  await cleanup('target', created.targets, '/api/targets');
};

const run = async () => {
  const startTimeMs = Date.now();
  const initialSettings = await step('GET /api/settings (baseline)', async () => {
    const response = await apiRequest('GET', '/api/settings');
    return response.data;
  });

  await step('GET /health', async () => (await apiRequest('GET', '/health')).data);
  await step('GET /ready', async () => (await apiRequest('GET', '/ready')).data);

  let whatsappStatus = await step('GET /api/whatsapp/status', async () => {
    const response = await apiRequest('GET', '/api/whatsapp/status');
    return response.data;
  });

  if (!whatsappStatus || whatsappStatus.status !== 'connected') {
    await step('WhatsApp auto-recovery wait', async () => {
      const initialStatus = whatsappStatus?.status || 'unknown';

      if (initialStatus === 'conflict') {
        try {
          await apiRequest('POST', '/api/whatsapp/takeover', {}, [200, 400]);
        } catch {
          // continue polling status below
        }
      }

      for (let attempt = 1; attempt <= 8; attempt += 1) {
        await sleep(3000);
        const latest = await apiRequest('GET', '/api/whatsapp/status');
        whatsappStatus = latest.data;
        if (whatsappStatus?.status === 'connected') break;
        if (attempt === 3 && whatsappStatus?.status === 'conflict') {
          try {
            await apiRequest('POST', '/api/whatsapp/takeover', {}, [200, 400]);
          } catch {
            // ignore and continue polling
          }
        }
      }

      return {
        initial: initialStatus,
        final: whatsappStatus?.status || 'unknown'
      };
    });
  }

  if (!whatsappStatus || whatsappStatus.status !== 'connected') {
    pushBlocker(
      'WhatsApp is not connected',
      `Current status is "${whatsappStatus?.status || 'unknown'}". End-to-end message delivery to PM/group/channel is blocked until QR is scanned.`
    );
  }

  const statusUpdatePayload = {
    default_timezone: 'Asia/Jerusalem',
    message_delay_ms: 2100,
    send_timeout_ms: 47000,
    max_pending_age_hours: 72,
    dedupeThreshold: 0.91,
    app_name: `${PREFIX} app`
  };

  await step('PUT /api/settings (varied configuration test)', async () => {
    const updated = await apiRequest('PUT', '/api/settings', statusUpdatePayload);
    return {
      requested: statusUpdatePayload,
      persisted: {
        default_timezone: updated.data.default_timezone,
        message_delay_ms: updated.data.message_delay_ms,
        send_timeout_ms: updated.data.send_timeout_ms,
        max_pending_age_hours: updated.data.max_pending_age_hours,
        dedupeThreshold: updated.data.dedupeThreshold,
        app_name: updated.data.app_name
      }
    };
  });

  await step('GET /api/settings (verify round-trip)', async () => {
    const check = await apiRequest('GET', '/api/settings');
    const current = check.data;
    const mismatches = Object.entries(statusUpdatePayload)
      .filter(([key, value]) => String(current?.[key]) !== String(value))
      .map(([key, value]) => `${key}: expected ${value}, got ${current?.[key]}`);

    if (mismatches.length) {
      pushFinding('warning', 'Settings round-trip mismatch', mismatches.join('; '));
    }

    return { mismatches };
  });

  const feedTests = [
    {
      label: 'RSS - Anash main feed',
      payload: { url: 'https://anash.org/feed', type: 'rss' },
      expectedStatuses: [200]
    },
    {
      label: 'JSON - Anash status API (custom parse config)',
      payload: {
        url: 'https://anash.org/wp-json/wp/v2/anash_status?_embed=1',
        type: 'json',
        parse_config: {
          titlePath: 'title.rendered',
          descriptionPath: 'excerpt.rendered',
          linkPath: 'link',
          imagePath: '_embedded.wp:featuredmedia.0.source_url'
        }
      },
      expectedStatuses: [200]
    },
    {
      label: 'Safety - private URL must be blocked',
      payload: { url: 'http://127.0.0.1/feed', type: 'rss' },
      expectedStatuses: [400]
    },
    {
      label: 'Error handling - invalid host',
      payload: { url: 'https://example.invalid/feed', type: 'rss' },
      expectedStatuses: [400, 404, 500]
    }
  ];

  for (const testCase of feedTests) {
    await step(`POST /api/feeds/test - ${testCase.label}`, async () => {
      const response = await apiRequest('POST', '/api/feeds/test', testCase.payload, testCase.expectedStatuses);
      return response.data;
    });
  }

  const createdFeedRss = await step('POST /api/feeds - create RSS feed', async () => {
    const response = await apiRequest('POST', '/api/feeds', {
      name: `${PREFIX} RSS`,
      url: 'https://anash.org/feed',
      type: 'rss',
      active: true,
      fetch_interval: 300,
      cleaning: {
        stripUtm: true,
        decodeEntities: true,
        removePhrases: ['Read More']
      }
    }, [200, 201]);
    if (response.data?.id) created.feeds.push(response.data.id);
    return response.data;
  });

  const createdFeedJson = await step('POST /api/feeds - create JSON feed', async () => {
    const response = await apiRequest('POST', '/api/feeds', {
      name: `${PREFIX} JSON`,
      url: 'https://anash.org/wp-json/wp/v2/anash_status?_embed=1',
      type: 'json',
      active: true,
      fetch_interval: 600,
      parse_config: {
        titlePath: 'title.rendered',
        descriptionPath: 'excerpt.rendered',
        linkPath: 'link',
        imagePath: '_embedded.wp:featuredmedia.0.source_url'
      }
    }, [200, 201]);
    if (response.data?.id) created.feeds.push(response.data.id);
    return response.data;
  });

  for (const feed of [createdFeedRss, createdFeedJson].filter(Boolean)) {
    await step(`POST /api/feeds/${feed.id}/refresh`, async () => {
      let response = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const current = await apiRequest('POST', `/api/feeds/${feed.id}/refresh`, {}, [200, 429]);
        if (current.status !== 429) {
          response = current;
          break;
        }

        const retryAfterSec = Number(current.data?.retryAfter || 2);
        if (attempt >= 3) {
          throw new Error(`Feed refresh rate-limited after ${attempt} attempts`);
        }
        await sleep(Math.max(retryAfterSec, 1) * 1000);
      }

      if (!response) {
        throw new Error('Feed refresh returned no response');
      }

      if (!response.data?.insertedCount && !response.data?.duplicateCount) {
        pushFinding('warning', 'Feed refresh returned no parsed items', `Feed ${feed.name} returned empty refresh payload.`);
      }
      return response.data;
    });
  }

  const templateModes = [
    { mode: 'image', send_images: true, content: '*{{title}}*\n\n{{link}}' },
    { mode: 'image_only', send_images: false, content: '{{title}}' },
    { mode: 'link_preview', send_images: false, content: '{{title}}\n{{link}}' },
    { mode: 'text_only', send_images: false, content: '{{title}}\n{{description}}' }
  ];

  const createdTemplates = [];
  const createdTemplateMeta = [];
  for (const item of templateModes) {
    const template = await step(`POST /api/templates - ${item.mode}`, async () => {
      const response = await apiRequest('POST', '/api/templates', {
        name: `${PREFIX} ${item.mode}`,
        content: item.content,
        description: `mode=${item.mode}`,
        active: true,
        send_mode: item.mode,
        send_images: item.send_images
      }, [200, 201]);
      if (response.data?.id) created.templates.push(response.data.id);
      return response.data;
    });
    if (template) {
      createdTemplates.push(template);
      createdTemplateMeta.push({
        id: template.id,
        expectedMode: item.mode,
        name: template.name
      });
    }
  }

  await step('GET /api/templates - verify send_mode persistence', async () => {
    const response = await apiRequest('GET', '/api/templates');
    const relevant = (response.data || []).filter((template) => String(template.name || '').startsWith(PREFIX));
    const expectedById = new Map(createdTemplateMeta.map((entry) => [String(entry.id), entry.expectedMode]));
    const mismatches = relevant
      .map((template) => {
        const expectedMode = expectedById.get(String(template.id));
        return {
          id: template.id,
          name: template.name,
          expectedMode,
          send_mode: template.send_mode,
          send_images: template.send_images
        };
      })
      .filter((template) => template.expectedMode && template.send_mode !== template.expectedMode);

    if (mismatches.length) {
      pushFinding(
        'high',
        'Template mode persistence bug',
        `Templates created with send_mode are not persisted correctly: ${JSON.stringify(mismatches)}`
      );
    }

    return { checked: relevant.length, mismatches };
  });

  const allTargets = await step('GET /api/targets', async () => (await apiRequest('GET', '/api/targets')).data || []);
  const channels = await step('GET /api/whatsapp/channels', async () => (await apiRequest('GET', '/api/whatsapp/channels')).data || []);
  const groups = await step('GET /api/whatsapp/groups', async () => {
    const response = await withRetry(3, 2000, async () => apiRequest('GET', '/api/whatsapp/groups'));
    return response.data || [];
  });

  let targets = Array.isArray(allTargets) ? allTargets : [];

  let groupTarget = targets.find((target) => target.type === 'group' && /test/i.test(String(target.name || '')));
  if (!groupTarget) {
    groupTarget = await upsertNamedTarget(targets, 'group', /test/i, {
      name: `${PREFIX} test`,
      phone_number: TEST_GROUP_ID,
      type: 'group',
      active: true,
      notes: 'Created by full debug script'
    });
    if (groupTarget) targets = [groupTarget, ...targets];
  }

  let channelTarget = targets.find((target) => target.type === 'channel' && /test/i.test(String(target.name || '')));
  if (!channelTarget) {
    const discovered = (channels || []).find((channel) => /test/i.test(String(channel.name || '')));
    if (discovered) {
      channelTarget = await upsertNamedTarget(targets, 'channel', /test/i, {
        name: `${PREFIX} channel test`,
        phone_number: discovered.jid,
        type: 'channel',
        active: true,
        notes: 'Created from discovered channel list'
      });
      if (channelTarget) targets = [channelTarget, ...targets];
    }
  }

  let pmTarget = targets.find((target) => target.type === 'individual' && /\b(me|myself|self)\b/i.test(String(target.name || '')));
  const meJidRaw = whatsappStatus?.me?.jid || null;
  const meJid = typeof meJidRaw === 'string'
    ? meJidRaw.replace(/:\d+(?=@s\.whatsapp\.net$)/, '')
    : null;
  if (!pmTarget && meJid) {
    pmTarget = await upsertNamedTarget(targets, 'individual', /\b(me|myself|self)\b/i, {
      name: `${PREFIX} me`,
      phone_number: meJid,
      type: 'individual',
      active: true,
      notes: 'Created for PM end-to-end test'
    });
    if (pmTarget) targets = [pmTarget, ...targets];
  }

  if (!pmTarget) {
    pushBlocker('PM target not available', 'Could not infer self JID while WhatsApp is disconnected/QR.');
  }
  if (!groupTarget) {
    pushBlocker('Group target not available', 'No group target matching "test" was found or created.');
  }
  if (!channelTarget) {
    pushBlocker('Channel target not available', 'No channel target matching "test" was discoverable while disconnected.');
  }

  const chosenFeed = createdFeedRss || createdFeedJson;
  const chosenTemplate = createdTemplates[0] || null;
  const targetForSchedule = groupTarget || pmTarget || channelTarget || null;

  let immediateSchedule = null;
  let batchSchedule = null;

  if (chosenFeed && chosenTemplate && targetForSchedule) {
    immediateSchedule = await step('POST /api/schedules - immediate schedule', async () => {
      const response = await apiRequest('POST', '/api/schedules', {
        name: `${PREFIX} immediate`,
        cron_expression: null,
        timezone: 'Asia/Jerusalem',
        feed_id: chosenFeed.id,
        target_ids: [targetForSchedule.id],
        template_id: chosenTemplate.id,
        active: true,
        delivery_mode: 'immediate',
        batch_times: ['07:00', '15:00', '22:00']
      }, [200, 201]);
      if (response.data?.id) created.schedules.push(response.data.id);
      return response.data;
    });

    batchSchedule = await step('POST /api/schedules - batch schedule', async () => {
      const response = await apiRequest('POST', '/api/schedules', {
        name: `${PREFIX} batch`,
        cron_expression: '*/15 * * * *',
        timezone: 'UTC',
        feed_id: chosenFeed.id,
        target_ids: [targetForSchedule.id],
        template_id: chosenTemplate.id,
        active: true,
        delivery_mode: 'batch',
        batch_times: ['07:00', '12:00', '18:00']
      }, [200, 201]);
      if (response.data?.id) created.schedules.push(response.data.id);
      return response.data;
    });
  } else {
    pushBlocker(
      'Schedule creation skipped',
      'Need at least one feed, one template, and one valid target to run queue/schedule end-to-end tests.'
    );
  }

  if (immediateSchedule?.id) {
    await step('POST /api/schedules/:id/queue-latest', async () => {
      const response = await apiRequest('POST', `/api/schedules/${immediateSchedule.id}/queue-latest`, {});
      return response.data;
    });

    const queueItems = await step('GET /api/queue?status=pending&include_manual=true', async () => {
      const response = await apiRequest('GET', '/api/queue?status=pending&include_manual=true');
      return response.data;
    });

    const queuedItem = Array.isArray(queueItems)
      ? queueItems.find((item) => String(item.schedule_id || '') === String(immediateSchedule.id))
      : null;

    if (queuedItem?.id) {
      await step('PATCH /api/queue/:id message edit', async () => {
        const response = await apiRequest('PATCH', `/api/queue/${queuedItem.id}`, {
          message_content: `${PREFIX} edited queue message`
        });
        return response.data;
      });

      await step('POST /api/queue/:id/pause', async () => {
        const response = await apiRequest('POST', `/api/queue/${queuedItem.id}/pause`, {}, [200, 400]);
        return response.data;
      });

      await step('POST /api/queue/:id/resume', async () => {
        const response = await apiRequest('POST', `/api/queue/${queuedItem.id}/resume`, {}, [200, 400]);
        return response.data;
      });

      await step('POST /api/queue/:id/send-now', async () => {
        const expected = whatsappStatus?.status === 'connected' ? [200] : [400];
        const response = await apiRequest('POST', `/api/queue/${queuedItem.id}/send-now`, {}, expected);
        return response.data;
      });
    } else {
      pushFinding('warning', 'Queue item not found for immediate schedule', 'queue-latest returned no identifiable queue item.');
    }

    await step('POST /api/schedules/:id/dispatch', async () => {
      const expected = whatsappStatus?.status === 'connected' ? [200] : [200, 500];
      const response = await apiRequest('POST', `/api/schedules/${immediateSchedule.id}/dispatch`, {}, expected, 120000);
      return response.data;
    });
  }

  if (whatsappStatus?.status === 'connected') {
    const sendTargets = [
      { label: 'PM (me)', target: pmTarget, payload: { message: `${PREFIX} PM test message`, confirm: true } },
      {
        label: 'Group (test)',
        target: groupTarget,
        payload: {
          message: `${PREFIX} group test message`,
          linkUrl: 'https://anash.org',
          confirm: true
        }
      },
      {
        label: 'Channel (test)',
        target: channelTarget,
        payload: {
          message: `${PREFIX} channel test message`,
          imageUrl: 'https://files.anash.org/uploads/2026/02/283A2988-768x512.jpg',
          includeCaption: true,
          confirm: true
        }
      }
    ];

    for (const send of sendTargets) {
      if (!send.target?.phone_number) {
        pushBlocker(`${send.label} send skipped`, 'Target is missing.');
        continue;
      }

      await step(`POST /api/whatsapp/send-test - ${send.label}`, async () => {
        const response = await apiRequest('POST', '/api/whatsapp/send-test', {
          jid: send.target.phone_number,
          ...send.payload
        });
        return response.data;
      });

      await sleep(2000);
    }
  } else {
    await step('POST /api/whatsapp/send-test while disconnected', async () => {
      const response = await apiRequest(
        'POST',
        '/api/whatsapp/send-test',
        {
          jid: groupTarget?.phone_number || TEST_GROUP_ID,
          message: `${PREFIX} disconnected-state test`
        },
        [400]
      );
      return response.data;
    });
  }

  await step('GET /api/queue/stats?include_manual=true', async () => {
    const response = await apiRequest('GET', '/api/queue/stats?include_manual=true');
    return response.data;
  });

  await step('GET /api/feed-items', async () => {
    const response = await apiRequest('GET', '/api/feed-items');
    const recent = (response.data || []).slice(0, 5).map((item) => ({
      id: item.id,
      title: item.title,
      delivery_status: item.delivery_status,
      sent: item.sent
    }));
    return recent;
  });

  await step('GET /api/logs', async () => {
    const response = await apiRequest('GET', '/api/logs');
    const recent = (response.data || []).slice(0, 8).map((log) => ({
      id: log.id,
      status: log.status,
      target: log.target?.name || log.target_id,
      whatsapp_message_id: log.whatsapp_message_id || null,
      error_message: log.error_message || null,
      created_at: log.created_at
    }));
    return recent;
  });

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    await step('Supabase direct verification (service role)', async () => {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
      });

      const [targetsRes, feedsRes, templatesRes, schedulesRes, logsRes] = await Promise.all([
        supabase.from('targets').select('id,name,type,phone_number,active').ilike('name', `${PREFIX}%`),
        supabase.from('feeds').select('id,name,type,active,last_error').ilike('name', `${PREFIX}%`),
        supabase.from('templates').select('id,name,send_mode,send_images,active').ilike('name', `${PREFIX}%`),
        supabase.from('schedules').select('id,name,delivery_mode,batch_times,active').ilike('name', `${PREFIX}%`),
        supabase.from('message_logs').select('id,status,error_message,whatsapp_message_id,created_at').order('created_at', { ascending: false }).limit(10)
      ]);

      return {
        targets: targetsRes.data || [],
        feeds: feedsRes.data || [],
        templates: templatesRes.data || [],
        schedules: schedulesRes.data || [],
        recentLogs: logsRes.data || []
      };
    });
  } else {
    pushBlocker('Supabase direct verification skipped', 'SUPABASE_URL or SUPABASE_SERVICE_KEY not provided in environment.');
  }

  if (RENDER_API_KEY) {
    await step('Render log scan around test window', async () => {
      const serviceId = 'srv-d5ve1n7fte5s73clqk40';
      const ownerId = 'tea-d5s8bu7gi27c73dov380';
      const url = `https://api.render.com/v1/logs?ownerId=${ownerId}&resource=${serviceId}&limit=500`;
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${RENDER_API_KEY}`,
          accept: 'application/json'
        }
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(`Render logs API failed (${response.status}): ${summarize(body)}`);
      }

      const windowStart = startTimeMs - 5000;
      const logs = (body.logs || [])
        .filter((entry) => Date.parse(entry.timestamp || '') >= windowStart)
        .map((entry) => ({ timestamp: entry.timestamp, message: String(entry.message || '') }))
        .filter((entry) => entry.message.trim());

      const benignPatterns = [
        /Feed deleted during processing, aborting current feed run/i,
        /Image buffer send unavailable; trying URL-based send/i,
        /Image URL send rejected; using text fallback/i,
        /Skipping unsupported image type and falling back to text/i,
        /Input file contains unsupported image format/i,
        /Baileys skipped thumbnail generation for one media payload/i
      ];
      const errors = logs
        .filter((entry) => /error|failed|exception|module_not_found|rate-overlimit/i.test(entry.message))
        .filter((entry) => !benignPatterns.some((pattern) => pattern.test(entry.message)));
      if (errors.length) {
        pushFinding('warning', 'Render log errors detected during test run', summarize(errors.slice(0, 5)));
      }

      return {
        totalLogsInWindow: logs.length,
        errorLikeLogs: errors.slice(0, 10)
      };
    });
  } else {
    pushBlocker('Render log scan skipped', 'RENDER_API_KEY not provided in environment.');
  }

  if (GITHUB_TOKEN) {
    await step('GitHub main branch verification', async () => {
      const localHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      const response = await fetch('https://api.github.com/repos/codexuserone/whatsapp-news-bot/branches/main', {
        headers: {
          authorization: `Bearer ${GITHUB_TOKEN}`,
          accept: 'application/vnd.github+json'
        }
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(`GitHub API failed (${response.status}): ${summarize(body)}`);
      }
      const remoteHead = String(body?.commit?.sha || '');
      if (remoteHead && !localHead.startsWith(remoteHead.slice(0, 7)) && !remoteHead.startsWith(localHead.slice(0, 7))) {
        pushFinding('warning', 'Local/remote main mismatch', `local=${localHead}, remote=${remoteHead}`);
      }
      return {
        localHead,
        remoteHead,
        branchProtected: body?.protected || false
      };
    });
  } else {
    pushBlocker('GitHub verification skipped', 'GITHUB_TOKEN not provided in environment.');
  }

  if (initialSettings) {
    await step('PUT /api/settings (restore original values)', async () => {
      const restorePayload = {
        default_timezone: initialSettings.default_timezone,
        message_delay_ms: initialSettings.message_delay_ms,
        send_timeout_ms: initialSettings.send_timeout_ms,
        max_pending_age_hours: initialSettings.max_pending_age_hours,
        dedupeThreshold: initialSettings.dedupeThreshold,
        app_name: initialSettings.app_name
      };
      const response = await apiRequest('PUT', '/api/settings', restorePayload, [200]);
      return response.data;
    });
  }

  await cleanupCreatedData();
};

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    pushStep('fatal', false, null, message);
  })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    const summary = {
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      totalSteps: report.steps.length,
      passedSteps: report.steps.filter((stepResult) => stepResult.ok).length,
      failedSteps: report.steps.filter((stepResult) => !stepResult.ok).length,
      blockers: report.blockers.length,
      findings: report.findings.length
    };

    console.log(JSON.stringify({ summary, report }, null, 2));
    if (summary.failedSteps > 0) {
      process.exitCode = 1;
    }
  });
