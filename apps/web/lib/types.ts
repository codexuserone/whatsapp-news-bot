export type Feed = {
  id: string;
  name: string;
  url: string;
  type: 'rss' | 'atom' | 'json' | 'html';
  active: boolean;
  fetch_interval?: number;
  last_error?: string | null;
  last_fetched_at?: string | null;
  last_success_at?: string | null;
  consecutive_failures?: number | null;
  etag?: string | null;
  last_modified?: string | null;
  parse_config?: {
    itemsPath?: string | null;
    titlePath?: string | null;
    descriptionPath?: string | null;
    linkPath?: string | null;
    imagePath?: string | null;
  } | null;
  cleaning?: {
    stripUtm?: boolean | null;
    decodeEntities?: boolean | null;
    removePhrases?: string[] | null;
  } | null;
};

export type Template = {
  id: string;
  name: string;
  description?: string | null;
  content: string;
  active: boolean;
  send_images?: boolean | null;
  send_mode?: 'image' | 'image_only' | 'link_preview' | 'text_only' | null;
};

export type Target = {
  id: string;
  name: string;
  phone_number: string;
  type: 'individual' | 'group' | 'channel' | 'status';
  active: boolean;
  notes?: string | null;
  message_delay_ms_override?: number | null;
  inter_target_delay_sec_override?: number | null;
  intra_target_delay_sec_override?: number | null;
};

export type Schedule = {
  id: string;
  name: string;
  state?: 'active' | 'paused' | 'stopped' | 'draft' | null;
  cron_expression?: string | null;
  timezone?: string | null;
  feed_id?: string | null;
  target_ids?: string[];
  template_id?: string | null;
  delivery_mode?: 'immediate' | 'batch' | 'batched' | null;
  batch_times?: string[] | null;
  approval_required?: boolean | null;
  active: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
};

export type LogEntry = {
  id: string;
  status: string;
  target_id?: string | null;
  schedule_id?: string | null;
  whatsapp_message_id?: string | null;
  message_content?: string | null;
  error_message?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_sent?: boolean | null;
  media_error?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  played_at?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  processing_started_at?: string | null;
  created_at: string;
  target?: { name?: string | null } | null;
  schedule?: { name?: string | null } | null;
};

export type FeedItem = {
  id: string;
  feed_id?: string | null;
  title?: string | null;
  description?: string | null;
  content?: string | null;
  link?: string | null;
  author?: string | null;
  pub_date?: string | null;
  raw_data?: Record<string, unknown> | null;
  image_url?: string | null;
  categories?: string[] | string | null;
  sent?: boolean | null;
  delivery?: {
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    skipped: number;
    manual_paused?: number;
    total: number;
  } | null;
  delivery_status?: string | null;
  routing?: {
    active_automations?: number;
    dispatchable_automations?: number;
    queue_cursor_at?: string | null;
  } | null;
  feed?: { name?: string | null } | null;
};

export type QueueItem = {
  id: string;
  status: string;
  schedule_id?: string | null;
  is_manual?: boolean | null;
  target_id?: string | null;
  feed_item_id?: string | null;
  whatsapp_message_id?: string | null;
  schedule_name?: string | null;
  target_name?: string | null;
  target_type?: 'individual' | 'group' | 'channel' | 'status' | null;
  delivery_mode?: 'immediate' | 'batch' | 'batched' | null;
  batch_times?: string[] | null;
  title?: string | null;
  url?: string | null;
  pub_date?: string | null;
  pub_precision?: 'date' | 'datetime' | null | string;
  image_url?: string | null;
  rendered_content?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_sent?: boolean | null;
  media_error?: string | null;
  created_at?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  played_at?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  processing_started_at?: string | null;
  scheduled_for?: string | null;
  error_message?: string | null;
};

export type QueueStats = {
  pending: number;
  awaiting_approval?: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  queued_now?: number;
  history_window_total?: number;
  history_all_time_total?: number;
  sent_all_time?: number;
  failed_all_time?: number;
  skipped_all_time?: number;
  window_hours?: number;
  window_start?: string;
};

export type ReconcileResult = {
  processed: number;
  edited: number;
  replaced: number;
  skipped: number;
  failed: number;
  reason?: string;
};

export type WhatsAppStatus = {
  status: string;
  lastError?: string | null;
  lastSeenAt?: string | null;
  hasQr?: boolean;
  me?: {
    jid?: string | null;
    name?: string | null;
  };
};

export type WhatsAppOutboxMessage = {
  id: string;
  remoteJid?: string | null;
  fromMe?: boolean | null;
  timestamp?: number | string | null;
  hasImage?: boolean;
  hasText?: boolean;
  hasCaption?: boolean;
};

export type WhatsAppOutboxStatus = {
  id: string;
  status?: number | null;
  statusLabel?: string | null;
  remoteJid?: string | null;
  updatedAtMs?: number | null;
};

export type WhatsAppOutbox = {
  messages: WhatsAppOutboxMessage[];
  statuses: WhatsAppOutboxStatus[];
};

export type WhatsAppGroup = {
  id: string;
  jid: string;
  name: string;
  size: number;
  announce?: boolean;
  restrict?: boolean;
  participantCount?: number;
  me?: {
    jid?: string | null;
    isAdmin?: boolean;
    admin?: string | null;
  };
};

export type WhatsAppChannel = {
  id: string;
  jid: string;
  name: string;
  subscribers: number;
  role?: string | null;
  canPost?: boolean;
  source?: 'live' | 'saved' | 'verified_target';
};

export type ShabbosStatus = {
  isShabbos: boolean;
  reason?: string | null;
  endsAt?: string | null;
  nextShabbos?: { start: string; end: string } | null;
};

export type ShabbosSettings = {
  enabled: boolean;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tzid?: string | null;
  candleLightingMins?: number | null;
  havdalahMins?: number | null;
};
