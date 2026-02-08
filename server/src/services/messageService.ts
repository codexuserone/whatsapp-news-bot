const { getSupabaseClient } = require('../db/supabase');
const { extractText, extractUrls } = require('../utils/messageParser');

type BaileysMessage = {
  key?: { remoteJid?: string; id?: string; fromMe?: boolean };
  message?: Record<string, unknown>;
  messageTimestamp?: number | string | { low?: number; high?: number; unsigned?: boolean };
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
  saveIncomingMessages,
  hasRecentUrl
};
export {};
