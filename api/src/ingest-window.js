const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfUtcDay(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addUtcDays(input, days) {
  if (!Number.isFinite(Number(days))) {
    throw new Error(`Invalid days value: ${days}`);
  }
  const base = startOfUtcDay(input);
  return new Date(base.getTime() + Number(days) * MS_PER_DAY);
}

export function isoDate(input) {
  return startOfUtcDay(input).toISOString().slice(0, 10);
}

export function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return startOfUtcDay(d);
}

export function computeAutoIngestWindow({
  today = new Date(),
  lagDays = 2,
  overlapDays = 1,
  bootstrapDays = 30,
  metricMaxDays = {}
} = {}) {
  const lag = Math.max(0, Number.parseInt(String(lagDays), 10) || 0);
  const overlap = Math.max(0, Number.parseInt(String(overlapDays), 10) || 0);
  const bootstrap = Math.max(1, Number.parseInt(String(bootstrapDays), 10) || 30);
  const targetInclusive = addUtcDays(today, -lag);

  const metrics = Object.entries(metricMaxDays || {}).map(([metric, maxDay]) => ({
    metric,
    maxDay: maxDay || null
  }));
  const present = metrics
    .map(({ metric, maxDay }) => ({ metric, maxDay, maxDate: maxDay ? parseIsoDate(maxDay) : null }))
    .filter(item => item.maxDate);

  let mode = "bootstrap";
  let baselineLastDay = addUtcDays(targetInclusive, -bootstrap);
  if (present.length > 0) {
    mode = present.length === metrics.length ? "resume" : "resume_partial_metrics";
    baselineLastDay = present.reduce((min, item) => (item.maxDate < min ? item.maxDate : min), present[0].maxDate);
  }

  const fromInclusive = addUtcDays(baselineLastDay, -overlap);
  const toInclusive = targetInclusive;
  const toExclusive = addUtcDays(toInclusive, 1);
  const shouldIngest = fromInclusive <= toInclusive;

  return {
    mode,
    lagDays: lag,
    overlapDays: overlap,
    bootstrapDays: bootstrap,
    targetInclusive: isoDate(targetInclusive),
    baselineLastDay: isoDate(baselineLastDay),
    fromInclusive: isoDate(fromInclusive),
    toInclusive: isoDate(toInclusive),
    toExclusive: isoDate(toExclusive),
    shouldIngest,
    metrics
  };
}
