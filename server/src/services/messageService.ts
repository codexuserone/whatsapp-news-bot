const { getSupabaseClient } = require('../db/supabase');
const { extractText, extractUrls } = require('../utils/messageParser');

type BaileysMessage = {
  key?: { remoteJid?: string; id?: string; fromMe?: boolean };
  message?: Record<string, unknown>;
  messageTimestamp?: number | string;
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
    const timestamp = message.messageTimestamp 
      ? new Date(Number(message.messageTimestamp) * 1000).toISOString() 
      : new Date().toISOString();

    const base = {
      remote_jid: jid,
      whatsapp_id: message.key.id,
      from_me: Boolean(message.key.fromMe),
      content: text,
      message_type: 'text',
      timestamp,
      raw_message: message
    };

    if (urls.length === 0) {
      entries.push(base);
    } else {
      urls.forEach((url: string) => {
        entries.push({
          ...base,
          media_url: url
        });
      });
    }
  }

  if (entries.length) {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    
    try {
      await supabase.from('chat_messages').insert(entries);
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
