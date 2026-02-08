import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { AlertTriangle, BarChart3, Clock3, Gauge, Loader2, RefreshCw, Users2 } from 'lucide-react';

const toPercent = (value) => `${(((value || 0) * 100)).toFixed(1)}%`;

const formatLatency = (value) => {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${(value / 60).toFixed(1)}m`;
  return `${(value / 3600).toFixed(2)}h`;
};

const scoreToColor = (score) => {
  const normalized = Math.max(0, Math.min(1, Number(score) || 0));
  const hue = 120 * normalized;
  const lightness = 96 - normalized * 48;
  return `hsl(${hue}, 72%, ${lightness}%)`;
};

const AnalyticsPage = () => {
  const queryClient = useQueryClient();
  const timezoneOffsetMinutes = -new Date().getTimezoneOffset();

  const [targetId, setTargetId] = useState('all');
  const [days, setDays] = useState('90');
  const [contentType, setContentType] = useState('all');

  const { data: targets = [] } = useQuery({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const reportPath = useMemo(() => {
    const params = new URLSearchParams();
    params.set('days', days);
    params.set('tz_offset_min', String(timezoneOffsetMinutes));
    if (targetId !== 'all') params.set('target_id', targetId);
    if (contentType !== 'all') params.set('content_type', contentType);
    return `/api/analytics/report?${params.toString()}`;
  }, [contentType, days, targetId, timezoneOffsetMinutes]);

  const {
    data: report,
    isLoading,
    isFetching
  } = useQuery({
    queryKey: ['analytics-report', days, targetId, contentType, timezoneOffsetMinutes],
    queryFn: () => api.get(reportPath),
    staleTime: 30000
  });

  const { data: scheduleRecommendations } = useQuery({
    queryKey: ['analytics-schedule-recommendations', days],
    queryFn: () => api.get(`/api/analytics/schedule-recommendations?days=${days}`),
    staleTime: 30000
  });

  const captureAudience = useMutation({
    mutationFn: () => api.post('/api/analytics/audience/snapshot'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['analytics-report'] });
    },
    onError: (error) => {
      alert(`Failed to capture audience snapshots: ${error?.message || 'Unknown error'}`);
    }
  });

  const heatmapRows = useMemo(() => {
    const windows = report?.windows || [];
    const bySlot = new Map(windows.map((window) => [window.slot, window]));
    return Array.from({ length: 7 }, (_, day) => ({
      day,
      dayLabel:
        windows.find((window) => window.day === day)?.dayLabel ||
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] ||
        `Day ${day}`,
      hours: Array.from({ length: 24 }, (_, hour) => bySlot.get(day * 24 + hour) || null)
    }));
  }, [report?.windows]);

  const recentTimeline = useMemo(() => {
    const points = report?.timeline || [];
    return [...points].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
  }, [report?.timeline]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">
            Retention-aware timing intelligence with Bayesian slot scoring, fatigue penalties, and live audience snapshots.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['analytics-report'] })}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
          <Button variant="outline" onClick={() => captureAudience.mutate()} disabled={captureAudience.isPending}>
            {captureAudience.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Users2 className="mr-2 h-4 w-4" />
            )}
            Capture Audience
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Tune the model window and target scope.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger>
              <SelectValue placeholder="All targets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All targets</SelectItem>
              {targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={days} onValueChange={setDays}>
            <SelectTrigger>
              <SelectValue placeholder="Lookback window" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="60">Last 60 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="180">Last 180 days</SelectItem>
            </SelectContent>
          </Select>

          <Select value={contentType} onValueChange={setContentType}>
            <SelectTrigger>
              <SelectValue placeholder="All content types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All content types</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="link">Link</SelectItem>
              <SelectItem value="image">Image</SelectItem>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="status">Status</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Loading analytics report...</CardContent>
        </Card>
      ) : report ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Sent Messages</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{report.totals.sent}</div>
                <p className="text-xs text-muted-foreground">{report.lookbackDays} day window</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Observed Delivery</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{toPercent(report.rates.observedRate)}</div>
                <p className="text-xs text-muted-foreground">Based on WhatsApp upsert confirmations</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Response Rate (24h)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{report.rates.responseRate24h.toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">Average inbound replies per sent post in 24h</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Average Latency</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatLatency(report.rates.avgLatencySec)}</div>
                <p className="text-xs text-muted-foreground">Time from send to observed local upsert</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Model Objective</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{toPercent(report.model.objectiveScore)}</div>
                <p className="text-xs text-muted-foreground">Risk-adjusted timing utility score</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Audience Snapshot</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{report.audience.totalAudienceLatest}</div>
                <p className="text-xs text-muted-foreground">Tracked subscribers/members across captured targets</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Data Quality</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{toPercent(report.dataQuality?.observedIdCoverage)}</div>
                <p className="text-xs text-muted-foreground">Observed message ID coverage</p>
                <div className="mt-2 text-xs text-muted-foreground">
                  {report.dataQuality?.inboundRowsScanned || 0} inbound rows scanned
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Recommended Windows
                </CardTitle>
                <CardDescription>
                  Highest utility windows after Bayesian scoring, response uplift, and fatigue penalties.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline">Half-life {report.model.halfLifeDays}d</Badge>
                  <Badge variant="outline">Prior α={report.model.priorAlpha}</Badge>
                  <Badge variant="outline">Prior β={report.model.priorBeta}</Badge>
                  <Badge variant="outline">Confidence {toPercent(report.model.confidence)}</Badge>
                </div>

                <div className="text-sm">
                  <p className="text-muted-foreground">Suggested batch times</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {report.recommendations.suggestedBatchTimes.length ? (
                      report.recommendations.suggestedBatchTimes.map((time) => (
                        <Badge key={time} variant="secondary">
                          {time}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-muted-foreground">No recommendation yet.</span>
                    )}
                  </div>
                </div>

                {report.recommendations.suggestedCron ? (
                  <div className="rounded-md border bg-muted/40 p-3 text-xs">
                    <p className="font-medium">Suggested cron expression</p>
                    <p className="font-mono text-muted-foreground">{report.recommendations.suggestedCron}</p>
                  </div>
                ) : null}

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Window</TableHeaderCell>
                      <TableHeaderCell>Objective</TableHeaderCell>
                      <TableHeaderCell>Confidence</TableHeaderCell>
                      <TableHeaderCell>Observed</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.recommendations.windows.map((window) => (
                      <TableRow key={`${window.day}-${window.hour}`}>
                        <TableCell>
                          <div className="font-medium">{window.dayLabel}</div>
                          <div className="text-xs text-muted-foreground">{window.time}</div>
                        </TableCell>
                        <TableCell>{toPercent(window.objective)}</TableCell>
                        <TableCell>{toPercent(window.confidence)}</TableCell>
                        <TableCell>{toPercent(window.expectedObservedRate)}</TableCell>
                      </TableRow>
                    ))}
                    {!report.recommendations.windows.length && (
                      <TableRow>
                        <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                          Not enough data to produce recommendations yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Gauge className="h-5 w-5" />
                  Target Risk Radar
                </CardTitle>
                <CardDescription>Top targets at risk from inactivity, delivery failures, or engagement decline.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {report.targetRisks.slice(0, 8).map((target) => (
                    <div key={target.target_id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{target.target_name}</p>
                        <Badge variant={target.riskScore > 0.7 ? 'destructive' : target.riskScore > 0.45 ? 'warning' : 'secondary'}>
                          {toPercent(target.riskScore)}
                        </Badge>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <span>Failure: {toPercent(target.failureRate)}</span>
                        <span>Observed: {toPercent(target.observedRate)}</span>
                        <span>Replies 24h: {target.avgResponses24h.toFixed(2)}</span>
                        <span>Inactive: {target.inactivityDays.toFixed(1)}d</span>
                      </div>
                    </div>
                  ))}
                  {!report.targetRisks.length && <p className="text-sm text-muted-foreground">No target risk data available.</p>}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock3 className="h-5 w-5" />
                7x24 Timing Heatmap
              </CardTitle>
              <CardDescription>Objective score by day/hour. Darker green = stronger posting window.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <div className="min-w-[900px] space-y-2">
                  <div className="grid grid-cols-[80px_repeat(24,minmax(26px,1fr))] gap-1 text-[10px] text-muted-foreground">
                    <div />
                    {Array.from({ length: 24 }, (_, hour) => (
                      <div key={hour} className="text-center">
                        {hour}
                      </div>
                    ))}
                  </div>
                  {heatmapRows.map((row) => (
                    <div key={row.day} className="grid grid-cols-[80px_repeat(24,minmax(26px,1fr))] gap-1 items-center">
                      <div className="text-xs text-muted-foreground">{(row.dayLabel || `Day ${row.day}`).slice(0, 3)}</div>
                      {row.hours.map((window, hour) => (
                        <div
                          key={`${row.day}-${hour}`}
                          className="h-6 rounded-sm border"
                          style={{ background: scoreToColor(window?.objective || 0) }}
                          title={
                            window
                              ? `${window.label}\nObjective: ${(window.objective * 100).toFixed(1)}%\nConfidence: ${(window.confidence * 100).toFixed(1)}%\nSent: ${window.sentCount}`
                              : `${row.dayLabel} ${hour}:00\nNo data`
                          }
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Recent Timeline</CardTitle>
                <CardDescription>Daily delivery and engagement trend (latest 14 points).</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Date</TableHeaderCell>
                      <TableHeaderCell>Sent</TableHeaderCell>
                      <TableHeaderCell>Observed</TableHeaderCell>
                      <TableHeaderCell>Failed</TableHeaderCell>
                      <TableHeaderCell>Avg Score</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentTimeline.map((point) => (
                      <TableRow key={point.date}>
                        <TableCell>{point.date}</TableCell>
                        <TableCell>{point.sent}</TableCell>
                        <TableCell>{toPercent(point.observedRate)}</TableCell>
                        <TableCell>{toPercent(point.failureRate)}</TableCell>
                        <TableCell>{toPercent(point.avgScore)}</TableCell>
                      </TableRow>
                    ))}
                    {!recentTimeline.length && (
                      <TableRow>
                        <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                          No timeline points available in this filter range.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Content Type Performance</CardTitle>
                <CardDescription>Observed delivery and response quality by content category.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {report.contentTypeStats.map((item) => (
                    <div key={item.contentType} className="rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium capitalize">{item.contentType}</p>
                        <Badge variant="outline">{item.sent} sent</Badge>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <span>Observed: {toPercent(item.observedRate)}</span>
                        <span>Responses 24h: {item.responseRate24h.toFixed(2)}</span>
                        <span>Avg score: {toPercent(item.avgScore)}</span>
                      </div>
                    </div>
                  ))}
                  {!report.contentTypeStats.length && (
                    <div className="rounded-md border p-4 text-sm text-muted-foreground">No content type statistics available.</div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Model Notes
              </CardTitle>
              <CardDescription>
                Objective combines Bayesian delivery expectation, response uplift, and posting pressure penalty.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-1">
              <p>Objective = posterior_mean + response_boost - fatigue_penalty</p>
              <p>Posterior uses Beta(alpha,beta) with configurable priors from settings.</p>
              <p>Recency weighting uses exponential half-life ({report.model.halfLifeDays} days).</p>
              <p>Confidence blends weighted sample depth and posterior variance.</p>
              {(report.dataQuality?.notes || []).map((note) => (
                <p key={note}>- {note}</p>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Schedule Tuning Recommendations</CardTitle>
              <CardDescription>
                Per-schedule recommendation preview based on each schedule's primary target analytics.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Schedule</TableHeaderCell>
                    <TableHeaderCell>Current</TableHeaderCell>
                    <TableHeaderCell>Recommended</TableHeaderCell>
                    <TableHeaderCell>Confidence</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(scheduleRecommendations?.schedules || []).map((item) => (
                    <TableRow key={item.schedule_id}>
                      <TableCell>
                        <div className="font-medium">{item.schedule_name}</div>
                        <div className="text-xs text-muted-foreground">{item.primary_target_name || 'No target'}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">Cron: {item.current_cron_expression || 'none'}</div>
                        <div className="text-xs text-muted-foreground">
                          Batch: {item.current_batch_times.length ? item.current_batch_times.join(', ') : 'none'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">Cron: {item.recommended_cron || 'none'}</div>
                        <div className="text-xs text-muted-foreground">
                          Batch: {item.recommended_batch_times.length ? item.recommended_batch_times.join(', ') : 'none'}
                        </div>
                      </TableCell>
                      <TableCell>{toPercent(item.confidence)}</TableCell>
                    </TableRow>
                  ))}
                  {!(scheduleRecommendations?.schedules || []).length && (
                    <TableRow>
                      <TableCell colSpan={4} className="h-16 text-center text-muted-foreground">
                        No active schedules to evaluate.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Unable to load analytics report.</CardContent>
        </Card>
      )}
    </div>
  );
};

export default AnalyticsPage;
