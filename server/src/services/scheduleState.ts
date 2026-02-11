type ScheduleState = 'active' | 'paused' | 'stopped' | 'draft';

type ScheduleLike = {
  state?: string | null;
  active?: boolean | null;
};

const VALID_STATES = new Set<ScheduleState>(['active', 'paused', 'stopped', 'draft']);

const normalizeScheduleState = (value: unknown): ScheduleState | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return VALID_STATES.has(normalized as ScheduleState) ? (normalized as ScheduleState) : null;
};

const resolveScheduleState = (schedule: ScheduleLike | null | undefined): ScheduleState => {
  const normalized = normalizeScheduleState(schedule?.state);
  if (normalized) {
    // Legacy rows can drift (state=active, active=false). Never treat those as running.
    if (normalized === 'active' && schedule?.active === false) {
      return 'paused';
    }
    return normalized;
  }
  return schedule?.active === true ? 'active' : 'stopped';
};

const isScheduleRunning = (schedule: ScheduleLike | null | undefined): boolean => {
  return resolveScheduleState(schedule) === 'active';
};

const applyScheduleStatePayload = (
  payload: Record<string, unknown>,
  fallback?: ScheduleLike | null
): { state: ScheduleState; active: boolean } => {
  const explicitState = normalizeScheduleState(payload.state);

  let state: ScheduleState;
  if (explicitState) {
    state = explicitState;
  } else if (typeof payload.active === 'boolean') {
    state = payload.active ? 'active' : 'stopped';
  } else if (fallback) {
    state = resolveScheduleState(fallback);
  } else {
    state = 'active';
  }

  return {
    state,
    active: state === 'active'
  };
};

module.exports = {
  normalizeScheduleState,
  resolveScheduleState,
  isScheduleRunning,
  applyScheduleStatePayload
};
