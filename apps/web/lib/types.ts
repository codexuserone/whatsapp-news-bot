export type Feed = {
  id: string;
  name: string;
  url: string;
  type: 'rss' | 'atom' | 'json';
  active: boolean;
  fetch_interval?: number;
  last_error?: string | null;
  last_fetched_at?: string | null;
  last_success_at?: string | null;
  consecutive_failures?: number | null;
};

export type Template = {
  id: string;
  name: string;
  description?: string | null;
  content: string;
  active: boolean;
  send_images?: boolean | null;
};

export type Target = {
  id: string;
  name: string;
  phone_number: string;
  type: 'individual' | 'group' | 'channel' | 'status';
  active: boolean;
  notes?: string | null;
};

export type Schedule = {
  id: string;
  name: string;
  cron_expression?: string | null;
  timezone?: string | null;
  feed_id?: string | null;
  target_ids?: string[];
  template_id?: string | null;
  active: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
};

export type LogEntry = {
  id: string;
  status: string;
  target_id?: string | null;
  schedule_id?: string | null;
  message_content?: string | null;
  error_message?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_sent?: boolean | null;
  media_error?: string | null;
  sent_at?: string | null;
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
  image_url?: string | null;
  categories?: string[] | string | null;
  sent?: boolean | null;
  delivery?: {
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
  delivery_status?: string | null;
  feed?: { name?: string | null } | null;
};

export type QueueItem = {
  id: string;
  status: string;
  schedule_id?: string | null;
  target_id?: string | null;
  title?: string | null;
  url?: string | null;
  image_url?: string | null;
  rendered_content?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_sent?: boolean | null;
  media_error?: string | null;
  created_at?: string | null;
  sent_at?: string | null;
  scheduled_for?: string | null;
  error_message?: string | null;
};

export type QueueStats = {
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
};

export type WhatsAppStatus = {
  status: string;
  lastError?: string | null;
  lastSeenAt?: string | null;
  hasQr?: boolean;
};

export type WhatsAppGroup = {
  id: string;
  jid: string;
  name: string;
  size: number;
};

export type WhatsAppChannel = {
  id: string;
  jid: string;
  name: string;
  subscribers: number;
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
