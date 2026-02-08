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
  send_mode?: 'image' | 'link_preview' | 'text_only' | null;
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
  instanceId?: string;
  me?: { jid?: string | null; name?: string | null };
  lease?: {
    supported?: boolean;
    held?: boolean;
    ownerId?: string | null;
    expiresAt?: string | null;
  };
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
  viewerRole?: string | null;
  canSend?: boolean | null;
};

export type WhatsAppChannelDiagnosticsResponse = {
  channels: WhatsAppChannel[];
  diagnostics: {
    methodsTried: string[];
    methodErrors: string[];
    sourceCounts: {
      api: number;
      cache: number;
      metadata: number;
    };
    limitation?: string | null;
  };
};

export type WhatsAppResolveChannelResponse = {
  found: boolean;
  channel: WhatsAppChannel;
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
  queueMessages?: boolean | null;
};

export type AnalyticsWindow = {
  slot: number;
  day: number;
  dayLabel: string;
  hour: number;
  label: string;
  sentCount: number;
  failedCount: number;
  weightedSamples: number;
  posteriorMean: number;
  objective: number;
  confidence: number;
  exposureShare: number;
  explorationBonus: number;
  propensityBoost: number;
  expectedObservedRate: number;
  expectedDeliveredRate: number;
  expectedReadRate: number;
  expectedResponses24h: number;
  fatiguePenalty: number;
  pressureRatio: number;
  avgLatencySec?: number | null;
  primaryContentType: string;
};

export type AnalyticsRecommendation = {
  label: string;
  day: number;
  dayLabel: string;
  hour: number;
  time: string;
  objective: number;
  confidence: number;
  expectedObservedRate: number;
  expectedDeliveredRate: number;
  expectedReadRate: number;
  expectedResponses24h: number;
  recommendationType: 'exploit' | 'explore';
  reason: string;
};

export type AnalyticsTimelinePoint = {
  date: string;
  sent: number;
  failed: number;
  observed: number;
  responses24h: number;
  avgLatencySec?: number | null;
  avgScore: number;
  observedRate: number;
  failureRate: number;
};

export type AnalyticsTargetRisk = {
  target_id: string;
  target_name: string;
  target_type: string;
  sent: number;
  failed: number;
  observedRate: number;
  failureRate: number;
  avgResponses24h: number;
  inactivityDays: number;
  trendDrop: number;
  fatigueSignal: number;
  riskScore: number;
};

export type AnalyticsAudienceSnapshot = {
  id: string;
  target_id: string;
  target_name: string;
  target_type: string;
  source: string;
  audience_size: number;
  captured_at: string;
};

export type AnalyticsReport = {
  generatedAt: string;
  lookbackDays: number;
  filters: {
    target_id?: string | null;
    content_type?: string | null;
    tz_offset_min: number;
  };
  totals: {
    messages: number;
    attempted: number;
    sent: number;
    failed: number;
    skipped: number;
    pending: number;
    processing: number;
    observed: number;
    delivered: number;
    read: number;
    responses24h: number;
  };
  rates: {
    observedRate: number;
    deliveredRate: number;
    readRate: number;
    readToDeliveredRate: number;
    failureRate: number;
    responseRate24h: number;
    avgLatencySec?: number | null;
    avgEngagementScore: number;
  };
  dataQuality: {
    observedIdCoverage: number;
    inboundRowsScanned: number;
    inboundSignalAvailable: boolean;
    inboundRowsTruncated: boolean;
    notes: string[];
  };
  model: {
    halfLifeDays: number;
    priorAlpha: number;
    priorBeta: number;
    confidenceTarget: number;
    objectiveScore: number;
    confidence: number;
  };
  windows: AnalyticsWindow[];
  recommendations: {
    windows: AnalyticsRecommendation[];
    suggestedBatchTimes: string[];
    suggestedCron?: string | null;
  };
  timeline: AnalyticsTimelinePoint[];
  contentTypeStats: Array<{
    contentType: string;
    sent: number;
    observedRate: number;
    responseRate24h: number;
    avgScore: number;
  }>;
  targetRisks: AnalyticsTargetRisk[];
  audience: {
    snapshots: AnalyticsAudienceSnapshot[];
    latestByTarget: Array<{
      target_id: string;
      target_name: string;
      target_type: string;
      audience_size: number;
      growth7d?: number | null;
      captured_at: string;
    }>;
    totalAudienceLatest: number;
  };
};

export type AnalyticsScheduleRecommendation = {
  schedule_id: string;
  schedule_name: string;
  timezone: string;
  delivery_mode: string;
  default_apply_mode: 'cron' | 'batch';
  current_cron_expression?: string | null;
  current_batch_times: string[];
  primary_target_id?: string | null;
  primary_target_name?: string | null;
  recommended_cron?: string | null;
  recommended_batch_times: string[];
  objective_score: number;
  confidence: number;
  rationale: string;
};

export type AnalyticsScheduleRecommendationReport = {
  generatedAt: string;
  lookbackDays: number;
  schedules: AnalyticsScheduleRecommendation[];
};
