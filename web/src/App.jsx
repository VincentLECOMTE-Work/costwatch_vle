import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

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
