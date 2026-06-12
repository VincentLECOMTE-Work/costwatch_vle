import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line } from 'recharts';

const METRICS = ['UnblendedCost', 'AmortizedCost'];

const TAB_DEFS = [
  { id: 'overview', label: "Vue d'ensemble", short: 'OV', description: 'Synthese couts et services' },
  { id: 'insights', label: 'Insights FinOps', short: 'FI', description: 'Anomalies, tendances et qualite DB' },
  { id: 'ri', label: 'Reservations EC2', short: 'RI', description: 'Couverture et mapping RI' },
  { id: 'sp', label: 'Savings Plans', short: 'SP', description: 'Utilisation, couverture et inventaire' },
  { id: 'ec2', label: 'EC2 & EBS', short: 'EC2', description: 'Inventaire instances et volumes' },
  { id: 'calculator', label: 'Calculateur', short: 'Calc', description: 'Projection couts horaires' },
  { id: 'vpc', label: 'VPC / Reseau', short: 'VPC', description: 'Inventaire reseau' },
  { id: 'network-finops', label: 'Network FinOps', short: 'NF', description: 'Couts et usage reseau' },
  { id: 's3', label: 'S3', short: 'S3', description: 'Buckets, stockage et classes' },
];

const lazyTab = (exportName) => lazy(() => import('./ui.jsx').then((mod) => ({ default: mod[exportName] })));
const LazyRiTab = lazyTab('RiTab');
const LazyInsightsTab = lazyTab('InsightsTab');
const LazySpTab = lazyTab('SpTab');
const LazyEC2Tab = lazyTab('EC2Tab');
const LazyCalculatorTab = lazyTab('CalculatorTab');
const LazyVPCTab = lazyTab('VPCTab');
const LazyNetworkFinOpsTab = lazyTab('NetworkFinOpsTab');
const LazyS3Tab = lazyTab('S3Tab');

const currency = (value) => new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
}).format(Number(value || 0));

function toLocalDateString(value) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function addDays(value, days) {
  const base = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(base.getTime())) return '';
  base.setDate(base.getDate() + days);
  return toLocalDateString(base);
}

function today() {
  return toLocalDateString(new Date());
}

function toExclusiveEnd(value) {
  return addDays(value, 1);
}

function appendParams(url, paramsObj = {}) {
  const u = new URL(url, window.location.origin);
  const entries = Object.entries(paramsObj || {}).filter(([, v]) => !(v === undefined || v === null || v === ''));
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of entries) u.searchParams.set(key, value);
  u.searchParams.set('_', String(Date.now()));
  return u.toString();
}

async function getJSON(url, params = {}, options = {}) {
  const res = await fetch(appendParams(url, params), {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
    ...options,
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    const error = new Error(body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function normalizeRows(data) {
  return Array.isArray(data) ? data : (data?.rows || data?.items || []);
}

function buildRangeParams(start, end, extra = {}) {
  const params = { ...extra };
  if (start) params.start = start;
  if (end) params.end = toExclusiveEnd(end);
  return params;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function minIsoDate(a, b) {
  if (!isIsoDate(a)) return isIsoDate(b) ? b : a;
  if (!isIsoDate(b)) return a;
  return a <= b ? a : b;
}

function useEffectiveRegions() {
  const [state, setState] = useState({ data: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    getJSON('/api/meta/runtime')
      .then((data) => {
        if (cancelled) return;
        const asList = (value) => Array.isArray(value)
          ? value
          : String(value || '').split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
        const union = Array.from(new Set([
          ...asList(data?.regionsEffective),
          ...asList(data?.regionsFromDb),
        ].filter(Boolean)));
        setState({ data: union.length ? union : ['us-east-1'], loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ data: ['us-east-1'], loading: false, error });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

function useAccounts() {
  const [state, setState] = useState({ data: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    getJSON('/api/accounts')
      .then((data) => {
        if (cancelled) return;
        const arr = normalizeRows(data).map((item) => ({
          id: item.accountId || item.id,
          name: item.accountName || item.name || item.accountId || item.id,
        })).filter((item) => item.id);
        setState({ data: arr, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ data: [], loading: false, error });
      });
    return () => { cancelled = true; };
  }, []);
  const accountMap = useMemo(() => new Map(state.data.map((account) => [account.id, account.name])), [state.data]);
  return { accounts: state.data, accountMap, loading: state.loading, error: state.error };
}

function useFreshness() {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    getJSON('/api/meta/freshness')
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ data: null, loading: false, error });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

function RegionsPicker({ value, onChange, knownRegions = [] }) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => String(value || '').split(',').map((item) => item.trim()).filter(Boolean), [value]);
  const toggle = (region) => {
    const next = new Set(selected);
    if (next.has(region)) next.delete(region); else next.add(region);
    onChange(Array.from(next).join(','));
  };
  return (
    <div className="relative">
      <button type="button" className="btn w-full justify-between" onClick={() => setOpen((current) => !current)}>
        <span>{selected.length ? selected.join(', ') : 'Toutes'}</span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
          <button type="button" className="btn btn-sm mb-2" onClick={() => onChange('')}>Toutes les regions</button>
          <div className="max-h-64 overflow-auto space-y-1">
            {knownRegions.map((region) => (
              <label key={region} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                <input type="checkbox" checked={selected.includes(region)} onChange={() => toggle(region)} />
                <span>{region}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function FilterPanel({ metric, setMetric, account, setAccount, accounts, accountLoading, mode, setMode, absStart, setAbsStart, absEnd, setAbsEnd, timeframe, setTimeframe, regions, setRegions, regionsEffective, excludeTax, setExcludeTax, riMode, setRiMode }) {
  return (
    <section className="filter-panel">
      <div>
        <label className="filter-label">Metrique</label>
        <select className="select w-full" value={metric} onChange={(event) => setMetric(event.target.value)}>
          {METRICS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div>
        <label className="filter-label">Compte</label>
        <select className="select w-full" value={account} onChange={(event) => setAccount(event.target.value)}>
          <option value="">Tous les comptes</option>
          {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
        </select>
        {accountLoading && <div className="mt-1 text-xs muted">Chargement comptes...</div>}
      </div>
      <div>
        <label className="filter-label">Regions</label>
        <RegionsPicker value={regions} onChange={setRegions} knownRegions={regionsEffective} />
      </div>
      <div>
        <label className="filter-label">Periode</label>
        <div className="grid grid-cols-3 gap-1">
          {['7j', '30j', '90j', 'mois_courant', 'mois_préc'].map((key) => {
            const labels = { '7j': '7 j', '30j': '30 j', '90j': '90 j', mois_courant: 'Mois courant', mois_préc: 'Mois prec.' };
            return <button key={key} type="button" className={`btn btn-sm ${timeframe === key && mode !== 'abs' ? 'btn-primary' : ''}`} onClick={() => { setMode('rel'); setTimeframe(key); }}>{labels[key]}</button>;
          })}
          <button type="button" className={`btn btn-sm ${mode === 'abs' ? 'btn-primary' : ''}`} onClick={() => setMode('abs')}>Dates</button>
        </div>
      </div>
      {mode === 'abs' && (
        <div className="grid grid-cols-2 gap-1">
          <input className="input" type="date" value={absStart} onChange={(event) => setAbsStart(event.target.value)} />
          <input className="input" type="date" value={absEnd} onChange={(event) => setAbsEnd(event.target.value)} />
        </div>
      )}
      <div className="grid gap-2">
        <Toggle checked={excludeTax} onChange={setExcludeTax} label="Retirer TAX" />
        <Toggle checked={riMode} onChange={setRiMode} label="Inclure RI/SP dans le calculateur" />
      </div>
    </section>
  );
}

function TrustBadge({ type = 'info', children }) {
  return <span className={`trust-badge trust-badge-${type}`}>{children}</span>;
}

function StatusBanner({ type = 'info', children }) {
  const cls = type === 'error'
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-slate-200 bg-white text-slate-600';
  return <div className={`rounded-2xl border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

const DASHBOARD_FILTERS = {
  metric: 'AmortizedCost',
  account: '',
  regions: 'eu-west-3',
  excludeTax: true,
};

const dashboardCurrency = (value, options = {}) => {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    ...options,
  }).format(Number.isFinite(amount) ? amount : 0);
};

function signedDashboardCurrency(value) {
  const amount = Number(value || 0);
  if (!amount) return dashboardCurrency(0);
  const label = dashboardCurrency(amount);
  return amount > 0 ? `+${label}` : label;
}

function dashboardPct(value) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${amount > 0 ? '+' : ''}${amount.toFixed(1)}%`;
}

function dashboardMonthStart(value) {
  const date = value ? new Date(`${String(value).slice(0, 10)}T00:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) return toLocalDateString(new Date());
  return toLocalDateString(new Date(date.getFullYear(), date.getMonth(), 1));
}

function previousDashboardMonth(value) {
  const date = value ? new Date(`${String(value).slice(0, 10)}T00:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const start = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const end = new Date(date.getFullYear(), date.getMonth(), 1);
  return { start: toLocalDateString(start), end: toLocalDateString(end) };
}

function inclusiveRangeLabel(start, exclusiveEnd) {
  if (!start && !exclusiveEnd) return '—';
  const inclusiveEnd = exclusiveEnd ? addDays(exclusiveEnd, -1) : '';
  return `${start || '—'} -> ${inclusiveEnd || '—'}`;
}

function formatDashboardBytes(value) {
  const amount = Number(value || 0);
  const abs = Math.abs(amount);
  const units = [
    ['TB', 1000 ** 4],
    ['GB', 1000 ** 3],
    ['MB', 1000 ** 2],
    ['KB', 1000],
  ];
  const [unit, factor] = units.find(([, size]) => abs >= size) || ['B', 1];
  const normalized = abs / factor;
  const digits = unit === 'B' ? 0 : 2;
  const label = `${normalized.toFixed(digits)} ${unit}`;
  if (!amount) return label;
  return `${amount > 0 ? '+' : '-'}${label}`;
}

function formatDashboardGiB(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '—';
  if (Math.abs(amount) >= 1024) return `${(amount / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} TiB`;
  return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} GiB`;
}

function signedDashboardGiB(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const label = formatDashboardGiB(Math.abs(amount));
  if (!amount) return label;
  return `${amount > 0 ? '+' : '-'}${label}`;
}

function averageDashboardValue(rows, key) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const values = rows.map((row) => Number(row?.[key])).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatDashboardAverage(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
}

function signedDashboardAverage(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (!amount) return '0';
  return `${amount > 0 ? '+' : ''}${formatDashboardAverage(amount)}`;
}

const S3_CLASS_LABELS = {
  StandardStorage: 'Standard',
  IntelligentTieringFAStorage: 'Intelligent-Tiering',
  IntelligentTieringIAStorage: 'IT Infrequent',
  IntelligentTieringAAStorage: 'IT Archive',
  IntelligentTieringAIAStorage: 'IT Archive IA',
  StandardIAStorage: 'Standard-IA',
  OneZoneIAStorage: 'One Zone-IA',
  GlacierInstantRetrievalStorage: 'Glacier Instant',
  GlacierStorage: 'Glacier',
  GlacierStagingStorage: 'Glacier staging',
  DeepArchiveStorage: 'Deep Archive',
  ReducedRedundancyStorage: 'RRS',
};

const S3_CLASS_MONTHLY_PRICES = {
  StandardStorage: 0.024,
  IntelligentTieringFAStorage: 0.024,
  IntelligentTieringIAStorage: 0.0131,
  IntelligentTieringAIAStorage: 0.005,
  StandardIAStorage: 0.0131,
  OneZoneIAStorage: 0.01048,
  GlacierInstantRetrievalStorage: 0.005,
  GlacierStorage: 0.00405,
  DeepArchiveStorage: 0.0018,
  GlacierDeepArchiveStorage: 0.0018,
  DeepArchiveStagingStorage: 0,
  DeepArchiveObjectOverhead: 0,
  DeepArchiveS3ObjectOverhead: 0,
};

function dashboardS3ClassLabel(name) {
  if (!name) return '—';
  return S3_CLASS_LABELS[name] || name.replace(/Storage$/, '');
}

function dominantDashboardS3ClassKey(classes) {
  const entries = Object.entries(classes || {})
    .map(([name, bytes]) => [name, Number(bytes || 0)])
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '—';
  const [name] = entries[0];
  return name;
}

function dominantDashboardS3Class(classes) {
  return dashboardS3ClassLabel(dominantDashboardS3ClassKey(classes));
}

function estimateDashboardS3GrowthCost(growthBytes, classKey) {
  const price = Number(S3_CLASS_MONTHLY_PRICES[classKey] || 0);
  if (!price) return 0;
  return (Number(growthBytes || 0) / (1024 ** 3)) * price;
}

function buildDashboardS3ClassGrowth(items) {
  const totals = new Map();
  (items || []).forEach((row) => {
    const classKey = dominantDashboardS3ClassKey(row.classes);
    if (!classKey || classKey === '—') return;
    const label = dashboardS3ClassLabel(classKey);
    const growthBytes = Number(row.growthBytes || 0);
    const current = totals.get(classKey) || { classKey, label, growthBytes: 0, latestBytes: 0, buckets: 0, monthlyCost: 0 };
    current.growthBytes += growthBytes;
    current.latestBytes += Number(row.latestBytes || 0);
    current.monthlyCost += estimateDashboardS3GrowthCost(growthBytes, classKey);
    current.buckets += 1;
    totals.set(classKey, current);
  });
  return Array.from(totals.values())
    .sort((a, b) => Math.abs(b.growthBytes) - Math.abs(a.growthBytes) || b.latestBytes - a.latestBytes)
    .slice(0, 3);
}

function previousDashboardComparableRange(start, end) {
  const startDate = start ? new Date(`${String(start).slice(0, 10)}T00:00:00`) : null;
  const endDate = end ? new Date(`${String(end).slice(0, 10)}T00:00:00`) : null;
  if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  const spanDays = Math.max(1, Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)));
  const previousStart = new Date(startDate.getFullYear(), startDate.getMonth() - 1, startDate.getDate());
  const previousEnd = new Date(previousStart);
  previousEnd.setDate(previousEnd.getDate() + spanDays);
  return { start: toLocalDateString(previousStart), end: toLocalDateString(previousEnd) };
}

function dashboardAccountLabel(accountMap, rowOrId) {
  const row = rowOrId && typeof rowOrId === 'object' ? rowOrId : {};
  const id = String(row.accountId || row.account_id || row.linked_account || rowOrId || '').trim();
  const rowName = row.accountName || row.account_name || row.name || '';
  const mapped = id && accountMap && typeof accountMap.get === 'function' ? accountMap.get(id) : '';
  const label = mapped || rowName || id;
  return label || '—';
}

function formatDashboardSnapshotHour(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace('T', ' ');
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function DashboardKpi({ label, value, detail, tone = 'slate' }) {
  return (
    <article className={`dashboard-kpi dashboard-kpi-${tone}`}>
      <div className="dashboard-kpi-label">{label}</div>
      <div className="dashboard-kpi-value">{value}</div>
      <div className="dashboard-kpi-detail">{detail}</div>
    </article>
  );
}

function DashboardPanel({ title, meta, className = '', children }) {
  return (
    <section className={`dashboard-panel ${className}`}>
      <div className="dashboard-panel-head">
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function DashboardMetric({ label, value, tone = 'slate' }) {
  return (
    <div className={`dashboard-inline-metric dashboard-inline-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DashboardEmpty({ children }) {
  return <div className="dashboard-empty">{children}</div>;
}

function DashboardPage({ accountMap, freshnessState }) {
  const latestCostDay = freshnessState.data?.costs?.byMetric?.[DASHBOARD_FILTERS.metric]?.maxDay
    || freshnessState.data?.costs?.latestDay
    || null;
  const range = useMemo(() => {
    const anchor = latestCostDay || today();
    return {
      start: dashboardMonthStart(anchor),
      end: addDays(anchor, 1),
      anchor,
    };
  }, [latestCostDay]);
  const previousMonthRange = useMemo(() => previousDashboardMonth(range.anchor), [range.anchor]);
  const previousBreakdownRange = useMemo(() => previousDashboardComparableRange(range.start, range.end), [range.start, range.end]);
  const snapshotRange = useMemo(() => ({
    start: range.start,
    end: addDays(today(), 1),
  }), [range.start]);
  const [state, setState] = useState({
    loading: true,
    errors: [],
    trends: null,
    anomalies: null,
    s3: null,
    forecast: null,
    breakdown: null,
    breakdownPrevious: null,
    ec2: null,
    ec2Previous: null,
    ebs: null,
  });

  useEffect(() => {
    if (freshnessState.loading && !latestCostDay) return;
    let cancelled = false;
    const base = {
      start: range.start,
      end: range.end,
      metric: DASHBOARD_FILTERS.metric,
      accounts: DASHBOARD_FILTERS.account,
      regions: DASHBOARD_FILTERS.regions,
      excludeTax: '1',
    };
    const snapshotBase = {
      start: snapshotRange.start,
      end: snapshotRange.end,
      accounts: DASHBOARD_FILTERS.account,
      regions: DASHBOARD_FILTERS.regions,
    };
    setState((prev) => ({ ...prev, loading: true, errors: [] }));
    const requests = [
      ['trends', getJSON('/api/costs/trends', base)],
      ['anomalies', getJSON('/api/costs/anomalies', { ...base, limit: 20, minAbs: 1, minPct: 20 })],
      ['s3', getJSON('/api/s3/growth', { ...snapshotBase, limit: 20 })],
      ['forecast', getJSON('/api/costs/forecast', { ...base, limit: 8, anchor: range.anchor })],
      ['breakdown', getJSON('/api/costs/breakdown', { ...base, limit: 8 })],
      ['breakdownPrevious', previousBreakdownRange
        ? getJSON('/api/costs/breakdown', { ...base, start: previousBreakdownRange.start, end: previousBreakdownRange.end, limit: 8 })
        : Promise.resolve({ accounts: [] })],
      ['ec2', getJSON('/api/ec2/snapshots/summary', snapshotBase)],
      ['ec2Previous', previousMonthRange
        ? getJSON('/api/ec2/snapshots/summary', { ...snapshotBase, start: previousMonthRange.start, end: previousMonthRange.end })
        : Promise.resolve({ snapshots: [] })],
      ['ebs', getJSON('/api/ebs/snapshots/summary', snapshotBase)],
    ];
    Promise.allSettled(requests.map(([, promise]) => promise)).then((results) => {
      if (cancelled) return;
      const next = {
        loading: false,
        errors: [],
        trends: null,
        anomalies: null,
        s3: null,
        forecast: null,
        breakdown: null,
        breakdownPrevious: null,
        ec2: null,
        ec2Previous: null,
        ebs: null,
      };
      results.forEach((result, index) => {
        const key = requests[index][0];
        if (result.status === 'fulfilled') next[key] = result.value;
        else next.errors.push(`${key}: ${result.reason?.message || 'appel API impossible'}`);
      });
      setState(next);
    });
    return () => { cancelled = true; };
  }, [freshnessState.loading, latestCostDay, range.start, range.end, range.anchor, snapshotRange, previousMonthRange, previousBreakdownRange]);

  const summary = state.trends?.summary || {};
  const trendDaily = Array.isArray(state.trends?.daily) ? state.trends.daily : [];
  const anomalies = Array.isArray(state.anomalies?.items) ? state.anomalies.items : [];
  const s3Items = Array.isArray(state.s3?.items) ? state.s3.items : [];
  const s3GrowthBytes = s3Items.reduce((sum, row) => sum + Number(row.growthBytes || 0), 0);
  const s3ClassGrowth = buildDashboardS3ClassGrowth(s3Items);
  const forecastSummary = state.forecast?.summary || {};
  const projectedDaily = Array.isArray(state.forecast?.projectedDaily) ? state.forecast.projectedDaily : [];
  const forecastServices = Array.isArray(state.forecast?.byService) ? state.forecast.byService.slice(0, 4) : [];
  const breakdownAccounts = Array.isArray(state.breakdown?.accounts) ? state.breakdown.accounts : [];
  const previousBreakdownAccounts = Array.isArray(state.breakdownPrevious?.accounts) ? state.breakdownPrevious.accounts : [];
  const previousAccountCosts = new Map(previousBreakdownAccounts.map((row) => [row.accountId, Number(row.cost || 0)]));
  const accountDistribution = breakdownAccounts.slice(0, 5).map((row) => {
    const previousCost = previousAccountCosts.get(row.accountId) || 0;
    const deltaCost = Number(row.cost || 0) - previousCost;
    return { ...row, previousCost, deltaCost };
  });
  const ec2Series = Array.isArray(state.ec2?.snapshots) ? state.ec2.snapshots : [];
  const ec2PreviousSeries = Array.isArray(state.ec2Previous?.snapshots) ? state.ec2Previous.snapshots : [];
  const ec2Latest = ec2Series[ec2Series.length - 1] || {};
  const ec2Summary = state.ec2?.summary || {};
  const ec2RunningAverage = averageDashboardValue(ec2Series, 'running');
  const ec2PreviousRunningAverage = averageDashboardValue(ec2PreviousSeries, 'running');
  const ec2RunningAverageDelta = Number.isFinite(ec2RunningAverage) && Number.isFinite(ec2PreviousRunningAverage)
    ? ec2RunningAverage - ec2PreviousRunningAverage
    : null;
  const ebsSeries = Array.isArray(state.ebs?.snapshots) ? state.ebs.snapshots : [];
  const ebsSummary = state.ebs?.summary || {};
  const ebsTypes = Array.isArray(state.ebs?.latestByType) ? state.ebs.latestByType.slice(0, 4) : [];
  const currentRange = inclusiveRangeLabel(state.trends?.window?.start || range.start, state.trends?.window?.end || range.end);
  const previousRange = inclusiveRangeLabel(state.trends?.window?.previousStart, state.trends?.window?.previousEnd);
  const delta = Number(summary.delta || 0);
  const deltaTone = delta > 0 ? 'red' : delta < 0 ? 'green' : 'slate';

  return (
    <div className="dashboard-page">
      <header className="dashboard-topbar">
        <div className="dashboard-brand">
          <div className="dashboard-brand-mark">$</div>
          <div>
            <h1>Costwatch</h1>
            <p>Dashboard FinOps compact</p>
          </div>
        </div>
        <div className="dashboard-filter-strip" aria-label="Filtres appliqués">
          <span>Retirer TAX</span>
          <span>Mois courant</span>
          <span>AmortizedCost</span>
          <span>Tous comptes</span>
          <span>eu-west-3</span>
        </div>
        <div className="dashboard-source">
          <strong>{state.loading ? 'Chargement' : 'DB-only'}</strong>
          <span>{latestCostDay ? `Données au ${latestCostDay}` : currentRange}</span>
        </div>
      </header>

      {(state.errors.length > 0 || freshnessState.error) && (
        <div className="dashboard-alert">
          {freshnessState.error ? `Fraîcheur indisponible: ${freshnessState.error.message}. ` : ''}
          {state.errors.slice(0, 2).join(' · ')}
        </div>
      )}

      <section className="dashboard-kpi-grid" aria-label="Synthèse période">
        <DashboardKpi label="Total période" value={dashboardCurrency(summary.total || 0)} detail={currentRange} tone="blue" />
        <DashboardKpi label="Total M-1" value={dashboardCurrency(summary.previousTotal || 0)} detail={previousRange} tone="slate" />
        <DashboardKpi
          label="Variation"
          value={signedDashboardCurrency(summary.delta || 0)}
          detail={`${dashboardPct(summary.deltaPct)} vs ${previousRange}`}
          tone={deltaTone}
        />
        <DashboardKpi
          label="Projection mois"
          value={dashboardCurrency(summary.projectionMonthEnd || 0)}
          detail={`${dashboardCurrency(summary.avgDaily || 0)} / jour observé`}
          tone="slate"
        />
        <DashboardKpi label="Anomalies" value={anomalies.length} detail="Variations coût significatives" tone={anomalies.length ? 'amber' : 'green'} />
        <DashboardKpi label="Croissance S3" value={formatDashboardBytes(s3GrowthBytes)} detail={`${s3Items.length} bucket(s) analysés`} tone={s3GrowthBytes > 0 ? 'amber' : 'green'} />
      </section>

      <main className="dashboard-grid">
        <DashboardPanel title="Forecast avancé" meta="Projection locale">
          <div className="dashboard-metric-grid">
            <DashboardMetric label="MTD actuel" value={dashboardCurrency(forecastSummary.currentMtd || 0, { maximumFractionDigits: 0 })} tone="blue" />
            <DashboardMetric label="Forecast 7j" value={dashboardCurrency(forecastSummary.forecast7dTrend || 0, { maximumFractionDigits: 0 })} tone={Number(forecastSummary.expectedOverrun || 0) > 0 ? 'red' : 'green'} />
            <DashboardMetric label="Forecast MTD" value={dashboardCurrency(forecastSummary.forecastMtdRunRate || 0, { maximumFractionDigits: 0 })} />
            <DashboardMetric label="Écart M-1" value={signedDashboardCurrency(forecastSummary.deltaVsPreviousMonth || 0)} tone={Number(forecastSummary.deltaVsPreviousMonth || 0) > 0 ? 'red' : 'green'} />
          </div>
          <div className="dashboard-chart">
            {projectedDaily.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={projectedDaily}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickMargin={6} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `$${Number(value || 0).toFixed(0)}`} width={44} />
                  <Tooltip formatter={(value) => dashboardCurrency(value)} />
                  <Area type="monotone" dataKey="projectedCumulative" name="Cumul projeté" stroke="#0e7490" fill="#cffafe" fillOpacity={0.45} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <DashboardEmpty>Projection indisponible.</DashboardEmpty>}
          </div>
          <div className="dashboard-list">
            {forecastServices.map((row) => (
              <div className="dashboard-list-row" key={row.service}>
                <span title={row.service}>{row.service || '—'}</span>
                <strong>{dashboardCurrency(row.forecastMonthEnd || 0, { maximumFractionDigits: 0 })}</strong>
              </div>
            ))}
          </div>
        </DashboardPanel>

        <DashboardPanel title="Snapshots EC2 exacts" meta={formatDashboardSnapshotHour(ec2Summary.latestSnapshotHour)}>
          <div className="dashboard-panel-metrics">
            <div className="dashboard-metric-grid dashboard-metric-grid-3">
              <DashboardMetric label="Running" value={Number(ec2Latest.running || 0).toLocaleString('fr-FR')} tone="green" />
              <DashboardMetric label="Stopped" value={Number(ec2Latest.stopped || 0).toLocaleString('fr-FR')} tone="blue" />
              <DashboardMetric label="Terminated" value={Number(ec2Latest.terminated || 0).toLocaleString('fr-FR')} tone={Number(ec2Latest.terminated || 0) ? 'amber' : 'slate'} />
            </div>
            <div className="dashboard-metric-grid">
              <DashboardMetric label="Moy. running" value={formatDashboardAverage(ec2RunningAverage)} tone="blue" />
              <DashboardMetric
                label="Écart moy. M-1"
                value={signedDashboardAverage(ec2RunningAverageDelta)}
                tone={Number(ec2RunningAverageDelta || 0) > 0 ? 'red' : Number(ec2RunningAverageDelta || 0) < 0 ? 'green' : 'slate'}
              />
            </div>
          </div>
          <div className="dashboard-chart">
            {ec2Series.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={ec2Series}>
                  <XAxis dataKey="snapshotHour" hide />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip labelFormatter={(value) => formatDashboardSnapshotHour(value)} />
                  <Line type="monotone" dataKey="running" name="running" stroke="#16a34a" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="stopped" name="stopped" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="terminated" name="terminated" stroke="#f43f5e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : <DashboardEmpty>Aucun snapshot EC2.</DashboardEmpty>}
          </div>
          <div className="dashboard-panel-note">
            {Number(ec2Summary.snapshots || 0)} snapshot(s) · Moy. M-1: {formatDashboardAverage(ec2PreviousRunningAverage)} · VLE_Cost running: {Number(ec2Latest.backupRunning || 0)}
          </div>
        </DashboardPanel>

        <DashboardPanel title="EBS" meta={formatDashboardSnapshotHour(ebsSummary.latestSnapshotHour)}>
          <div className="dashboard-panel-metrics">
            <div className="dashboard-metric-grid dashboard-metric-grid-3">
              <DashboardMetric label="Volumes" value={Number(ebsSummary.latestVolumes || 0).toLocaleString('fr-FR')} tone="blue" />
              <DashboardMetric label="Taille" value={formatDashboardGiB(ebsSummary.latestSizeGiB)} tone="blue" />
              <DashboardMetric label="Coût/mois" value={ebsSummary.latestMonthlyCost == null ? '—' : dashboardCurrency(ebsSummary.latestMonthlyCost, { maximumFractionDigits: 0 })} />
            </div>
            <div className="dashboard-metric-grid">
              <DashboardMetric
                label="Écart taille"
                value={signedDashboardGiB(ebsSummary.deltaSizeGiB)}
                tone={Number(ebsSummary.deltaSizeGiB || 0) > 0 ? 'amber' : Number(ebsSummary.deltaSizeGiB || 0) < 0 ? 'green' : 'slate'}
              />
              <DashboardMetric
                label="Écart coût"
                value={ebsSummary.deltaMonthlyCost == null ? '—' : signedDashboardCurrency(ebsSummary.deltaMonthlyCost)}
                tone={Number(ebsSummary.deltaMonthlyCost || 0) > 0 ? 'red' : Number(ebsSummary.deltaMonthlyCost || 0) < 0 ? 'green' : 'slate'}
              />
            </div>
          </div>
          <div className="dashboard-list dashboard-list-tight">
            {ebsTypes.map((row) => (
              <div className="dashboard-list-row" key={row.volumeType}>
                <span>{row.volumeType || '—'} · {Number(row.totalVolumes || 0).toLocaleString('fr-FR')} vol.</span>
                <strong>{formatDashboardGiB(row.totalGiB)} · {dashboardCurrency(row.estimatedMonthlyCost || 0, { maximumFractionDigits: 0 })}/mois</strong>
              </div>
            ))}
            {!ebsTypes.length && <DashboardEmpty>Aucun volume EBS.</DashboardEmpty>}
          </div>
          <div className="dashboard-panel-note">
            Taille {dashboardPct(ebsSummary.deltaSizePct)} · Coût {dashboardPct(ebsSummary.deltaMonthlyCostPct)}
          </div>
        </DashboardPanel>

        <DashboardPanel title="Répartition par compte" meta="Part de coût">
          <div className="dashboard-account-bars">
            {accountDistribution.map((row) => {
              const delta = Number(row.deltaCost || 0);
              const share = Math.max(0, Math.min(100, Number(row.sharePct || 0)));
              const accountLabel = dashboardAccountLabel(accountMap, row);
              return (
                <div className="dashboard-account-row" key={row.accountId}>
                  <div className="dashboard-account-row-head">
                    <span title={accountLabel}>{accountLabel}</span>
                    <strong>{dashboardCurrency(row.cost || 0, { maximumFractionDigits: 0 })}</strong>
                  </div>
                  <div className="dashboard-account-bar" aria-label={`${share.toFixed(1)}% du coût`}>
                    <span
                      className={delta > 0 ? 'dashboard-account-bar-red' : delta < 0 ? 'dashboard-account-bar-green' : ''}
                      style={{ width: `${Math.max(2, share)}%` }}
                    />
                  </div>
                  <div className="dashboard-account-row-foot">
                    <span>{share.toFixed(1)}% période filtrée</span>
                    <em className={delta > 0 ? 'dashboard-text-red' : delta < 0 ? 'dashboard-text-green' : ''}>{signedDashboardCurrency(delta)} vs M-1</em>
                  </div>
                </div>
              );
            })}
            {!accountDistribution.length && <DashboardEmpty>Aucune répartition compte.</DashboardEmpty>}
          </div>
        </DashboardPanel>

        <DashboardPanel title="Anomalies coût" meta="Top variations">
          <div className="dashboard-table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr><th>Service</th><th>Compte</th><th className="text-right">Écart</th><th className="text-right">%</th></tr>
              </thead>
              <tbody>
                {anomalies.slice(0, 6).map((row, index) => {
                  const isUp = Number(row.delta || 0) > 0;
                  const accountLabel = dashboardAccountLabel(accountMap, row);
                  return (
                    <tr key={`${row.accountId}-${row.service}-${row.region}-${index}`}>
                      <td title={row.service}>{row.service || '—'}</td>
                      <td title={accountLabel}>{accountLabel}</td>
                      <td className={`text-right ${isUp ? 'dashboard-text-red' : 'dashboard-text-green'}`}>{signedDashboardCurrency(row.delta)}</td>
                      <td className={`text-right ${isUp ? 'dashboard-text-red' : 'dashboard-text-green'}`}>{row.deltaPct == null ? 'new' : dashboardPct(row.deltaPct)}</td>
                    </tr>
                  );
                })}
                {!anomalies.length && <tr><td colSpan="4"><DashboardEmpty>Aucune anomalie significative.</DashboardEmpty></td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>

        <DashboardPanel title="Croissance S3" meta="Buckets analysés">
          <div className="dashboard-class-growth-grid">
            {s3ClassGrowth.map((row) => {
              const growth = Number(row.growthBytes || 0);
              return (
                <div className={`dashboard-class-growth-card ${growth > 0 ? 'dashboard-class-growth-up' : growth < 0 ? 'dashboard-class-growth-down' : ''}`} key={row.label}>
                  <span>Croissance {row.label}</span>
                  <div className="dashboard-class-growth-value">
                    <strong>{formatDashboardBytes(growth)}</strong>
                    <em>{signedDashboardCurrency(row.monthlyCost)}/mois</em>
                  </div>
                  <small>{row.buckets} bucket(s) dominants</small>
                </div>
              );
            })}
            {!s3ClassGrowth.length && <DashboardEmpty>Aucune classe dominante.</DashboardEmpty>}
          </div>
          <div className="dashboard-table-wrap">
            <table className="dashboard-table dashboard-table-s3">
              <thead>
                <tr><th>Bucket</th><th>Compte</th><th>Classe dominante</th><th className="text-right">Taille</th><th className="text-right">Croissance</th></tr>
              </thead>
              <tbody>
                {s3Items.slice(0, 6).map((row, index) => {
                  const growth = Number(row.growthBytes || 0);
                  const accountLabel = dashboardAccountLabel(accountMap, row);
                  return (
                    <tr key={`${row.bucket}-${row.region}-${index}`}>
                      <td title={row.bucket}>{row.bucket || '—'}</td>
                      <td title={accountLabel}>{accountLabel}</td>
                      <td title={dominantDashboardS3Class(row.classes)}>{dominantDashboardS3Class(row.classes)}</td>
                      <td className="text-right">{formatDashboardBytes(row.latestBytes).replace(/^[+-]/, '')}</td>
                      <td className={`text-right ${growth > 0 ? 'dashboard-text-amber' : growth < 0 ? 'dashboard-text-green' : ''}`}>{formatDashboardBytes(growth)}</td>
                    </tr>
                  );
                })}
                {!s3Items.length && <tr><td colSpan="5"><DashboardEmpty>Aucun snapshot S3.</DashboardEmpty></td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
      </main>
    </div>
  );
}

function previousRangeFor(start, end) {
  if (!start || !end) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  const sameMonth = startDate.getFullYear() === endDate.getFullYear() && startDate.getMonth() === endDate.getMonth();
  const lastDayOfCurrentMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
  const isFullMonth = sameMonth && startDate.getDate() === 1 && endDate.getDate() === lastDayOfCurrentMonth;
  if (isFullMonth) {
    const prevStart = new Date(startDate.getFullYear(), startDate.getMonth() - 1, 1);
    const prevEnd = new Date(startDate.getFullYear(), startDate.getMonth(), 0);
    return { start: toLocalDateString(prevStart), end: toLocalDateString(prevEnd) };
  }
  const isMonthToDate = sameMonth && startDate.getDate() === 1;
  if (isMonthToDate) {
    const prevStart = new Date(startDate.getFullYear(), startDate.getMonth() - 1, 1);
    const prevMonthLastDay = new Date(startDate.getFullYear(), startDate.getMonth(), 0).getDate();
    const prevEndDay = Math.min(endDate.getDate(), prevMonthLastDay);
    const prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), prevEndDay);
    return { start: toLocalDateString(prevStart), end: toLocalDateString(prevEnd) };
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const span = Math.max(1, Math.round((endDate - startDate) / dayMs) + 1);
  const prevEnd = new Date(startDate);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - span + 1);
  return { start: toLocalDateString(prevStart), end: toLocalDateString(prevEnd) };
}

function Overview({ start, end, requestedEnd, metric, account, regions, accountMap, excludeTax, latestCostDay }) {
  const [state, setState] = useState({ loading: true, error: null, daily: [], byService: [], top: [], previousDaily: [], previousByService: [] });
  const previousRange = useMemo(() => previousRangeFor(start, end), [start, end]);

  const buildParams = useCallback((rangeStart, rangeEnd) => buildRangeParams(rangeStart, rangeEnd, {
    metric,
    accounts: account || undefined,
    regions: regions || undefined,
  }), [metric, account, regions]);

  useEffect(() => {
    if (!start || !end) return;
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const current = Promise.all([
      getJSON('/api/costs/daily-total', buildParams(start, end)),
      getJSON('/api/costs/by-service', buildParams(start, end)),
      getJSON('/api/costs/top-combos', { ...buildParams(start, end), limit: 15 }),
    ]);
    const previous = previousRange
      ? Promise.all([
          getJSON('/api/costs/daily-total', buildParams(previousRange.start, previousRange.end)),
          getJSON('/api/costs/by-service', buildParams(previousRange.start, previousRange.end)),
        ])
      : Promise.resolve([[], []]);

    Promise.all([current, previous])
      .then(([[dailyRaw, servicesRaw, topRaw], [prevDailyRaw, prevServicesRaw]]) => {
        if (cancelled) return;
        const daily = normalizeRows(dailyRaw).map((item) => ({ date: item.date || item.day || item.time || today(), cost: Number(item.cost ?? item.amountUSD ?? item.Amount ?? 0) }));
        const byService = normalizeRows(servicesRaw).map((item) => ({ service: item.service || item.Service || 'Autre', cost: Number(item.cost ?? item.amountUSD ?? 0) })).sort((a, b) => b.cost - a.cost);
        const top = normalizeRows(topRaw).map((item) => ({
          service: item.service || item.Service || 'Autre',
          region: item.region || item.Region || '',
          linked_account: item.linked_account || item.linkedAccount || item.accountId || '',
          account_name: item.account_name || item.accountName || '',
          cost: Number(item.cost ?? 0),
        }));
        const previousDaily = normalizeRows(prevDailyRaw).map((item) => ({ date: item.date || item.day || item.time || today(), cost: Number(item.cost ?? item.amountUSD ?? item.Amount ?? 0) }));
        const previousByService = normalizeRows(prevServicesRaw).map((item) => ({ service: item.service || item.Service || 'Autre', cost: Number(item.cost ?? item.amountUSD ?? 0) }));
        setState({ loading: false, error: null, daily, byService, top, previousDaily, previousByService });
      })
      .catch((error) => {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false, error }));
      });
    return () => { cancelled = true; };
  }, [start, end, previousRange, buildParams]);

  const serviceRows = excludeTax ? state.byService.filter((item) => String(item.service || '').toLowerCase() !== 'tax') : state.byService;
  const topRows = excludeTax ? state.top.filter((item) => String(item.service || '').toLowerCase() !== 'tax') : state.top;
  const currentTotal = serviceRows.reduce((sum, item) => sum + Number(item.cost || 0), 0) || state.daily.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const previousServices = excludeTax ? state.previousByService.filter((item) => String(item.service || '').toLowerCase() !== 'tax') : state.previousByService;
  const previousTotal = previousServices.reduce((sum, item) => sum + Number(item.cost || 0), 0) || state.previousDaily.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const delta = currentTotal - previousTotal;
  const deltaPct = previousTotal > 0 ? (delta / previousTotal) * 100 : null;
  const activeServices = serviceRows.filter((item) => Number(item.cost) > 0).length;
  const isCapped = isIsoDate(requestedEnd) && isIsoDate(end) && end < requestedEnd;

  return (
    <div className="space-y-5">
      {state.loading && <StatusBanner>Chargement des donnees de synthese...</StatusBanner>}
      {state.error && <StatusBanner type="error">Erreur API : {state.error.message || 'impossible de charger la synthese'}</StatusBanner>}
      <div className="flex flex-wrap gap-2">
        <TrustBadge type="real">Réel AWS</TrustBadge>
        <TrustBadge type="cache">Cache DB Cost Explorer</TrustBadge>
        {latestCostDay && <TrustBadge type="cache">Données jusqu'au {latestCostDay}</TrustBadge>}
        {previousRange && <TrustBadge type="estimate">Comparaison {previousRange.start} {'->'} {previousRange.end}</TrustBadge>}
        {isCapped && <TrustBadge type="warn">Période plafonnée au dernier jour disponible</TrustBadge>}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="metric-card">
          <div className="text-sm muted">Cout estime ({metric})</div>
          <div className="text-3xl font-bold">{currency(currentTotal)}</div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={state.daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" hide />
                <YAxis hide />
                <Tooltip formatter={(value) => currency(value)} />
                <Area type="monotone" dataKey="cost" stroke="#0f172a" fill="#cbd5e1" strokeWidth={2} fillOpacity={0.45} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="metric-card">
          <div className="text-sm muted">Services actifs</div>
          <div className="text-3xl font-bold">{activeServices}</div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={serviceRows.slice(0, 10)}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis hide dataKey="service" />
                <YAxis hide />
                <Tooltip formatter={(value) => currency(value)} />
                <Bar dataKey="cost" fill="#334155" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="metric-card">
          <div className="text-sm muted">Evolution vs periode precedente</div>
          <div className={`text-3xl font-bold ${delta > 0 ? 'text-red-600' : delta < 0 ? 'text-emerald-600' : 'text-slate-500'}`}>
            {deltaPct == null ? '-' : `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%`}
          </div>
          <div className="text-sm muted">{previousTotal > 0 ? `${delta >= 0 ? 'Hausse' : 'Economie'} de ${currency(Math.abs(delta))}` : 'Comparaison indisponible'}</div>
        </div>
      </div>
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Cout par service</h2>
          <span className="text-xs muted">Top 15</span>
        </div>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={serviceRows.slice(0, 15)} margin={{ left: 12 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="service" tick={{ fontSize: 12 }} interval={0} angle={-30} textAnchor="end" height={80} />
              <YAxis />
              <Tooltip formatter={(value) => currency(value)} />
              <Bar dataKey="cost" name="Cout" fill="#0f172a" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="card p-4">
        <h2 className="mb-3 text-base font-semibold">Ressources les plus couteuses</h2>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr><th>Service</th><th>Region</th><th>Compte</th><th className="text-right">Cout</th></tr></thead>
            <tbody>
              {topRows.map((row, index) => {
                const accName = row.account_name || accountMap.get(row.linked_account) || row.linked_account || '-';
                return <tr key={`${row.service}-${row.region}-${index}`}><td>{row.service}</td><td>{row.region || '-'}</td><td>{accName}</td><td className="text-right">{currency(row.cost)}</td></tr>;
              })}
              {!topRows.length && <tr><td colSpan="4" className="py-4 text-center muted">Aucune donnee.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TabFallback() {
  return <StatusBanner>Chargement du module...</StatusBanner>;
}

export default function App() {
  const { accounts, accountMap, loading: accountsLoading, error: accountsError } = useAccounts();
  const regionsState = useEffectiveRegions();
  const freshnessState = useFreshness();
  const regionsEffective = regionsState.data;
  const [metric, setMetric] = useState(METRICS[0]);
  const [account, setAccount] = useState('');
  const [timeframe, setTimeframe] = useState('30j');
  const [mode, setMode] = useState('rel');
  const [absStart, setAbsStart] = useState(addDays(today(), -30));
  const [absEnd, setAbsEnd] = useState(today());
  const [tab, setTab] = useState('overview');
  const [riMode, setRiMode] = useState(true);
  const [regions, setRegions] = useState('');
  const [excludeTax, setExcludeTax] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [navCompact, setNavCompact] = useState(false);

  useEffect(() => {
    if (!regions && Array.isArray(regionsEffective) && regionsEffective.includes('eu-west-3')) setRegions('eu-west-3');
  }, [regions, regionsEffective]);

  const range = useMemo(() => {
    if (mode === 'abs') return { start: absStart, end: absEnd };
    const now = new Date();
    const end = toLocalDateString(now);
    if (timeframe === 'mois_courant') return { start: toLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1)), end };
    if (timeframe === 'mois_préc') return { start: toLocalDateString(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: toLocalDateString(new Date(now.getFullYear(), now.getMonth(), 0)) };
    const days = timeframe === '7j' ? 7 : timeframe === '90j' ? 90 : 30;
    return { start: addDays(now, -days), end };
  }, [timeframe, mode, absStart, absEnd]);

  const latestCostDay = useMemo(() => {
    const byMetric = freshnessState.data?.costs?.byMetric || {};
    return byMetric?.[metric]?.maxDay || freshnessState.data?.costs?.latestDay || null;
  }, [freshnessState.data, metric]);

  const effectiveRange = useMemo(() => ({
    start: range.start,
    end: latestCostDay ? minIsoDate(range.end, latestCostDay) : range.end,
  }), [range.start, range.end, latestCostDay]);

  const activeTab = TAB_DEFS.find((item) => item.id === tab) || TAB_DEFS[0];
  const headerRange = tab === 'overview' ? effectiveRange : range;
  const isOverviewCapped = tab === 'overview' && isIsoDate(effectiveRange.end) && isIsoDate(range.end) && effectiveRange.end < range.end;
  const filterSummary = [
    metric,
    account ? accountMap.get(account) || account : 'Tous comptes',
    regions || 'Toutes regions',
    `${range.start} -> ${range.end}`,
  ].join(' · ');
  const dbOnly = !!freshnessState.data?.dbOnly || freshnessState.data?.dataFrom === 'LOCAL_DB';
  const isDashboardRoute = window.location.pathname.replace(/\/+$/, '') === '/dashboard';

  if (isDashboardRoute) {
    return <DashboardPage accountMap={accountMap} freshnessState={freshnessState} />;
  }

  return (
    <div className={`app-shell ${navCompact ? 'nav-compact' : ''}`}>
      <aside className="side-nav">
        <div className="brand-block">
          <div className="brand-mark">$</div>
          <div className="brand-text">
            <h1>Costwatch</h1>
            <p>FinOps AWS</p>
          </div>
          <button type="button" className="nav-collapse" onClick={() => setNavCompact((current) => !current)} title={navCompact ? 'Afficher le menu' : 'Réduire le menu'} aria-label={navCompact ? 'Afficher le menu' : 'Réduire le menu'}>
            {navCompact ? '›' : '‹'}
          </button>
        </div>
        <nav className="tab-nav" aria-label="Navigation principale">
          {TAB_DEFS.map((item) => (
            <button key={item.id} type="button" className={`tab-link ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)} title={item.label}>
              <span className="tab-short">{item.short}</span>
              <span className="tab-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="main-panel">
        <header className="hero-panel">
          <div>
            <div className="eyebrow">{activeTab.short} / {metric}</div>
            <h2>{activeTab.label}</h2>
            <p>{headerRange.start} {'->'} {headerRange.end} · {regions || 'Toutes regions'} · {account ? accountMap.get(account) || account : 'Tous comptes'}</p>
          </div>
          <div className="hero-status">
            {regionsState.loading ? 'Regions...' : `${regionsEffective.length} region(s)`}
          </div>
        </header>
        {(accountsError || regionsState.error) && (
          <div className="mb-4 grid gap-2">
            {accountsError && <StatusBanner type="error">Comptes indisponibles : {accountsError.message}</StatusBanner>}
            {regionsState.error && <StatusBanner type="error">Regions indisponibles : {regionsState.error.message}</StatusBanner>}
          </div>
        )}
        <section className="freshness-banner">
          <div>
            <div className="freshness-title">Fraîcheur des données</div>
            <div className="freshness-text">
              {freshnessState.loading && 'Chargement de la fraîcheur...'}
              {freshnessState.error && `Fraîcheur indisponible : ${freshnessState.error.message || 'appel /api/meta/freshness'}`}
              {!freshnessState.loading && !freshnessState.error && (
                <>
                  Cost Explorer jusqu'au <strong>{latestCostDay || 'inconnu'}</strong>
                  {freshnessState.data?.s3?.latestDay ? <> · S3 jusqu'au <strong>{freshnessState.data.s3.latestDay}</strong></> : null}
                  {freshnessState.data?.ri?.coverageLatestDay ? <> · RI coverage jusqu'au <strong>{freshnessState.data.ri.coverageLatestDay}</strong></> : null}
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <TrustBadge type="real">Réel AWS</TrustBadge>
            <TrustBadge type="cache">{freshnessState.data?.costs?.source === 'db' ? 'Cache DB' : 'AWS API'}</TrustBadge>
            {dbOnly && <TrustBadge type="warn">Mode DB-only</TrustBadge>}
            {latestCostDay && <TrustBadge type="cache">Données jusqu'au {latestCostDay}</TrustBadge>}
            {isOverviewCapped && <TrustBadge type="warn">Vue plafonnée à {effectiveRange.end}</TrustBadge>}
          </div>
        </section>
        <section className={`filters-card ${filtersOpen ? '' : 'collapsed'}`}>
          <button type="button" className="filters-toggle" onClick={() => setFiltersOpen((current) => !current)} aria-expanded={filtersOpen}>
            <span>
              <strong>Filtres</strong>
              <small>{filterSummary}</small>
            </span>
            <span className="filters-toggle-action">{filtersOpen ? 'Réduire' : 'Afficher'}</span>
          </button>
          {filtersOpen && (
            <FilterPanel
              metric={metric}
              setMetric={setMetric}
              account={account}
              setAccount={setAccount}
              accounts={accounts}
              accountLoading={accountsLoading}
              mode={mode}
              setMode={setMode}
              absStart={absStart}
              setAbsStart={setAbsStart}
              absEnd={absEnd}
              setAbsEnd={setAbsEnd}
              timeframe={timeframe}
              setTimeframe={setTimeframe}
              regions={regions}
              setRegions={setRegions}
              regionsEffective={regionsEffective}
              excludeTax={excludeTax}
              setExcludeTax={setExcludeTax}
              riMode={riMode}
              setRiMode={setRiMode}
            />
          )}
        </section>
        <section className="content-panel">
          {tab === 'overview' && <Overview start={effectiveRange.start} end={effectiveRange.end} requestedEnd={range.end} metric={metric} account={account} regions={regions} accountMap={accountMap} excludeTax={excludeTax} latestCostDay={latestCostDay} />}
          <Suspense fallback={<TabFallback />}>
            {tab === 'insights' && <LazyInsightsTab start={effectiveRange.start} end={effectiveRange.end} snapshotEnd={range.end} metric={metric} account={account} regions={regions} accountMap={accountMap} excludeTax={excludeTax} />}
            {tab === 'ri' && <LazyRiTab start={range.start} end={range.end} accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} />}
            {tab === 'sp' && <LazySpTab start={range.start} end={range.end} selectedRegionsCsv={regions} accountMap={accountMap} />}
            {tab === 'ec2' && <LazyEC2Tab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} selectedAccount={account} />}
            {tab === 'calculator' && <LazyCalculatorTab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} selectedAccount={account} riMode={riMode} />}
            {tab === 'vpc' && <LazyVPCTab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} />}
            {tab === 'network-finops' && <LazyNetworkFinOpsTab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} selectedAccount={account} start={range.start} end={range.end} />}
            {tab === 's3' && <LazyS3Tab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} start={range.start} end={range.end} />}
          </Suspense>
        </section>
      </main>
    </div>
  );
}
