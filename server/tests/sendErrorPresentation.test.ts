import { describe, expect, it } from '@jest/globals';

const { sanitizeSendErrorForApi } = require('../src/utils/sendErrorPresentation');

describe('sanitizeSendErrorForApi', () => {
  it('hides raw WhatsApp confirmation internals from operator APIs', () => {
    expect(
      sanitizeSendErrorForApi(
        'Send result is uncertain. Verifying delivery before retrying. Message send not confirmed (Server ack not observed)'
      )
    ).toBe('WhatsApp did not confirm this send. It was not counted as sent.');

    expect(sanitizeSendErrorForApi('Server ack was not observed yet')).toBe(
      'WhatsApp did not confirm this send. It was not counted as sent.'
    );
  });

  it('keeps actionable send errors intact', () => {
    expect(sanitizeSendErrorForApi('Channel image was rejected by WhatsApp (WhatsApp server rejected message ack 479)')).toBe(
      'Channel image was rejected by WhatsApp (WhatsApp server rejected message ack 479)'
    );
  });

  it('removes false accepted wording before returning the remaining reason', () => {
    expect(
      sanitizeSendErrorForApi('WhatsApp accepted the send, but no delivery receipt has arrived yet. Unsupported attachment')
    ).toBe('Unsupported attachment');
  });
});
