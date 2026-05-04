import { describe, expect, it } from '@jest/globals';

const logsRoute = require('../src/routes/logs');

describe('logs route response helpers', () => {
  const testUtils = logsRoute.__testUtils;

  it('honors requested limits while keeping the default history cap', () => {
    expect(testUtils.parseLogLimit(undefined)).toBe(200);
    expect(testUtils.parseLogLimit('20')).toBe(20);
    expect(testUtils.parseLogLimit('1')).toBe(1);
    expect(testUtils.parseLogLimit('500')).toBe(200);
    expect(testUtils.parseLogLimit('0')).toBe(200);
  });

  it('does not expose inline attachment payloads in log responses', () => {
    expect(
      testUtils.finalizeLog({
        id: 'log-1',
        media_url: 'data:image/png;base64,AAAA'
      })
    ).toMatchObject({
      id: 'log-1',
      media_url: null,
      media_stored: true
    });

    expect(
      testUtils.finalizeLog({
        id: 'log-2',
        media_url: 'uploaded:image'
      })
    ).toMatchObject({
      id: 'log-2',
      media_url: 'uploaded:image',
      media_stored: true
    });

    expect(
      testUtils.finalizeLog({
        id: 'log-3',
        media_url: 'https://example.com/image.jpg'
      })
    ).toMatchObject({
      id: 'log-3',
      media_url: 'https://example.com/image.jpg',
      media_stored: false
    });
  });

  it('marks inactive targets in log responses', () => {
    expect(
      testUtils.finalizeLog({
        id: 'log-4',
        target_id: 'target-1',
        target: { id: 'target-1', active: false }
      })
    ).toMatchObject({
      id: 'log-4',
      target_active: false,
      target_in_current_schedule: true
    });
  });

  it('marks log targets that are no longer in the schedule', () => {
    expect(
      testUtils.finalizeLog({
        id: 'log-5',
        schedule_id: 'schedule-1',
        target_id: 'target-old',
        schedule: { id: 'schedule-1', target_ids: ['target-current'] },
        target: { id: 'target-old', active: true }
      })
    ).toMatchObject({
      id: 'log-5',
      target_active: true,
      target_in_current_schedule: false
    });
  });

  it('marks current schedule targets in log responses', () => {
    expect(
      testUtils.finalizeLog({
        id: 'log-6',
        schedule_id: 'schedule-1',
        target_id: 'target-current',
        schedule: { id: 'schedule-1', target_ids: ['target-current'] },
        target: { id: 'target-current', active: true }
      })
    ).toMatchObject({
      id: 'log-6',
      target_active: true,
      target_in_current_schedule: true
    });
  });
});
