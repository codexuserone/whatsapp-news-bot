const { getSupabaseClient } = require('../db/supabase');
const { extractText, extractUrls } = require('../utils/messageParser');

type BaileysMessage = {
  key?: { remoteJid?: string; id?: string; fromMe?: boolean };
  message?: Record<string, unknown>;
  messageTimestamp?: number | string | { low?: number; high?: number; unsigned?: boolean };
};

type AckClassification = {
  normalizedStatus: number;
  statusLabel: 'pending' | 'server_ack' | 'delivered' | 'read' | 'played';
  delivered: boolean;
  read: boolean;
};

const toMessageTimestampIso = (value: BaileysMessage['messageTimestamp']) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return new Date(parsed * 1000).toISOString();
    }
  }

  if (value && typeof value === 'object') {
    const low = Number((value as { low?: unknown }).low);
    if (Number.isFinite(low) && low > 0) {
      return new Date(low * 1000).toISOString();
    }
  }

  return new Date().toISOString();
};

const classifyAckStatus = (status: unknown): AckClassification => {
  const normalizedStatus = Math.max(0, Math.floor(Number(status) || 0));

  if (normalizedStatus >= 4) {
    return {
      normalizedStatus,
      statusLabel: 'played',
      delivered: true,
      read: true
    };
  }

  if (normalizedStatus >= 3) {
    return {
      normalizedStatus,
      statusLabel: 'read',
      delivered: true,
      read: true
    };
  }

  if (normalizedStatus >= 2) {
    return {
      normalizedStatus,
      statusLabel: 'delivered',
      delivered: true,
      read: false
    };
  }

  if (normalizedStatus >= 1) {
    return {
      normalizedStatus,
      statusLabel: 'server_ack',
      delivered: false,
      read: false
    };
  }

  return {
    normalizedStatus,
    statusLabel: 'pending',
    delivered: false,
    read: false
  };
};

const persistOutgoingStatusByMessageId = async (
  messageId: string,
  status: unknown,
  remoteJid?: string | null
) => {
  const normalizedMessageId = String(messageId || '').trim();
  if (!normalizedMessageId) return null;

  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const classification = classifyAckStatus(status);
  const nowIso = new Date().toISOString();

  try {
    if (classification.read) {
      await supabase
        .from('chat_messages')
        .update({ status: 'read' })
        .eq('whatsapp_id', normalizedMessageId)
        .eq('from_me', true);

      await supabase
        .from('message_logs')
        .update({
          status: 'read',
          delivered_at: nowIso,
          read_at: nowIso
        })
        .eq('whatsapp_message_id', normalizedMessageId)
        .in('status', ['sent', 'delivered']);
    } else if (classification.delivered) {
      await supabase
        .from('chat_messages')
        .update({ status: 'delivered' })
        .eq('whatsapp_id', normalizedMessageId)
        .eq('from_me', true)
        .in('status', ['pending', 'queued', 'sent', 'server_ack', 'delivered']);

      await supabase
        .from('message_logs')
        .update({
          status: 'delivered',
          delivered_at: nowIso
        })
        .eq('whatsapp_message_id', normalizedMessageId)
        .eq('status', 'sent');
    } else if (classification.statusLabel === 'server_ack') {
      await supabase
        .from('chat_messages')
        .update({ status: 'server_ack' })
        .eq('whatsapp_id', normalizedMessageId)
        .eq('from_me', true)
        .in('status', ['pending', 'queued', 'sent', 'server_ack']);
    }

    if (remoteJid) {
      await supabase
        .from('chat_messages')
        .update({ remote_jid: remoteJid })
        .eq('whatsapp_id', normalizedMessageId)
        .eq('from_me', true)
        .is('remote_jid', null);
    }
  } catch (error) {
    console.error('Error persisting outgoing message status:', error);
  }

  return classification;
};

const saveIncomingMessages = async (messages: BaileysMessage[] = []) => {
  const entries: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (!message?.key?.remoteJid || !message?.key?.id) {
      continue;
    }

    const jid = message.key.remoteJid;
    const text = extractText(message.message as Record<string, unknown>);
    const urls = extractUrls(text) as string[];
    const timestamp = toMessageTimestampIso(message.messageTimestamp);

    const base = {
      remote_jid: jid,
      whatsapp_id: message.key.id,
      from_me: Boolean(message.key.fromMe),
      content: text,
      message_type: 'text',
      timestamp,
      raw_message: message
    };

    entries.push({
      ...base,
      media_url: urls.length ? urls[0] : null
    });
  }

  if (entries.length) {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    
    try {
      await supabase
        .from('chat_messages')
        .upsert(entries, { onConflict: 'whatsapp_id', ignoreDuplicates: true });
    } catch (error) {
      console.error('Error saving incoming messages:', error);
    }
  }
};

const hasRecentUrl = async (jid: string, url: string) => {
  const supabase = getSupabaseClient();
  if (!url || !supabase) return false;
  
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('remote_jid', jid)
      .ilike('content', `%${url}%`)
      .limit(1);
    
    if (error) throw error;
    return data && data.length > 0;
  } catch (error) {
    console.error('Error checking recent URL:', error);
    return false;
  }
};

module.exports = {
  classifyAckStatus,
  persistOutgoingStatusByMessageId,
  saveIncomingMessages,
  hasRecentUrl
};
export {};
