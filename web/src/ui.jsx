
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, LineChart, Line, ComposedChart } from 'recharts';
const __jsonCache = new Map();
function appendParams(url, paramsObj = {}, { cacheBuster = true } = {}) {
  const u = new URL(url, window.location.origin);
  const entries = Object.entries(paramsObj || {}).filter(([, v]) => !(v === undefined || v === null || v === ''));
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [k, v] of entries) { u.searchParams.set(k, v); }
  if (cacheBuster) { u.searchParams.set('_', String(Date.now())); }
  return u.toString();
}
async function getJSON(url, params = {}, opts = {}) {
  const { cacheTtlMs = 0, bypassCache = false, cacheBuster = true, signal, headers: extraHeaders, ...fetchInit } = opts;
  const cacheKey = appendParams(url, params, { cacheBuster: false });
  const cachedEntry = __jsonCache.get(cacheKey);
  const now = Date.now();
  if (!bypassCache && cacheTtlMs > 0 && cachedEntry && typeof cachedEntry === 'object') {
    if (now - (cachedEntry.ts || 0) <= cacheTtlMs) {
      return cachedEntry.value;
    }
  }

  const finalUrl = appendParams(url, params, { cacheBuster });
  const headers = { 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0', 'If-None-Match': '', ...(extraHeaders || {}) };
  const fetchOptions = { method: 'GET', cache: 'no-store', signal, headers, ...fetchInit };
  try {
    const res = await fetch(finalUrl, fetchOptions);
    if (res.status === 304 && cachedEntry && typeof cachedEntry === 'object') {
      return cachedEntry.value;
    }
    const contentType = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('content-type') || '')
      : '';
    const normalizedContentType = contentType.toLowerCase();
    const isJsonResponse = normalizedContentType === ''
      || normalizedContentType.includes('application/json')
      || normalizedContentType.includes('+json');
    if (!res.ok) {
      let errorBody = '';
      try {
        errorBody = await res.text();
      } catch (err) {
        console.debug('Failed to read error response body as text', err);
      }
      const statusLabel = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      const error = new Error(errorBody ? `${statusLabel}: ${errorBody}` : statusLabel);
      error.status = res.status;
      error.statusText = res.statusText;
      throw error;
    }
    if (!isJsonResponse) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch (err) {
        console.debug('Failed to read non-JSON response body as text', err);
      }
      const statusLabel = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      const error = new Error(bodyText ? `${statusLabel}: ${bodyText}` : statusLabel);
      error.status = res.status;
      error.statusText = res.statusText;
      throw error;
    }
    const js = await res.json();
    __jsonCache.set(cacheKey, { value: js, ts: Date.now() });
    return js;
  } catch (e) {
    console.error(e);
    if (cachedEntry && typeof cachedEntry === 'object') {
      return cachedEntry.value;
    }
    throw e;
  }
}

async function sendJSON(url, body = {}, method = 'PUT') {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let errorBody = '';
    try { errorBody = await res.text(); } catch {}
    const error = new Error(errorBody ? `HTTP ${res.status}: ${errorBody}` : `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = Math.max(1, date.getDate());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | day;
  return { time, date: dosDate };
}

function makeZipHeader(type, nameBytes, entry, offset = 0) {
  const isCentral = type === 'central';
  const header = new Uint8Array((isCentral ? 46 : 30) + nameBytes.length);
  const view = new DataView(header.buffer);
  if (isCentral) {
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, entry.time, true);
    view.setUint16(14, entry.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    return header;
  }
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, entry.time, true);
  view.setUint16(12, entry.date, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function createZipBlob(files, type = 'application/zip') {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const { time, date } = dosDateTime();
    const entry = { size: data.length, crc: crc32(data), time, date };
    const localHeader = makeZipHeader('local', nameBytes, entry);
    localParts.push(localHeader, data);
    centralParts.push(makeZipHeader('central', nameBytes, entry, offset));
    offset += localHeader.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, eocd], { type });
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(index) {
  let n = Number(index || 0);
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

function xlsxCellXml(value, ref, style = 0) {
  const styleAttr = style ? ` s="${style}"` : '';
  if (value == null || value === '') return `<c r="${ref}"${styleAttr}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"${styleAttr}><v>${value ? 1 : 0}</v></c>`;
  const text = String(value);
  const preserve = /^\s|\s$|\n|\r/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t${preserve}>${xmlEscape(text)}</t></is></c>`;
}

function buildWorksheetXml(rows = []) {
  const maxCols = Math.max(1, ...rows.map(row => Array.isArray(row) ? row.length : 0));
  const maxRows = Math.max(1, rows.length);
  const dimension = `A1:${excelColumnName(maxCols)}${maxRows}`;
  const widths = Array.from({ length: maxCols }, (_, idx) => {
    const maxLen = rows.reduce((max, row) => Math.max(max, String(row?.[idx] ?? '').length), 8);
    return Math.min(60, Math.max(10, maxLen + 2));
  });
  const cols = widths.map((width, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${width}" customWidth="1"/>`).join('');
  const sheetRows = rows.map((row, rIdx) => {
    const rowNumber = rIdx + 1;
    const cells = Array.from({ length: maxCols }, (_, cIdx) => {
      const ref = `${excelColumnName(cIdx + 1)}${rowNumber}`;
      return xlsxCellXml(row?.[cIdx], ref, rIdx === 0 ? 1 : 0);
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function createXlsxBlob(sheetName, rows) {
  const safeSheetName = xmlEscape(String(sheetName || 'Export').slice(0, 31).replace(/[\\/?*\[\]:]/g, ' '));
  const files = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    {
      name: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
    },
    { name: 'xl/worksheets/sheet1.xml', content: buildWorksheetXml(rows) }
  ];
  return createZipBlob(files, XLSX_MIME);
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(objectUrl);
  link.remove();
}

const METRICS = ["UnblendedCost","AmortizedCost"];
const HOURS_PER_DAY = 24;
const HOURS_PER_MONTH = 730;
const HOURS_PER_YEAR = 8760;
const DAYS_PER_MONTH_APPROX = HOURS_PER_MONTH / HOURS_PER_DAY;
const DAYS_PER_YEAR = HOURS_PER_YEAR / HOURS_PER_DAY;
const currency = (n)=> new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(n||0));

function formatCurrency(value, currencyCode = 'USD', options = {}) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  const code = currencyCode || 'USD';
  const {
    maximumFractionDigits,
    minimumFractionDigits,
    ...rest
  } = options || {};
  const formatOptions = {
    style: 'currency',
    currency: code,
    ...rest,
  };
  if (maximumFractionDigits != null) formatOptions.maximumFractionDigits = maximumFractionDigits;
  if (minimumFractionDigits != null) formatOptions.minimumFractionDigits = minimumFractionDigits;
  if (formatOptions.maximumFractionDigits == null) formatOptions.maximumFractionDigits = 2;
  try {
    return new Intl.NumberFormat(undefined, formatOptions).format(amount);
  } catch (err) {
    const digits = formatOptions.maximumFractionDigits ?? 2;
    return `${amount.toFixed(digits)} ${code}`.trim();
  }
}

function formatHourlyRate(value, currencyCode = 'USD', options = {}) {
  const opts = { maximumFractionDigits: 4, ...options };
  const label = formatCurrency(value, currencyCode, opts);
  if (!label) return '';
  return `${label}/h`;
}

function formatDurationFromSeconds(seconds) {
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const totalDays = Math.floor(totalSeconds / 86400);
  const years = Math.floor(totalDays / 365);
  const months = Math.floor((totalDays % 365) / 30);
  const days = totalDays % 30;
  const parts = [];
  if (years > 0) parts.push(`${years} an${years > 1 ? 's' : ''}`);
  if (months > 0 && parts.length < 2) parts.push(`${months} mois`);
  if (days > 0 && parts.length < 2) parts.push(`${days} j`);
  if (!parts.length) {
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    if (totalDays >= 1 && hours > 0) {
      parts.push(`${totalDays} j`);
      parts.push(`${hours} h`);
    } else if (hours > 0) {
      parts.push(`${hours} h`);
    } else {
      const minutes = Math.max(1, Math.round((totalSeconds % 3600) / 60));
      parts.push(`${minutes} min`);
    }
  }
  return parts.join(' ');
}

function formatRecurringChargesTooltip(recurringCharges, currencyCode = 'USD') {
  if (!recurringCharges) return '';
  const arr = Array.isArray(recurringCharges)
    ? recurringCharges
    : Array.isArray(recurringCharges?.RecurringCharges)
      ? recurringCharges.RecurringCharges
      : Array.isArray(recurringCharges?.recurringCharges)
        ? recurringCharges.recurringCharges
        : [];
  if (!arr.length) return '';
  const lines = arr.map((entry) => {
    const amount = entry?.amount ?? entry?.Amount;
    const freq = entry?.frequency ?? entry?.Frequency ?? '';
    const curr = entry?.currencyCode ?? entry?.CurrencyCode ?? currencyCode;
    const formatted = formatCurrency(amount, curr, { maximumFractionDigits: 2 });
    if (!formatted) return null;
    return freq ? `${formatted} • ${freq}` : formatted;
  }).filter(Boolean);
  return lines.join('\n');
}

function formatHours(value, decimals = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const fixed = num.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1') : fixed;
}

function buildScheduleTooltip(schedule) {
  if (!schedule || typeof schedule !== 'object') return '';
  const lines = [];
  const name = schedule.name || '';
  if (name) lines.push(`Horaire: ${name}`);
  if (schedule.timezone) lines.push(`Fuseau horaire: ${schedule.timezone}`);
  if (Number.isFinite(schedule.averageDailyHours)) {
    lines.push(`Moyenne jours actifs: ${formatHours(schedule.averageDailyHours)} h/j`);
  }
  if (Number.isFinite(schedule.averageDailyHoursAllDays)) {
    lines.push(`Moyenne 7 jours: ${formatHours(schedule.averageDailyHoursAllDays)} h/j`);
  }
  if (Number.isFinite(schedule.totalWeeklyHours)) {
    lines.push(`Total hebdomadaire: ${formatHours(schedule.totalWeeklyHours)} h`);
  }
  const periods = Array.isArray(schedule.periods) ? schedule.periods : [];
  if (periods.length) {
    lines.push('Périodes:');
    periods.forEach(period => {
      const periodParts = [];
      const periodName = period?.name ? String(period.name) : '';
      if (periodName) periodParts.push(periodName);
      const begin = period?.begintime ? String(period.begintime) : '';
      const end = period?.endtime ? String(period.endtime) : '';
      if (begin || end) {
        periodParts.push([begin || '—', end || '—'].join(' → '));
      }
      const weekdaysRaw = period?.weekdays;
      const weekdays = Array.isArray(weekdaysRaw)
        ? weekdaysRaw
        : weekdaysRaw
          ? String(weekdaysRaw).split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
          : [];
      if (weekdays.length) {
        periodParts.push(weekdays.join(', '));
      }
      if (Number.isFinite(period?.durationHours)) {
        periodParts.push(`${formatHours(period.durationHours)} h`);
      }
      if (periodParts.length) {
        lines.push(`• ${periodParts.join(' | ')}`);
      }
    });
  }
  if (schedule.missing) {
    lines.push('Configuration introuvable dans DynamoDB');
  }
  return lines.join('\n');
}

const SCHEDULE_DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SCHEDULE_DAY_DISPLAY = [
  { key: 'mon', label: 'L' },
  { key: 'tue', label: 'M' },
  { key: 'wed', label: 'M' },
  { key: 'thu', label: 'J' },
  { key: 'fri', label: 'V' },
  { key: 'sat', label: 'S' },
  { key: 'sun', label: 'D' }
];
const SCHEDULE_DAY_ALIASES = new Map([
  ['monday', 'mon'],
  ['mon', 'mon'],
  ['lundi', 'mon'],
  ['lun', 'mon'],
  ['tuesday', 'tue'],
  ['tues', 'tue'],
  ['tue', 'tue'],
  ['mardi', 'tue'],
  ['mar', 'tue'],
  ['wednesday', 'wed'],
  ['wed', 'wed'],
  ['mercredi', 'wed'],
  ['mer', 'wed'],
  ['thursday', 'thu'],
  ['thur', 'thu'],
  ['thu', 'thu'],
  ['jeudi', 'thu'],
  ['jeu', 'thu'],
  ['friday', 'fri'],
  ['fri', 'fri'],
  ['vendredi', 'fri'],
  ['ven', 'fri'],
  ['saturday', 'sat'],
  ['sat', 'sat'],
  ['samedi', 'sat'],
  ['sam', 'sat'],
  ['sunday', 'sun'],
  ['sun', 'sun'],
  ['dimanche', 'sun'],
  ['dim', 'sun'],
  ['weekdays', 'weekdays'],
  ['weekends', 'weekends'],
  ['daily', 'all'],
  ['alldays', 'all'],
  ['everyday', 'all'],
  ['all', 'all']
]);

function normalizeScheduleDayToken(token = '') {
  return String(token || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z-]/g, '');
}

function expandScheduleDayToken(token) {
  const normalized = normalizeScheduleDayToken(token);
  if (!normalized) return [];
  if (normalized.includes('-')) {
    const [startRaw, endRaw] = normalized.split('-', 2);
    const startAlias = SCHEDULE_DAY_ALIASES.get(startRaw) || startRaw;
    const endAlias = SCHEDULE_DAY_ALIASES.get(endRaw) || endRaw;
    const startIdx = SCHEDULE_DAY_ORDER.indexOf(startAlias);
    const endIdx = SCHEDULE_DAY_ORDER.indexOf(endAlias);
    if (startIdx !== -1 && endIdx !== -1) {
      const days = [];
      let idx = startIdx;
      let guard = 0;
      while (guard < SCHEDULE_DAY_ORDER.length) {
        days.push(SCHEDULE_DAY_ORDER[idx]);
        if (idx === endIdx) break;
        idx = (idx + 1) % SCHEDULE_DAY_ORDER.length;
        guard += 1;
      }
      return days;
    }
  }
  const alias = SCHEDULE_DAY_ALIASES.get(normalized);
  if (alias === 'weekdays') return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (alias === 'weekends') return ['sat', 'sun'];
  if (alias === 'all') return [...SCHEDULE_DAY_ORDER];
  if (alias && SCHEDULE_DAY_ORDER.includes(alias)) return [alias];
  if (SCHEDULE_DAY_ORDER.includes(normalized)) return [normalized];
  return [];
}

function resolveSchedulePeriodDays(period) {
  if (!period || !period.weekdays) return [];
  const raw = period.weekdays;
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[\s,]+/)
        .map(token => token.trim())
        .filter(Boolean);
  const seen = new Set();
  tokens.forEach(token => {
    const expanded = expandScheduleDayToken(token);
    if (expanded.length) {
      expanded.forEach(day => seen.add(day));
    }
  });
  return Array.from(seen);
}

function collectScheduleActiveDays(periods) {
  const active = new Set();
  (periods || []).forEach(period => {
    resolveSchedulePeriodDays(period).forEach(day => active.add(day));
  });
  return active;
}

function formatScheduleTimeLabel(value) {
  if (value == null) return '';
  const str = String(value).trim();
  if (!str) return '';
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!match) return str;
  const hours = match[1].padStart(2, '0');
  const minutesRaw = match[2] != null ? match[2] : match[3];
  const minutes = minutesRaw != null ? minutesRaw.padStart(2, '0') : '00';
  return `${hours}:${minutes}`;
}

function formatSchedulePeriodRange(period) {
  if (!period) return '';
  const begin = formatScheduleTimeLabel(period.begintime);
  const end = formatScheduleTimeLabel(period.endtime);
  if (!begin && !end) return '';
  return `${begin || '—'} => ${end || '—'}`;
}
const toLocalDateString = (value) => {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
};
const addDays=(d,n)=>{
  const base = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  if (Number.isNaN(base.getTime())) return '';
  base.setDate(base.getDate()+n);
  return toLocalDateString(base);
};
const toExclusiveEnd = (value) => {
  if (value == null || value === '') return value;
  return addDays(value, 1);
};
const buildRangeSearchParams = (start, end, extra = {}) => {
  const params = new URLSearchParams(extra);
  if (start != null && start !== '') params.set('start', start);
  if (end != null && end !== '') params.set('end', toExclusiveEnd(end));
  return params;
};
const today = ()=> toLocalDateString(new Date());

const emptyBucketTs = ()=>({ series: [], seriesByClass: {}, classes: {}, objects: null });
const emptyS3ListMeta = () => ({ cached: false, source: null, asOf: null, fetchedAt: null });
const S3_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const SIZE_FLEX_REASON_LABELS = {
  scope: "Scope ≠ Region",
  platform: "Plateforme ≠ Linux/UNIX partagé",
  tenancy: "Tenancy ≠ default",
  instanceType: "Type d'instance non éligible aux unités normalisées"
};

function buildSizeFlexTooltip(info){
  if (!info || typeof info !== 'object') return '';
  if (info.flexible) return "Couverture flexible (Linux région)";
  const reasons = Array.isArray(info.reasons) ? info.reasons : [];
  if (!reasons.length) return '';
  const mapped = reasons.map(r => SIZE_FLEX_REASON_LABELS[r] || r);
  return ['Pas de flexibilité de taille', ...mapped].join('\n');
}
function normalizeBucketTimeseriesPayload(raw){
  if (!raw) return emptyBucketTs();
  const ensureNumber = (v)=>{ const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const ensureDateLabel = (v)=>{
    if (!v) return '';
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return toLocalDateString(d);
    return String(v).slice(0,10);
  };

  const series = [];
  const seriesByClass = {};
  let classes = {};
  let objects = (raw.objects!=null) ? ensureNumber(raw.objects) : null;

  if (Array.isArray(raw.series) && raw.series.length){
    for (const point of raw.series){
      const label = ensureDateLabel(point.t || point.day || point.date || point.time || point.ts);
      const bytes = ensureNumber(point.bytes_total ?? point.bytes ?? point.value);
      series.push({ t: label, bytes });
    }
    if (raw.seriesByClass && typeof raw.seriesByClass === 'object'){
      for (const [cls, arr] of Object.entries(raw.seriesByClass)){
        seriesByClass[cls] = Array.isArray(arr)
          ? arr.map(p=>({ t: ensureDateLabel(p.t || p.day || p.date || p.time || p.ts), bytes: ensureNumber(p.bytes_total ?? p.bytes ?? p.value) }))
          : [];
      }
    }
    if (raw.classes && typeof raw.classes === 'object'){
      classes = Object.fromEntries(Object.entries(raw.classes).map(([k,v])=>[k, ensureNumber(v)]));
    }
    return { series, seriesByClass, classes, objects };
  }

  const items = Array.isArray(raw.items) ? raw.items.slice() : [];
  if (!items.length) return emptyBucketTs();
  items.sort((a,b)=>{
    const da = new Date(a.day || a.date || a.time || a.ts || 0).getTime();
    const db = new Date(b.day || b.date || b.time || b.ts || 0).getTime();
    return da - db;
  });

  for (const it of items){
    const label = ensureDateLabel(it.day || it.date || it.time || it.ts);
    const totalBytes = ensureNumber(it.bytes_total ?? it.bytes ?? it.totalBytes);
    series.push({ t: label, bytes: totalBytes });

    const byClass = it.bytes_by_class || it.by_class || it.classes || {};
    for (const [cls, value] of Object.entries(byClass)){
      if (!seriesByClass[cls]) seriesByClass[cls] = [];
      seriesByClass[cls].push({ t: label, bytes: ensureNumber(value) });
    }

    if (it.objects_total != null) objects = ensureNumber(it.objects_total);
  }

  const latest = items[items.length-1] || {};
  const latestClasses = latest.bytes_by_class || latest.by_class || latest.classes || {};
  classes = Object.fromEntries(Object.entries(latestClasses).map(([k,v])=>[k, ensureNumber(v)]));

  if ((!objects || !Number.isFinite(objects)) && latest.objects_total!=null) objects = ensureNumber(latest.objects_total);

  return { series, seriesByClass, classes, objects };
}


function usePricing(region){
  const [tbl,setTbl]=useState(null);
  useEffect(()=>{
    if (!region) return;
    setTbl(null);
    getJSON('/api/s3/pricing', { region }).then(setTbl).catch(()=>setTbl(null));
  }, [region]);
  return tbl;
}





function useEffectiveRegions() {
  const [regions, setRegions] = useState([]);
  useEffect(() => {
    fetch('/api/meta/runtime')
      .then(r => r.json())
      .then(d => {
        const asList = v => Array.isArray(v) ? v : String(v||'').split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean);
        const fromApi = asList(d && d.regionsEffective);
        const fromDb = asList(d && d.regionsFromDb);
        const union = Array.from(new Set([...fromApi, ...fromDb].filter(Boolean)));
        setRegions(union.length ? union : ['us-east-1']);
      })
      .catch(() => setRegions(['us-east-1']));
  }, []);
  return regions;
}
function useAccounts(){
  const [accounts,setAccounts]=useState([]);
  useEffect(()=>{
    fetch('/api/accounts')
      .then(r=>r.json())
      .then(d=>{
        const arr = Array.isArray(d) ? d : (d.rows || d.items || []);
        setAccounts(arr.map(x=>({ id: x.accountId || x.id, name: x.accountName || x.name || x.accountId || x.id })));
      })
      .catch(()=>setAccounts([]));
  },[]);
  const byId = useMemo(()=> new Map(accounts.map(a=>[a.id,a.name])),[accounts]);
  return { accounts, accountMap: byId };
}



function RegionsPicker({ value, onChange, knownRegions=['eu-west-3','us-east-1'] }) {
  const [open, setOpen] = useState(false);
  const selected = (value || '').split(',').filter(Boolean);
  const toggle = (r) => {
    const s = new Set(selected);
    if (s.has(r)) s.delete(r); else s.add(r);
    const next = Array.from(s).join(',');
    onChange(next);
  };
  return (
    <div className="inline-block relative">
      <button className="btn btn-secondary" onClick={()=>setOpen(!open)}>
        Régions: {selected.length ? selected.join(', ') : 'Toutes'}
      </button>
      {open && (
        <div className="absolute z-10 mt-2 p-2 card shadow-lg bg-white border">
          <div className="mb-2">
            <button className="btn btn-sm" onClick={()=>onChange('')}>Toutes</button>
          </div>
          {knownRegions.map(r => (
            <label key={r} className="block cursor-pointer my-1">
              <input type="checkbox" checked={selected.includes(r)} onChange={()=>toggle(r)} /> <span className="ml-1">{r}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="inline-flex items-center cursor-pointer ml-3">
      <input type="checkbox" className="mr-1" checked={checked} onChange={e=>onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function TrustBadge({ type = 'info', children }) {
  return <span className={`trust-badge trust-badge-${type}`}>{children}</span>;
}

function Header({metric,setMetric,account,setAccount,accounts,mode,setMode,absStart,setAbsStart,absEnd,setAbsEnd,timeframe,setTimeframe, regions, setRegions, regionsEffective, excludeTax, setExcludeTax, riMode, setRiMode}){
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-black/90 text-white grid place-items-center shadow">$</div>
        <div><h1 className="text-2xl font-semibold">Costwatch</h1><p className="text-sm muted">CE – {metric}</p></div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2"><span className="muted text-sm">Métrique</span>
          <select className="select" value={metric} onChange={e=>setMetric(e.target.value)}>
            {METRICS.map(m=><option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2"><span className="muted text-sm">Compte</span>
          <select className="select" value={account} onChange={e=>setAccount(e.target.value)}>
            <option value="">Tous</option>
            {accounts.map(a=><option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
          </select>
        </div>

        <RegionsPicker value={regions} onChange={setRegions} knownRegions={regionsEffective} />
        <Toggle checked={riMode} onChange={setRiMode} label="Inclure RI/SP dans le calculateur" />
        <Toggle checked={excludeTax} onChange={setExcludeTax} label="Retirer TAX" />
        <div className="flex items-center gap-2"><span className="muted text-sm">Période</span>
          <div className="flex gap-1">
            {["7j","30j","90j","mois_courant","mois_préc"].map(k=>{
              const label = ({'7j':"7 j",'30j':"30 j",'90j':"90 j",'mois_courant':"Mois courant",'mois_préc':"Mois préc."})[k];
              return <button key={k} className={'btn '+(timeframe===k?'btn-primary':'')} onClick={()=>setTimeframe(k)}>{label}</button>;
            })}
            <button className={'btn '+(mode==='abs'?'btn-primary':'')} onClick={()=>setMode(mode==='abs'?'rel':'abs')}>Dates</button>
          </div>
        </div>
        {mode==='abs' && (
          <div className="flex items-center gap-2">
            <input className="input" type="date" value={absStart} onChange={e=>setAbsStart(e.target.value)} />
            <span className="muted text-sm">→</span>
            <input className="input" type="date" value={absEnd} onChange={e=>setAbsEnd(e.target.value)} />
          </div>
        )}
      </div>
    </header>
  );
}

function normalizeRows(d){
  return Array.isArray(d) ? d : (d?.rows || d?.items || []);
}

const extractAccountId = (row = {}) => {
  const candidates = [
    row.accountId,
    row.AccountId,
    row.account_id,
    row.account,
    row.ownerId,
    row.OwnerId,
    row.awsAccountId,
    row.aws_account_id,
    row.payerAccountId,
    row.payer_account_id,
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null && String(val) !== '') {
      return String(val);
    }
  }
  return '';
};

const extractInstanceName = (inst = {}) => {
  const tagObjectName = inst?.tags && !Array.isArray(inst.tags)
    ? (inst.tags.Name || inst.tags.name)
    : '';
  let tagArrayName = '';
  if (Array.isArray(inst?.tags)) {
    const nameTag = inst.tags.find(t => {
      const key = String(t?.Key ?? t?.key ?? '').toLowerCase();
      return key === 'name';
    });
    if (nameTag) tagArrayName = nameTag?.Value ?? nameTag?.value ?? '';
  }
  return inst?.name
    || inst?.Name
    || inst?.instanceName
    || inst?.InstanceName
    || tagObjectName
    || tagArrayName
    || '';
};

function Overview({start, end, metric, account, regions, accountMap, excludeTax}){
  const [daily,setDaily]=useState([]);
  const [byService,setByService]=useState([]);
  const [top,setTop]=useState([]);
  const [previousDaily,setPreviousDaily]=useState([]);
  const [previousByService,setPreviousByService]=useState([]);

  const buildParams = useCallback((startDate, endDate) => {
    const params = buildRangeSearchParams(startDate, endDate, { metric });
    if (account) params.set('accounts', account);
    if (regions) params.set('regions', regions);
    return params.toString();
  }, [metric, account, regions]);

  const previousRange = useMemo(() => {
    if (!start || !end) return null;
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;

    const startDay = startDate.getDate();
    const endDay = endDate.getDate();
    const sameMonth = startDate.getFullYear() === endDate.getFullYear()
      && startDate.getMonth() === endDate.getMonth();
    const lastDayOfMonth = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate();

    const isFullMonth = startDay === 1 && endDay === lastDayOfMonth;
    const isMonthToDate = !isFullMonth && sameMonth && startDay === 1 && endDay < lastDayOfMonth;

    const prevMonthEnd = new Date(startDate.getFullYear(), startDate.getMonth(), 0);
    const prevMonthStart = new Date(prevMonthEnd.getFullYear(), prevMonthEnd.getMonth(), 1);

    if (isFullMonth) {
      return {
        start: toLocalDateString(prevMonthStart),
        end: toLocalDateString(prevMonthEnd),
      };
    }

    if (isMonthToDate) {
      const prevMonthLastDay = prevMonthEnd.getDate();
      const prevEndDay = Math.min(endDay, prevMonthLastDay);
      const prevEnd = new Date(prevMonthEnd.getFullYear(), prevMonthEnd.getMonth(), prevEndDay);
      return {
        start: toLocalDateString(prevMonthStart),
        end: toLocalDateString(prevEnd),
      };
    }

    const dayMs = 24*60*60*1000;
    const diffDays = Math.max(0, Math.round((endDate - startDate) / dayMs));
    const span = diffDays + 1;
    const prevEnd = new Date(startDate);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - span + 1);
    return { start: toLocalDateString(prevStart), end: toLocalDateString(prevEnd) };
  }, [start, end]);

  // --- Derived totals with TAX filter (fix66) ---
  const byServiceFiltered = excludeTax
    ? (byService || []).filter(x => String(x.service || '').toLowerCase() !== 'tax')
    : (byService || []);
  const previousByServiceFiltered = useMemo(() => {
    if (!excludeTax) return previousByService;
    return (previousByService || []).filter(x => String(x.service || '').toLowerCase() !== 'tax');
  }, [previousByService, excludeTax]);
  const topFiltered = useMemo(() => {
    if (!excludeTax) return top;
    return (top || []).filter(item => String(item.service || '').toLowerCase() !== 'tax');
  }, [top, excludeTax]);
  const total = (daily || []).reduce((s,x)=>s+Number(x.cost||0),0);
  const servicesTotal = (byService || []).reduce((s,x)=>s+Number(x.cost||0),0);
  const servicesTotalFiltered = (byServiceFiltered || []).reduce((s,x)=>s+Number(x.cost||0),0);
  const displayTotal = excludeTax ? servicesTotalFiltered : (total || servicesTotal);
  const previousTotal = (previousDaily || []).reduce((s,x)=>s+Number(x.cost||0),0);
  const previousServicesTotal = (previousByService || []).reduce((s,x)=>s+Number(x.cost||0),0);
  const previousServicesTotalFiltered = (previousByServiceFiltered || []).reduce((s,x)=>s+Number(x.cost||0),0);
  const previousDisplay = excludeTax ? previousServicesTotalFiltered : (previousTotal || previousServicesTotal);
  const delta = displayTotal - (previousDisplay || 0);
  const deltaPct = previousDisplay > 0 ? (delta / previousDisplay) * 100 : null;
  const displayPct = deltaPct != null ? (deltaPct > 0 ? '+' : '') + deltaPct.toFixed(1) + '%' : null;
  const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const trendColor = trend === 'up' ? 'text-red-600' : trend === 'down' ? 'text-green-600' : 'text-slate-500';
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
  const hasPrevious = previousRange && (previousDaily.length || previousByService.length);
  let deltaLabel = 'Variation indisponible';
  if (deltaPct != null) {
    if (trend === 'up') {
      deltaLabel = `Augmentation de ${displayPct} (${currency(delta)})`;
    } else if (trend === 'down') {
      const pctAbs = Math.abs(deltaPct).toFixed(1) + '%';
      deltaLabel = `Économie de ${pctAbs} (${currency(Math.abs(delta))})`;
    } else {
      deltaLabel = 'Coût identique à la période précédente';
    }
  } else if (hasPrevious) {
    if (trend === 'up') {
      deltaLabel = `Augmentation de ${currency(delta)}`;
    } else if (trend === 'down') {
      deltaLabel = `Économie de ${currency(Math.abs(delta))}`;
    } else {
      deltaLabel = 'Coût identique à la période précédente';
    }
  }

  useEffect(()=>{
    if (!start || !end) { setDaily([]); return; }
    fetch('/api/costs/daily-total?'+buildParams(start, end))
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({date: x.date || x.day || x.time || today(), cost: Number(x.cost ?? x.amountUSD ?? x.Amount ?? 0)}));
        setDaily(arr);
      })
      .catch(()=>setDaily([]));
  },[buildParams,start,end]);

  useEffect(()=>{
    if (!previousRange) { setPreviousDaily([]); return; }
    fetch('/api/costs/daily-total?'+buildParams(previousRange.start, previousRange.end))
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({date: x.date || x.day || x.time || today(), cost: Number(x.cost ?? x.amountUSD ?? x.Amount ?? 0)}));
        setPreviousDaily(arr);
      })
      .catch(()=>setPreviousDaily([]));
  },[buildParams, previousRange]);

  useEffect(()=>{
    if (!start || !end) { setByService([]); return; }
    fetch('/api/costs/by-service?'+buildParams(start, end))
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({ service: x.service || x.Service || 'Autre', cost: Number(x.cost ?? x.amountUSD ?? 0) }));
        setByService(arr.sort((a,b)=>b.cost-a.cost));
      })
      .catch(()=>setByService([]));
  },[buildParams,start,end]);

  useEffect(()=>{
    if (!previousRange) { setPreviousByService([]); return; }
    fetch('/api/costs/by-service?'+buildParams(previousRange.start, previousRange.end))
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({ service: x.service || x.Service || 'Autre', cost: Number(x.cost ?? x.amountUSD ?? 0) }));
        setPreviousByService(arr.sort((a,b)=>b.cost-a.cost));
      })
      .catch(()=>setPreviousByService([]));
  },[buildParams, previousRange]);

  useEffect(()=>{
    if (!start || !end) { setTop([]); return; }
    fetch('/api/costs/top-combos?limit=15&'+buildParams(start, end))
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({
          service: x.service || x.Service || 'Autre',
          region: x.region || x.Region || '',
          linked_account: x.linked_account || x.linkedAccount || x.accountId || '',
          account_name: x.account_name || x.accountName || ''
        , cost: Number(x.cost ?? 0)
        }));
        setTop(arr);
      })
      .catch(()=>setTop([]));
  },[buildParams,start,end]);
const activeServices = byServiceFiltered.filter(x=>Number(x.cost)>0).length;

  return (<>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div className="card p-4">
        <div className="text-sm muted">Coût estimé ({metric})</div>
        <div className="text-3xl font-bold">{currency(displayTotal)}</div>
        <div className="h-20">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" hide />
              <YAxis hide />
              <Tooltip formatter={v=>currency(v)} />
              <Area type="monotone" dataKey="cost" strokeWidth={2} fillOpacity={0.3} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="card p-4">
        <div className="text-sm muted">Services actifs</div>
        <div className="text-3xl font-bold">{activeServices}</div>
        <div className="h-20">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byServiceFiltered.slice(0,10)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis hide dataKey="service" />
              <YAxis hide />
              <Tooltip formatter={v=>currency(v)} />
              <Bar dataKey="cost" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="card p-4">
        <div className="text-sm muted">Évolution vs période précédente</div>
        <div className={`text-3xl font-bold flex items-center gap-2 ${trendColor}`}>
          <span>{trendIcon}</span>
          <span>{displayPct ?? '—'}</span>
        </div>
        <div className="text-xs muted">{hasPrevious ? deltaLabel : 'Données insuffisantes pour comparer.'}</div>
      </div>
    </div>

    <div className="card p-4 mb-6">
      <div className="text-base font-semibold mb-3">Coût par service</div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={byServiceFiltered.slice(0,15)} margin={{left:12}}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="service" tick={{fontSize: 12}} interval={0} angle={-30} textAnchor="end" height={70}/>
            <YAxis />
            <Tooltip formatter={v=>currency(v)} />
            <Legend />
            <Bar dataKey="cost" name="Coût" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>

    <div className="card p-4">
      <div className="text-base font-semibold mb-3">Ressources les plus coûteuses</div>
      <div className="overflow-auto">
        <table className="table w-full text-sm">
          <thead><tr><th>Service</th><th>Région</th><th>Compte</th><th className="text-right">Coût</th></tr></thead>
          <tbody>
            { (topFiltered||[]).map((r,i)=>{
              const accName = r.account_name || accountMap.get(r.linked_account) || r.linked_account || "—";
              return (<tr key={i}><td>{r.service}</td><td>{r.region||"—"}</td><td>{accName}</td><td className="text-right">{currency(r.cost)}</td></tr>);
            })}
            {(topFiltered||[]).length===0 && <tr><td colSpan="4" className="text-center muted py-4">Aucune donnée.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  </>);
}

function RiTab({start,end,accountMap, selectedRegionsCsv, regionsEffective}){
  const regions = useMemo(() => {
    const fromHeader = String(selectedRegionsCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (fromHeader.length) return fromHeader;
    return Array.isArray(regionsEffective) ? regionsEffective : [];
  }, [selectedRegionsCsv, regionsEffective]);
  const [util,setUtil]=useState([]); const [utilByAcct,setUtilByAcct]=useState([]); const [cov,setCov]=useState([]); const [ris,setRis]=useState([]);
  const [mapping,setMapping]=useState({ reservations: [], uncoveredInstances: [] });
  const [hideRetired,setHideRetired]=useState(false);
  const [hideInactiveInstances,setHideInactiveInstances]=useState(false);
  const [startAfter,setStartAfter]=useState('');
  const [riSortKey, setRiSortKey] = useState('start');
  const [riSortDir, setRiSortDir] = useState('asc');
  const [mappingSortKey, setMappingSortKey] = useState('end');
  const [mappingSortDir, setMappingSortDir] = useState('asc');
  const regionParam = useMemo(() => (Array.isArray(regions) && regions.length ? regions.join(',') : 'eu-west-3'), [regions]);
  const ensureNumber = useCallback((v)=>{ const n = Number(v); return Number.isFinite(n) ? n : 0; }, []);
  const risFiltered=useMemo(()=>{
    return (Array.isArray(ris)?ris:[])
      .filter(r=>{
        const a=r.attributes||r||{};
        if (hideRetired && String(a.state||a.State||'').toLowerCase()==='retired') return false;
        if (startAfter){
          const s=String(a.start||a.Start||'').slice(0,10);
          if (!s || s<startAfter) return false;
        }
        return true;
      });
  },[ris,hideRetired,startAfter]);

  const handleRiSort = useCallback((key)=>{
    const defaultDirForKey = (k) => {
      switch (k) {
        case 'start':
        case 'end':
          return 'asc';
        case 'rate':
          return 'asc';
        default:
          return 'asc';
      }
    };
    setRiSortKey(prevKey=>{
      if (prevKey === key){
        setRiSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setRiSortDir(defaultDirForKey(key));
      return key;
    });
  },[]);

  const renderRiSortIndicator = useCallback((key)=>{
    if (riSortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{riSortDir === 'asc' ? '↑' : '↓'}</span>;
  },[riSortKey, riSortDir]);

  const risSorted = useMemo(()=>{
    const arr = risFiltered.slice();
    if (!riSortKey) return arr;
    const getValue = (row, key) => {
      const a = row.attributes || row || {};
      switch (key) {
        case 'account':
          return (accountMap && accountMap.get(a.accountId || a.ownerId || a.AccountId)) || a.accountName || a.accountId || a.ownerId || a.AccountId || '';
        case 'id':
          return a.reservedInstancesId || a.ReservedInstancesId || '';
        case 'os':
          return a.productDescription || a.ProductDescription || '';
        case 'type':
          return a.instanceType || a.InstanceType || '';
        case 'scope':
          return a.scope || a.Scope || '';
        case 'offering':
          return a.offeringType || a.OfferingType || '';
        case 'start': {
          const str = a.start || a.Start || '';
          const ts = str ? Date.parse(str) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        case 'end': {
          const str = a.end || a.End || '';
          const ts = str ? Date.parse(str) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        case 'class':
          return a.offeringClass || a.OfferingClass || a.InstanceClass || '';
        case 'rate': {
          const val = a.effectiveHourlyRate ?? a.EffectiveHourlyRate;
          const num = Number(val);
          return Number.isFinite(num) ? num : null;
        }
        case 'state':
          return a.state || a.State || '';
        default:
          return null;
      }
    };
    arr.sort((a,b)=>{
      const av = getValue(a, riSortKey);
      const bv = getValue(b, riSortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return riSortDir === 'asc' ? 1 : -1;
      if (bv == null) return riSortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number'){
        return riSortDir === 'asc' ? av - bv : bv - av;
      }
      return riSortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  },[risFiltered, riSortKey, riSortDir, accountMap]);


  useEffect(()=>{ const p=buildRangeSearchParams(start,end);
    fetch('/api/ri/utilization?'+p.toString())
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({
          date: x.date || x.day || x.time || start,
          purchasedHours: Number(x.purchasedHours ?? x.PurchasedHours ?? 0),
          totalActualHours: Number(x.totalActualHours ?? x.TotalActualHours ?? 0),
          unusedHours: Number(x.unusedHours ?? x.UnusedHours ?? 0),
          utilizationPct: Number(x.utilizationPct ?? x.UtilizationPercentage ?? 0)
        }));
        setUtil(arr);
      })
      .catch(()=>setUtil([]));
  },[start,end]);

  useEffect(()=>{ const p=buildRangeSearchParams(start,end,{groupBy:'SUBSCRIPTION_ID'});
    fetch('/api/ri/utilization-by?'+p.toString())
      .then(r=>r.json())
      .then(d=>{
        const rows = normalizeRows(d);
        const map = new Map();
        for (const r of rows){
          const attr = r.attributes || {};
          const id = attr.accountId || attr.subscriptionId || attr.SubscriptionId || '';
          if (!id) continue;
          const name = attr.accountName || attr.accountAlias || attr.AccountName || id;
          const purchased = Number(r.purchasedHours ?? r.PurchasedHours ?? 0);
          const actual = Number(r.totalActualHours ?? r.TotalActualHours ?? 0);
          const unused = Number(r.unusedHours ?? r.UnusedHours ?? 0);
          const prev = map.get(id) || { id, name, purchased:0, actual:0, unused:0 };
          prev.purchased += purchased; prev.actual += actual; prev.unused += unused;
          map.set(id, prev);
        }
        const out = Array.from(map.values()).map(x=>({ ...x, utilPct: x.purchased>0 ? (x.actual/x.purchased)*100 : 0 }));
        out.sort((a,b)=>b.utilPct - a.utilPct);
        setUtilByAcct(out);
      })
      .catch(()=>setUtilByAcct([]));
  },[start,end]);

  useEffect(()=>{ const p=buildRangeSearchParams(start,end,{by:'PLATFORM,INSTANCE_TYPE'});
    fetch('/api/ri/coverage?'+p.toString())
      .then(r=>r.json())
      .then(d=>{
        const arr = normalizeRows(d).map(x=>({
          date: x.date || start,
          attributes: x.attributes || {},
          coveragePct: Number(x.coveragePct ?? x.CoveragePercentage ?? 0),
          reservedHours: Number(x.reservedHours ?? 0),
          onDemandHours: Number(x.onDemandHours ?? 0),
          totalRunningHours: Number(x.totalRunningHours ?? 0),
          coverageHours: Number(x.coverageHours ?? 0)
        }));
        setCov(arr);
      })
      .catch(()=>setCov([]));
  },[start,end]);

  useEffect(()=>{
    if (!regionParam) return;
    fetch('/api/ri/reservations?regions='+regionParam)
      .then(r=>r.json())
      .then(d=>setRis(normalizeRows(d)))
      .catch(()=>setRis([]));
  },[regionParam]);

  useEffect(()=>{
    if (!regionParam) return;
    fetch('/api/ri/mapping?regions='+regionParam)
      .then(r=>r.json())
      .then(d=>{
        const reservations = Array.isArray(d?.reservations) ? d.reservations : [];
        const uncovered = Array.isArray(d?.uncoveredInstances) ? d.uncoveredInstances : [];
        setMapping({ reservations, uncoveredInstances: uncovered });
      })
      .catch(()=>setMapping({ reservations: [], uncoveredInstances: [] }));
  },[regionParam]);

  const getInstanceState = useCallback((inst)=>{
    const raw = inst?.state ?? inst?.State ?? inst?.instanceState ?? inst?.InstanceState ?? inst?.status ?? inst?.Status ?? '';
    return String(raw || '');
  }, []);

  const isInactiveInstance = useCallback((inst)=>{
    const state = getInstanceState(inst).toLowerCase();
    if (!state) return false;
    if (state.includes('stopp')) return true;
    if (state.includes('termin')) return true;
    return false;
  }, [getInstanceState]);

  const formatCount = useCallback((value)=>{
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    if (Math.abs(num - Math.round(num)) < 1e-6) return Math.round(num).toLocaleString();
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }, []);

  const mappingReservationsFiltered = useMemo(()=>{
    const arr = Array.isArray(mapping?.reservations) ? mapping.reservations : [];
    const filtered = arr.filter(r=>{
      const state = String(r.state||'').toLowerCase();
      if (hideRetired && state === 'retired') return false;
      if (startAfter){
        const s = String(r.start||'').slice(0,10);
        if (!s || s < startAfter) return false;
      }
      return true;
    }).map(r=>{
      const instances = Array.isArray(r.matchedInstances) ? r.matchedInstances : [];
      const filteredInstances = hideInactiveInstances ? instances.filter(inst=>!isInactiveInstance(inst)) : instances;
      const totalFromApi = r.effectiveTotalCount ?? r.instanceCount ?? r.InstanceCount ?? r.totalInstanceCount ?? r.totalCount;
      const totalCount = ensureNumber(totalFromApi ?? instances.length);
      const usedFromApi = r.effectiveUsedCount ?? r.usedCount ?? r.UsedCount;
      const usedCount = Number.isFinite(Number(usedFromApi)) ? ensureNumber(usedFromApi) : instances.length;
      const unusedFromApi = r.effectiveUnusedCount ?? r.unusedCount ?? r.UnusedCount;
      const unusedCount = Number.isFinite(Number(unusedFromApi)) ? ensureNumber(unusedFromApi) : Math.max(0, totalCount - usedCount);
      return {
        ...r,
        matchedInstances: filteredInstances,
        effectiveTotalCount: totalCount,
        effectiveUsedCount: usedCount,
        effectiveUnusedCount: unusedCount,
      };
    });
    return filtered;
  },[mapping, hideRetired, startAfter, hideInactiveInstances, ensureNumber, isInactiveInstance]);

  const handleMappingSort = useCallback((key)=>{
    const defaultDirForKey = (k) => {
      switch (k) {
        case 'coverage':
        case 'instances':
          return 'desc';
        case 'end':
          return 'asc';
        case 'rate':
          return 'asc';
        default:
          return 'asc';
      }
    };
    setMappingSortKey(prevKey=>{
      if (prevKey === key){
        setMappingSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setMappingSortDir(defaultDirForKey(key));
      return key;
    });
  },[]);

  const renderMappingSortIndicator = useCallback((key)=>{
    if (mappingSortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{mappingSortDir === 'asc' ? '↑' : '↓'}</span>;
  },[mappingSortKey, mappingSortDir]);

  const mappingReservationsSorted = useMemo(()=>{
    const arr = mappingReservationsFiltered.slice();
    if (!mappingSortKey) return arr;
    const getValue = (row, key) => {
      switch (key) {
        case 'account':
          return (accountMap && accountMap.get(row.accountId)) || row.accountName || row.accountId || '';
        case 'ri':
          return row.reservedInstancesId || row.ReservedInstancesId || '';
        case 'os':
          return row.productDescription || '';
        case 'type':
          return row.instanceType || '';
        case 'scope':
          return row.scope || '';
        case 'offering':
          return row.offeringType || '';
        case 'rate': {
          const val = row.effectiveHourlyRate ?? row.EffectiveHourlyRate;
          const num = Number(val);
          return Number.isFinite(num) ? num : null;
        }
        case 'start': {
          const str = row.start || '';
          const ts = str ? Date.parse(str) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        case 'coverage': {
          const total = ensureNumber(row.effectiveTotalCount ?? row.instanceCount ?? row.InstanceCount ?? row.totalCount ?? row.totalInstanceCount);
          const used = ensureNumber(row.effectiveUsedCount ?? row.usedCount ?? row.UsedCount);
          return total > 0 ? used / total : 0;
        }
        case 'end': {
          const str = row.end || '';
          const ts = str ? Date.parse(str) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        case 'instances':
          return Array.isArray(row.matchedInstances) ? row.matchedInstances.length : 0;
        default:
          return null;
      }
    };
    arr.sort((a,b)=>{
      const av = getValue(a, mappingSortKey);
      const bv = getValue(b, mappingSortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return mappingSortDir === 'asc' ? 1 : -1;
      if (bv == null) return mappingSortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number'){
        return mappingSortDir === 'asc' ? av - bv : bv - av;
      }
      return mappingSortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  },[mappingReservationsFiltered, mappingSortKey, mappingSortDir, accountMap, ensureNumber]);

  const uncoveredInstancesRaw = useMemo(()=>Array.isArray(mapping?.uncoveredInstances)?mapping.uncoveredInstances:[],[mapping]);
  const uncoveredInstances = useMemo(()=>{
    if (!hideInactiveInstances) return uncoveredInstancesRaw;
    return uncoveredInstancesRaw.filter(inst=>!isInactiveInstance(inst));
  },[uncoveredInstancesRaw, hideInactiveInstances, isInactiveInstance]);
  const [uncoveredSortKey, setUncoveredSortKey] = useState(null);
  const [uncoveredSortDir, setUncoveredSortDir] = useState('asc');

  const handleUncoveredSort = useCallback((key)=>{
    setUncoveredSortKey(prevKey=>{
      if (prevKey === key){
        setUncoveredSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      const defaultDir = key === 'launchTime' ? 'desc' : 'asc';
      setUncoveredSortDir(defaultDir);
      return key;
    });
  },[]);

  const renderUncoveredSortIndicator = useCallback((key)=>{
    if (uncoveredSortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{uncoveredSortDir === 'asc' ? '↑' : '↓'}</span>;
  },[uncoveredSortKey, uncoveredSortDir]);

  const uncoveredSorted = useMemo(()=>{
    const arr = uncoveredInstances.slice();
    if (!uncoveredSortKey) return arr;
    const getValue = (row, key) => {
      switch (key) {
        case 'account':
          return (accountMap && accountMap.get(row.accountId || extractAccountId(row))) || row.accountId || extractAccountId(row) || '';
        case 'instanceId':
          return row.instanceId || row.InstanceId || row.id || '';
        case 'name':
          return extractInstanceName(row) || '';
        case 'type':
          return row.instanceType || row.type || '';
        case 'platform':
          return row.platform || 'Linux/UNIX';
        case 'ri':
          return row.riCovered ? 1 : 0;
        case 'schedule':
          return (row.schedule && row.schedule.name) || '';
        case 'az':
          return row.availabilityZone || row.az || '';
        case 'privIp':
          return row.privateIp || '';
        case 'pubIp':
          return row.publicIp || '';
        case 'launchTime': {
          const str = row.launchTime || row.LaunchTime || '';
          const ts = str ? Date.parse(str) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        case 'state':
          return getInstanceState(row) || row.state || '';
        default:
          return null;
      }
    };
    arr.sort((a,b)=>{
      const av = getValue(a, uncoveredSortKey);
      const bv = getValue(b, uncoveredSortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return uncoveredSortDir === 'asc' ? 1 : -1;
      if (bv == null) return uncoveredSortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number'){
        return uncoveredSortDir === 'asc' ? av - bv : bv - av;
      }
      return uncoveredSortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  },[uncoveredInstances, uncoveredSortKey, uncoveredSortDir, accountMap, getInstanceState]);

  const mappingSummary = useMemo(()=>{
    let totalCapacity = 0;
    let totalUsed = 0;
    let totalUnused = 0;
    for (const ri of mappingReservationsFiltered){
      const total = ensureNumber(ri.effectiveTotalCount ?? ri.instanceCount ?? ri.InstanceCount ?? ri.totalCount ?? ri.totalInstanceCount ?? (Array.isArray(ri.matchedInstances) ? ri.matchedInstances.length : 0));
      const used = ensureNumber(ri.effectiveUsedCount ?? ri.usedCount ?? ri.UsedCount ?? (Array.isArray(ri.matchedInstances) ? ri.matchedInstances.length : 0));
      const unused = (ri.effectiveUnusedCount != null)
        ? ensureNumber(ri.effectiveUnusedCount)
        : (()=>{
            const raw = ri.unusedCount ?? ri.UnusedCount;
            if (raw != null) return ensureNumber(raw);
            return Math.max(0, total - used);
          })();
      totalCapacity += total;
      totalUsed += used;
      totalUnused += unused;
    }
    return { totalCapacity, totalUsed, totalUnused };
  },[mappingReservationsFiltered, ensureNumber]);

  const utilSeries = util.map(x=>({ date:x.date, pct:Number(x.utilizationPct||0) }));
  const overall = (()=>{
    const t = util.reduce((s,x)=>s+Number(x.totalActualHours||0),0);
    const p = util.reduce((s,x)=>s+Number(x.purchasedHours||0),0);
    const u = util.reduce((s,x)=>s+Number(x.unusedHours||0),0);
    const pct = p>0 ? (t/p)*100 : 0; return {t,p,u,pct};
  })();

  return (<>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div className="card p-4">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <div className="text-sm muted">Utilisation globale (RI)</div>
          <TrustBadge type="real">Réel AWS officiel</TrustBadge>
          <TrustBadge type="cache">Cache CE</TrustBadge>
        </div>
        <div className="text-3xl font-bold">{overall.pct.toFixed(1)}%</div>
        <div className="h-24">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={utilSeries}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" hide />
              <YAxis hide domain={[0,100]} />
              <Tooltip formatter={(v)=>`${Number(v).toFixed(1)}%`} />
              <Line type="monotone" dataKey="pct" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="text-xs muted mt-1">TotalActualHours: {overall.t.toFixed(0)} • PurchasedHours: {overall.p.toFixed(0)} • Unused: {overall.u.toFixed(0)}</div>
      </div>
      <div className="card p-4 md:col-span-2">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="text-sm muted">Couverture RI officielle (par OS & type)</div>
          <TrustBadge type="real">Réel AWS officiel</TrustBadge>
          <TrustBadge type="cache">Cache CE</TrustBadge>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr><th>Période</th><th>OS</th><th>Type</th><th className="text-right">Coverage %</th><th className="text-right">Reserved H</th><th className="text-right">OnDemand H</th></tr></thead>
            <tbody>
              {cov.map((r,i)=>(
                <tr key={i}><td>{r.date}</td><td>{r.attributes.platform||'—'}</td><td>{r.attributes.instanceType||'—'}</td>
                <td className="text-right">{r.coveragePct.toFixed(1)}%</td><td className="text-right">{r.reservedHours.toFixed(0)}</td><td className="text-right">{r.onDemandHours.toFixed(0)}</td></tr>
              ))}
              {cov.length===0 && <tr><td colSpan="6" className="text-center muted py-4">Pas de données de couverture.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div className="card p-4 mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="text-sm muted">Utilisation moyenne (période) par compte</div>
          <TrustBadge type="real">Réel AWS officiel</TrustBadge>
        </div>
      <div className="overflow-auto">
        <table className="table w-full text-sm">
          <thead><tr><th>Compte</th><th className="text-right">Util %</th><th className="text-right">Purchased</th><th className="text-right">Actual</th><th className="text-right">Unused</th></tr></thead>
          <tbody>
            {utilByAcct.map((r,i)=>{
              const nm = r.name || accountMap.get(r.id) || r.id;
              return <tr key={i}><td>{nm}</td><td className="text-right">{r.utilPct.toFixed(1)}%</td><td className="text-right">{r.purchased.toFixed(0)}</td><td className="text-right">{r.actual.toFixed(0)}</td><td className="text-right">{r.unused.toFixed(0)}</td></tr>;
            })}
            {utilByAcct.length===0 && <tr><td colSpan="5" className="text-center muted py-4">Pas de données d'utilisation.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm muted">Réservations actives</div>
          <TrustBadge type="real">Réel AWS</TrustBadge>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="checkbox" checked={hideRetired} onChange={e=>setHideRetired(e.target.checked)} />
            <span className="text-sm">Masquer les "retired"</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="checkbox" checked={hideInactiveInstances} onChange={e=>setHideInactiveInstances(e.target.checked)} />
            <span className="text-sm">Masquer les instances stopped/terminated</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            Début ≥ <input type="date" className="input" value={startAfter} onChange={e=>setStartAfter(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="overflow-auto">
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="cursor-pointer" onClick={()=>handleRiSort('account')}>Compte {renderRiSortIndicator('account')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('id')}>ID {renderRiSortIndicator('id')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('os')}>OS {renderRiSortIndicator('os')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('type')}>Type {renderRiSortIndicator('type')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('scope')}>Scope {renderRiSortIndicator('scope')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('offering')}>Offre {renderRiSortIndicator('offering')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('start')}>Début {renderRiSortIndicator('start')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('end')}>Fin {renderRiSortIndicator('end')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('class')}>Classe {renderRiSortIndicator('class')}</th>
              <th className="cursor-pointer text-right" onClick={()=>handleRiSort('rate')}>Tarif eff./h {renderRiSortIndicator('rate')}</th>
              <th className="cursor-pointer" onClick={()=>handleRiSort('state')}>État {renderRiSortIndicator('state')}</th>
            </tr>
          </thead>
          <tbody>
            {risSorted.map((x,i)=>{
              const a = x.attributes || x || {};
              const acc = a.accountId || a.ownerId || a.AccountId || (x && x.accountId) || '';
              const accName = (accountMap && accountMap.get(acc)) || a.accountName || acc || '—';
              const currencyCode = a.currencyCode || a.CurrencyCode || 'USD';
              const effectiveRateLabel = (a.effectiveHourlyRate != null && a.effectiveHourlyRate !== '') ? formatHourlyRate(Number(a.effectiveHourlyRate), currencyCode) : '';
              const usageRateLabel = (a.usagePrice != null && a.usagePrice !== '') ? formatHourlyRate(Number(a.usagePrice), currencyCode) : '';
              const upfrontLabel = (a.fixedPrice != null && a.fixedPrice !== '' && Number(a.fixedPrice) !== 0) ? formatCurrency(Number(a.fixedPrice), currencyCode) : '';
              const durationLabel = formatDurationFromSeconds(a.duration ?? a.Duration);
              const recurringLabel = formatRecurringChargesTooltip(a.recurringCharges, currencyCode);
              const rateTitleParts = [];
              if (durationLabel) rateTitleParts.push(`Durée: ${durationLabel}`);
              if (usageRateLabel) rateTitleParts.push(`Usage: ${usageRateLabel}`);
              if (upfrontLabel) rateTitleParts.push(`Upfront: ${upfrontLabel}`);
              if (recurringLabel) rateTitleParts.push(`Charges récurrentes:\n${recurringLabel}`);
              if (a.currencyCode) rateTitleParts.push(`Devise: ${a.currencyCode}`);
              const rateTitle = rateTitleParts.length ? rateTitleParts.join('\n') : undefined;
              return <tr key={i}>
                <td>{accName}</td>
                <td>{a.reservedInstancesId || a.ReservedInstancesId || '—'}</td>
                <td>{a.productDescription || a.ProductDescription || '—'}</td>
                <td>{a.instanceType || a.InstanceType || '—'}</td>
                <td>{a.scope || a.Scope || '—'}</td>
                <td>{a.offeringType || a.OfferingType || '—'}</td>
                <td>{String(a.start || a.Start || '').slice(0,10)}</td>
                <td>{String(a.end || a.End || '').slice(0,10)}</td>
                <td>{a.offeringClass || a.OfferingClass || a.InstanceClass || '—'}</td>
                <td className="text-right tabular-nums" title={rateTitle}>
                  <div className="flex flex-col items-end leading-tight">
                    <span>{effectiveRateLabel || '—'}</span>
                    {usageRateLabel && <span className="text-[11px] text-slate-600">Usage: {usageRateLabel}</span>}
                    {upfrontLabel && <span className="text-[11px] text-slate-600">Upfront: {upfrontLabel}</span>}
                    {durationLabel && <span className="text-[10px] text-slate-500">Durée: {durationLabel}</span>}
                    {a.currencyCode && <span className="text-[10px] uppercase text-slate-500">{a.currencyCode}</span>}
                  </div>
                </td>
              <td>{a.state || a.State || '—'}</td>
            </tr>;
          })}
            {risFiltered.length===0 && <tr><td colSpan="11" className="text-center muted py-4">Aucune réservation (ou droits EC2 insuffisants).</td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    <div className="card p-4 mt-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm muted">Mapping estimé RI ↔ Instances</div>
            <TrustBadge type="real">Réel AWS</TrustBadge>
            <TrustBadge type="estimate">Estimation locale</TrustBadge>
          </div>
          <div className="text-xs muted">Régions : {regionParam || '—'}</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
          <div><div className="muted text-xs uppercase tracking-wide">Capacité totale</div><div className="text-base font-semibold tabular-nums">{formatCount(mappingSummary.totalCapacity||0)}</div></div>
          <div><div className="muted text-xs uppercase tracking-wide">Instances couvertes</div><div className="text-base font-semibold text-emerald-600 tabular-nums">{formatCount(mappingSummary.totalUsed||0)}</div></div>
          <div><div className="muted text-xs uppercase tracking-wide">Unités restantes</div><div className="text-base font-semibold text-amber-600 tabular-nums">{formatCount(mappingSummary.totalUnused||0)}</div></div>
        </div>
      </div>

      <div className="overflow-auto mb-4">
        <table className="table table-wrap w-full text-sm">
          <thead>
            <tr>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('account')}>Compte {renderMappingSortIndicator('account')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('ri')}>RI {renderMappingSortIndicator('ri')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('os')}>OS {renderMappingSortIndicator('os')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('type')}>Type {renderMappingSortIndicator('type')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('scope')}>Scope {renderMappingSortIndicator('scope')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('offering')}>Offre {renderMappingSortIndicator('offering')}</th>
              <th className="cursor-pointer text-right" onClick={()=>handleMappingSort('rate')}>Tarif effectif/h {renderMappingSortIndicator('rate')}</th>
              <th className="cursor-pointer text-right" onClick={()=>handleMappingSort('coverage')}>Couvert {renderMappingSortIndicator('coverage')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('end')}>Fin {renderMappingSortIndicator('end')}</th>
              <th className="cursor-pointer" onClick={()=>handleMappingSort('instances')}>Instances associées {renderMappingSortIndicator('instances')}</th>
            </tr>
          </thead>
          <tbody>
            {mappingReservationsSorted.map((ri,i)=>{
              const accountId = ri.accountId || '';
              const accountName = (accountMap && accountMap.get(accountId)) || accountId || '—';
              const instances = Array.isArray(ri.matchedInstances) ? ri.matchedInstances : [];
              const sizeFlexInfo = ri.sizeFlexibility && typeof ri.sizeFlexibility === 'object' ? ri.sizeFlexibility : null;
              const total = ensureNumber(ri.effectiveTotalCount ?? ri.instanceCount ?? ri.InstanceCount ?? ri.totalCount ?? ri.totalInstanceCount ?? instances.length);
              const used = ensureNumber(ri.effectiveUsedCount ?? ri.usedCount ?? ri.UsedCount ?? instances.length);
              const unused = (ri.effectiveUnusedCount != null)
                ? ensureNumber(ri.effectiveUnusedCount)
                : (()=>{
                    const raw = ri.unusedCount ?? ri.UnusedCount;
                    if (raw != null) return ensureNumber(raw);
                    return Math.max(0, total - used);
                  })();
              const usedLabel = formatCount(used);
              const totalLabel = formatCount(total);
              const unusedLabel = unused > 0 ? formatCount(unused) : null;
              const countTitleParts = [];
              if (ri.normalizedTotalUnits != null){
                const normUsed = ri.normalizedUsedUnits ?? (used * (ri.instanceNormalizationFactor || 1));
                countTitleParts.push(`Unités normalisées: ${formatCount(normUsed)} / ${formatCount(ri.normalizedTotalUnits)}`);
              }
              if (ri.instanceNormalizationFactor){
                countTitleParts.push(`Facteur de normalisation: ${formatCount(ri.instanceNormalizationFactor)}`);
              }
              if (ri.sizeFlexible){
                countTitleParts.push('Couverture flexible (Linux région)');
              } else if (sizeFlexInfo && Array.isArray(sizeFlexInfo.reasons) && sizeFlexInfo.reasons.length){
                const labels = sizeFlexInfo.reasons.map(r => SIZE_FLEX_REASON_LABELS[r] || r);
                countTitleParts.push(['Pas de flexibilité de taille', ...labels].join('\n'));
              }
              const countTitle = countTitleParts.length ? countTitleParts.join('\n') : undefined;
              const sizeFlexTooltip = buildSizeFlexTooltip(sizeFlexInfo);
              const currencyCode = ri.currencyCode || ri.CurrencyCode || 'USD';
              const effectiveHourlyRate = (ri.effectiveHourlyRate != null && ri.effectiveHourlyRate !== '') ? Number(ri.effectiveHourlyRate) : null;
              const usageRateLabel = (ri.usagePrice != null && ri.usagePrice !== '') ? formatHourlyRate(Number(ri.usagePrice), currencyCode) : '';
              const upfrontLabel = (ri.fixedPrice != null && ri.fixedPrice !== '' && Number(ri.fixedPrice) !== 0) ? formatCurrency(Number(ri.fixedPrice), currencyCode) : '';
              const totalRateLabel = (ri.effectiveHourlyRateTotal != null && ri.effectiveHourlyRateTotal !== '') ? `${formatCurrency(Number(ri.effectiveHourlyRateTotal), currencyCode, { maximumFractionDigits: 4 })}/h` : '';
              const perUnitRateLabel = (ri.effectiveHourlyRatePerNormalizedUnit != null && ri.effectiveHourlyRatePerNormalizedUnit !== '')
                ? `${formatCurrency(Number(ri.effectiveHourlyRatePerNormalizedUnit), currencyCode, { maximumFractionDigits: 6 })}/h`
                : '';
              const durationLabel = formatDurationFromSeconds(ri.duration ?? ri.Duration);
              const recurringLabel = formatRecurringChargesTooltip(ri.recurringCharges, currencyCode);
              const rateTitleParts = [];
              if (usageRateLabel) rateTitleParts.push(`Usage: ${usageRateLabel}`);
              if (upfrontLabel) rateTitleParts.push(`Upfront: ${upfrontLabel}`);
              if (totalRateLabel) rateTitleParts.push(`Total (réservation): ${totalRateLabel}`);
              if (perUnitRateLabel) rateTitleParts.push(`Par unité normalisée: ${perUnitRateLabel}`);
              if (durationLabel) rateTitleParts.push(`Durée: ${durationLabel}`);
              if (recurringLabel) rateTitleParts.push(`Charges récurrentes:\n${recurringLabel}`);
              if (ri.currencyCode) rateTitleParts.push(`Devise: ${ri.currencyCode}`);
              const rateTitle = rateTitleParts.length ? rateTitleParts.join('\n') : undefined;
              const effectiveRateLabel = effectiveHourlyRate != null ? formatHourlyRate(effectiveHourlyRate, currencyCode) : '';
              return (
                <tr key={`${ri.reservedInstancesId || ri.reservedinstancesid || ri.ReservedInstancesId || 'ri'}-${i}`}>
                  <td>{accountName}</td>
                  <td>{ri.reservedInstancesId || ri.ReservedInstancesId || '—'}</td>
                  <td>{ri.productDescription || '—'}</td>
                  <td>
                    {ri.instanceType || '—'}
                    {ri.sizeFlexible && <span className="text-[10px] text-amber-600 ml-1" title="Couverture flexible (Linux région)">★</span>}
                    {!ri.sizeFlexible && sizeFlexTooltip && <span className="text-[10px] text-slate-500 ml-1" title={sizeFlexTooltip}>ⓘ</span>}
                  </td>
                  <td>{ri.scope || '—'}</td>
                  <td>{ri.offeringType || '—'}</td>
                  <td className="text-right tabular-nums" title={rateTitle}>{effectiveRateLabel || '—'}</td>
                  <td className="text-right tabular-nums" title={countTitle}>{usedLabel}/{totalLabel}{unusedLabel ? ` (${unusedLabel} libres)` : ''}</td>
                  <td>{String(ri.end || '').slice(0,10) || '—'}</td>
                  <td>
                    <div className="flex flex-wrap gap-1 max-w-3xl">
                      {instances.map((inst, idx)=>{
                        const key = inst.instanceId || inst.name || `instance-${idx}`;
                        const label = inst.name || inst.instanceId || 'Instance';
                        return (
                          <span key={key} className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 text-xs">
                            {label}
                            {inst.instanceId && <span className="muted text-[10px] ml-1">{inst.instanceId}</span>}
                          </span>
                        );
                      })}
                      {instances.length===0 && <span className="muted text-xs">—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {mappingReservationsFiltered.length===0 && <tr><td colSpan="10" className="text-center muted py-4">Aucune correspondance disponible.</td></tr>}
          </tbody>
        </table>
      </div>

      <div>
        <div className="text-sm muted mb-2">Instances non couvertes ({uncoveredInstances.length})</div>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('account')}>Compte {renderUncoveredSortIndicator('account')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('instanceId')}>InstanceId {renderUncoveredSortIndicator('instanceId')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('name')}>Nom {renderUncoveredSortIndicator('name')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('type')}>Type {renderUncoveredSortIndicator('type')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('platform')}>Plateforme {renderUncoveredSortIndicator('platform')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('ri')}>RI {renderUncoveredSortIndicator('ri')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('schedule')}>Horaire {renderUncoveredSortIndicator('schedule')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('az')}>AZ {renderUncoveredSortIndicator('az')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('privIp')}>PrivIP {renderUncoveredSortIndicator('privIp')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('pubIp')}>PubIP {renderUncoveredSortIndicator('pubIp')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('launchTime')}>Lancement {renderUncoveredSortIndicator('launchTime')}</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('state')}>État {renderUncoveredSortIndicator('state')}</th>
              </tr>
            </thead>
            <tbody>
              {uncoveredSorted.map((inst,i)=>{
                const accountId = inst.accountId || extractAccountId(inst) || '';
                const accountName = (accountMap && accountMap.get(accountId)) || accountId || '—';
                const coverage = inst.riCoverage || {};
                const currencyCode = coverage.currencyCode || coverage.CurrencyCode || 'USD';
                const effectiveRateLabel = (coverage.effectiveHourlyRate != null && coverage.effectiveHourlyRate !== '')
                  ? formatHourlyRate(Number(coverage.effectiveHourlyRate), currencyCode)
                  : '';
                const usageRateLabel = (coverage.usagePrice != null && coverage.usagePrice !== '')
                  ? formatHourlyRate(Number(coverage.usagePrice), currencyCode)
                  : '';
                const upfrontLabel = (coverage.fixedPrice != null && coverage.fixedPrice !== '' && Number(coverage.fixedPrice) !== 0)
                  ? formatCurrency(Number(coverage.fixedPrice), currencyCode)
                  : '';
                const durationLabel = formatDurationFromSeconds(coverage.duration ?? coverage.Duration);
                const recurringLabel = formatRecurringChargesTooltip(coverage.recurringCharges, currencyCode);
                const riTitle = inst.riCovered
                  ? [
                      coverage.reservedInstancesId ? `RI: ${coverage.reservedInstancesId}` : null,
                      coverage.scope ? `Scope: ${coverage.scope}` : null,
                      coverage.availabilityZone ? `AZ: ${coverage.availabilityZone}` : null,
                      coverage.end ? `Fin: ${String(coverage.end).slice(0,10)}` : null,
                      coverage.offeringClass ? `Classe: ${coverage.offeringClass}` : null,
                      coverage.offeringType ? `Offre: ${coverage.offeringType}` : null,
                      durationLabel ? `Durée: ${durationLabel}` : null,
                      usageRateLabel ? `Tarif usage: ${usageRateLabel}` : null,
                      upfrontLabel ? `Upfront: ${upfrontLabel}` : null,
                      effectiveRateLabel ? `Tarif effectif: ${effectiveRateLabel}` : null,
                      recurringLabel ? `Charges récurrentes:\n${recurringLabel}` : null,
                      coverage.currencyCode ? `Devise: ${coverage.currencyCode}` : null,
                    ].filter(Boolean).join('\n')
                  : '';
                const schedule = inst.schedule || null;
                const scheduleName = schedule?.name || '';
                const scheduleMissing = !!(schedule && schedule.missing);
                const scheduleAvgActive = Number.isFinite(schedule?.averageDailyHours) ? schedule.averageDailyHours : null;
                const scheduleAvgAllDays = Number.isFinite(schedule?.averageDailyHoursAllDays) ? schedule.averageDailyHoursAllDays : null;
                const scheduleWeeklyHours = Number.isFinite(schedule?.totalWeeklyHours) ? schedule.totalWeeklyHours : null;
                const scheduleTimezone = schedule?.timezone || '';
                const scheduleTitle = buildScheduleTooltip(schedule);
                const scheduleAvgAllDaysLabel = scheduleAvgAllDays != null ? formatHours(scheduleAvgAllDays) : '';
                const scheduleAvgActiveLabel = scheduleAvgActive != null ? formatHours(scheduleAvgActive) : '';
                const scheduleWeeklyLabel = scheduleWeeklyHours != null ? formatHours(scheduleWeeklyHours) : '';
                const schedulePeriods = Array.isArray(schedule?.periods) ? schedule.periods.filter(Boolean) : [];
                const schedulePeriodRanges = schedulePeriods
                  .map((period, idx) => {
                    const label = formatSchedulePeriodRange(period);
                    if (!label) return null;
                    const periodName = period?.name ? String(period.name) : '';
                    return { key: periodName ? `${periodName}-${idx}` : `period-${idx}`, label };
                  })
                  .filter(Boolean);
                const scheduleActiveDays = collectScheduleActiveDays(schedulePeriods);
                const launchStr = String(inst.launchTime || inst.LaunchTime || '').slice(0, 19).replace('T', ' ');
                return (
                  <tr key={`${inst.instanceId || inst.name || 'uncovered'}-${i}`}>
                    <td>{accountName}</td>
                    <td>{inst.instanceId || '—'}</td>
                    <td>{extractInstanceName(inst) || inst.name || '—'}</td>
                    <td>{inst.instanceType || inst.type || '—'}</td>
                    <td>{inst.platform || 'Linux/UNIX'}</td>
                    <td title={riTitle || undefined}>
                      {inst.riCovered
                        ? <span className="inline-flex flex-col text-emerald-600 text-xs font-medium">
                            <span>Oui</span>
                            {inst.riCoverage?.reservedInstancesId && <span className="text-[11px] text-emerald-700/80">{inst.riCoverage.reservedInstancesId}</span>}
                            {effectiveRateLabel && <span className="text-[11px] text-emerald-700/80">{effectiveRateLabel}</span>}
                            {coverage.offeringType && <span className="text-[10px] uppercase tracking-wide text-emerald-700/70">{coverage.offeringType}</span>}
                          </span>
                        : <span className="muted text-xs">Non</span>}
                    </td>
                    <td title={scheduleTitle || undefined}>
                      {scheduleName
                        ? (
                            <span className="inline-flex flex-col text-xs text-slate-700">
                              <span className="text-sm font-medium text-slate-800">{scheduleName}</span>
                              {scheduleMissing
                                ? <span className="text-[11px] text-rose-600">Introuvable</span>
                                : (
                                  <>
                                    {schedulePeriodRanges.map(period => (
                                      <span key={period.key} className="text-[11px] text-slate-600">{period.label}</span>
                                    ))}
                                    {scheduleActiveDays.size > 0 && (
                                      <span className="mt-0.5 inline-flex text-[11px] font-semibold">
                                        {SCHEDULE_DAY_DISPLAY.map(day => (
                                          <span
                                            key={day.key}
                                            className={`leading-none ${scheduleActiveDays.has(day.key) ? 'text-emerald-600' : 'text-rose-500'}`}
                                          >
                                            {day.label}
                                          </span>
                                        ))}
                                      </span>
                                    )}
                                    {scheduleAvgAllDaysLabel && <span className="text-[11px] text-slate-600">{scheduleAvgAllDaysLabel} h/j (7j)</span>}
                                    {!scheduleAvgAllDaysLabel && scheduleAvgActiveLabel && <span className="text-[11px] text-slate-600">{scheduleAvgActiveLabel} h/j (actif)</span>}
                                    {scheduleWeeklyLabel && <span className="text-[11px] text-slate-600">{scheduleWeeklyLabel} h/sem</span>}
                                    {scheduleTimezone && <span className="text-[10px] text-slate-500">{scheduleTimezone}</span>}
                                  </>
                                )}
                            </span>
                          )
                        : <span className="muted text-xs">—</span>}
                    </td>
                    <td>{inst.az || inst.availabilityZone || '—'}</td>
                    <td>{inst.privateIp || inst.privateIpAddress || '—'}</td>
                    <td>{inst.publicIp || inst.publicIpAddress || '—'}</td>
                    <td>{launchStr || '—'}</td>
                    <td>{getInstanceState(inst) || '—'}</td>
                  </tr>
                );
              })}
              {uncoveredSorted.length===0 && <tr><td colSpan="12" className="text-center muted py-4">Toutes les instances sont couvertes par une RI pour les régions sélectionnées.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </>);
}

function SortIndicator({ active, dir }) {
  if (!active) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
  return <span className="ml-1 text-[10px] text-slate-500">{dir === 'asc' ? '↑' : '↓'}</span>;
}

function Pager({ page, pageCount, onPageChange }) {
  if (pageCount <= 1) return null;
  const prev = () => onPageChange(Math.max(0, page - 1));
  const next = () => onPageChange(Math.min(pageCount - 1, page + 1));
  return (
    <div className="flex items-center gap-2 text-sm mt-2">
      <button className="btn btn-sm" onClick={prev} disabled={page === 0}>Préc.</button>
      <span className="muted">Page {page + 1}/{pageCount}</span>
      <button className="btn btn-sm" onClick={next} disabled={page >= pageCount - 1}>Suiv.</button>
    </div>
  );
}

function MiniSparkline({ data, dataKey = 'value', stroke = '#f59e0b', fill = '#ffedd5', height = 46 }) {
  if (!Array.isArray(data) || data.length === 0) return null;
  return (
    <div className="w-full h-12">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data}>
          <XAxis dataKey="date" hide />
          <YAxis hide />
          <Tooltip formatter={(v) => formatCurrency(v)} labelFormatter={(l) => l} />
          <Area type="monotone" dataKey={dataKey} strokeWidth={2} stroke={stroke} fill={fill} fillOpacity={0.35} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatPct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function signedCurrency(value) {
  const n = Number(value || 0);
  const label = formatCurrency(Math.abs(n), 'USD', { maximumFractionDigits: 2 });
  if (!n) return label;
  return `${n > 0 ? '+' : '-'}${label}`;
}

function InsightKpi({ label, value, detail, tone = 'slate' }) {
  const toneClass = {
    slate: 'border-slate-200 bg-white text-slate-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    red: 'border-rose-200 bg-rose-50 text-rose-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    blue: 'border-blue-200 bg-blue-50 text-blue-900'
  }[tone] || 'border-slate-200 bg-white text-slate-900';
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide opacity-75">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {detail && <div className="mt-1 text-xs opacity-75">{detail}</div>}
    </div>
  );
}

function dominantS3Class(classes = {}) {
  const entries = Object.entries(classes || {}).map(([key, value]) => [key, Number(value || 0)]).filter(([, value]) => value > 0);
  if (!entries.length) return '—';
  entries.sort((a, b) => b[1] - a[1]);
  return S3_FRIENDLY[entries[0][0]] || entries[0][0];
}

function formatSignedBytes(value) {
  const n = Number(value || 0);
  const label = formatBytesDecimal(Math.abs(n), { spaced: true }).text;
  if (!n) return label;
  return `${n > 0 ? '+' : '-'}${label}`;
}

function formatGiB(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '—';
  return formatBytesDecimal(n * 1024 * 1024 * 1024, { spaced: true }).text;
}

function signedGiB(value) {
  const n = Number(value || 0);
  const label = formatGiB(Math.abs(n));
  if (!n) return label;
  return `${n > 0 ? '+' : '-'}${label}`;
}

function ActionPriorityBadge({ priority }) {
  const label = priority === 'high' ? 'Priorité haute' : priority === 'medium' ? 'Priorité moyenne' : 'Priorité basse';
  const type = priority === 'high' ? 'warn' : priority === 'medium' ? 'estimate' : 'cache';
  return <TrustBadge type={type}>{label}</TrustBadge>;
}

function heatCellColor(value, max) {
  const v = Number(value || 0);
  const m = Number(max || 0);
  if (!m || v <= 0) return 'rgba(248,250,252,.95)';
  const opacity = Math.max(0.12, Math.min(0.88, v / m));
  return `rgba(14, 116, 144, ${opacity})`;
}

function formatDateRange(start, end) {
  if (!start && !end) return '—';
  const inclusiveEnd = end ? addDays(end, -1) : '';
  return `${start || '—'} -> ${inclusiveEnd || end || '—'}`;
}

const EC2_SNAPSHOT_TIME_ZONE = 'Europe/Paris';

function formatEc2SnapshotHour(value, { compact = false, withZone = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || '').slice(0, compact ? 16 : 16).replace('T', ' ') || '—';
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: EC2_SNAPSHOT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  const label = compact
    ? `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
    : `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return withZone ? `${label} Europe/Paris` : label;
}

const ACTION_STATUS_LABELS = {
  todo: 'À traiter',
  ignored: 'Ignoré',
  validated: 'Validé',
  resolved: 'Résolu',
};

function ActionStatusBadge({ action }) {
  const status = action?.status || 'todo';
  const label = action?.isSnoozed && action?.snoozedUntil
    ? `Snooze ${action.snoozedUntil}`
    : (ACTION_STATUS_LABELS[status] || status);
  const type = action?.isSnoozed ? 'estimate' : status === 'resolved' ? 'cache' : status === 'validated' ? 'info' : status === 'ignored' ? 'cache' : 'warn';
  return <TrustBadge type={type}>{label}</TrustBadge>;
}

function Ec2StateBadge({ state }) {
  const value = String(state || 'unknown').toLowerCase();
  const type = value === 'running' ? 'real' : value === 'stopped' ? 'cache' : value === 'terminated' ? 'warn' : 'info';
  return <TrustBadge type={type}>{value}</TrustBadge>;
}

function ForecastRowsTable({ title, rows, labelKey, accountMap }) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="overflow-auto">
      <div className="mb-2 text-sm font-semibold text-slate-800">{title}</div>
      <table className="table table-fixed w-full text-sm">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[15%]" />
          <col className="w-[17%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
        </colgroup>
        <thead>
          <tr>
            <th className="min-w-0">{labelKey === 'accountId' ? 'Compte' : 'Service'}</th>
            <th className="text-right tabular-nums">MTD</th>
            <th className="text-right tabular-nums">Forecast</th>
            <th className="text-right tabular-nums">M-1</th>
            <th className="text-right tabular-nums">Dépassement</th>
          </tr>
        </thead>
        <tbody>
          {list.slice(0, 8).map(row => {
            const label = labelKey === 'accountId' ? (accountMap?.get(row.accountId) || row.accountId) : row.service;
            const overrun = Number(row.expectedOverrun || 0);
            return (
              <tr key={row[labelKey]}>
                <td className="min-w-0 truncate pr-3" title={label}>{label || '—'}</td>
                <td className="text-right tabular-nums">{formatCurrency(row.currentMtd, 'USD', { maximumFractionDigits: 0 })}</td>
                <td className="text-right tabular-nums font-semibold">{formatCurrency(row.forecastMonthEnd, 'USD', { maximumFractionDigits: 0 })}</td>
                <td className="text-right tabular-nums">{formatCurrency(row.previousMonth, 'USD', { maximumFractionDigits: 0 })}</td>
                <td className={`text-right tabular-nums ${overrun > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {overrun > 0 ? formatCurrency(overrun, 'USD', { maximumFractionDigits: 0 }) : '—'}
                </td>
              </tr>
            );
          })}
          {!list.length && <tr><td colSpan="5" className="py-4 text-center muted">Aucune projection disponible.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function DrilldownPanel({ target, data, loading, error, accountMap, onClose }) {
  if (!target) return null;
  const kind = data?.kind || target.kind;
  const isS3 = kind === 'bucket';
  const isEbs = kind === 'ebs-account';
  const summary = data?.summary || {};
  const costSeries = Array.isArray(data?.comparisonDaily) ? data.comparisonDaily : [];
  const s3Series = Array.isArray(data?.daily) ? data.daily : [];
  const ebsSeries = Array.isArray(data?.snapshots) ? data.snapshots : [];
  const ebsByType = Array.isArray(data?.latestByType) ? data.latestByType : [];
  const ebsItems = Array.isArray(data?.latestItems) ? data.latestItems : [];
  const relatedAccounts = Array.isArray(data?.related?.accounts) ? data.related.accounts : [];
  const relatedServices = Array.isArray(data?.related?.services) ? data.related.services : [];
  const relatedBuckets = Array.isArray(data?.related?.buckets) ? data.related.buckets : [];
  const relatedPairs = Array.isArray(data?.related?.accountServices) ? data.related.accountServices : [];
  const title = target.title || target.service || target.bucket || target.accountId || 'Détail';
  const currentRange = formatDateRange(data?.window?.start, data?.window?.end);
  const previousRange = formatDateRange(data?.window?.previousStart, data?.window?.previousEnd);
  const subtitle = isEbs
    ? `EBS / volumes · ${currentRange}`
    : `${isS3 ? 'Bucket / stockage' : 'Coûts'} · actuel ${currentRange} · précédent ${previousRange}`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-5xl overflow-auto border-l border-slate-200 bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-slate-900">{title}</div>
            <div className="text-sm muted">{subtitle}</div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>Fermer</button>
        </div>

        <div className="grid grid-cols-1 gap-4 p-5">
          {loading && <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm muted">Chargement du détail...</div>}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Erreur détail: {error.message || 'appel API impossible'}</div>}

          {!loading && !error && (
            <>
              {isEbs ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <InsightKpi label="Taille compte" value={formatGiB(summary.latestSizeGiB)} detail={signedGiB(summary.deltaSizeGiB)} tone={Number(summary.deltaSizeGiB || 0) > 0 ? 'amber' : 'slate'} />
                  <InsightKpi label="Coût mensuel" value={summary.latestMonthlyCost == null ? '—' : formatCurrency(summary.latestMonthlyCost)} detail={summary.deltaMonthlyCost == null ? '—' : signedCurrency(summary.deltaMonthlyCost)} tone={Number(summary.deltaMonthlyCost || 0) > 0 ? 'red' : 'slate'} />
                  <InsightKpi label="Volumes" value={Number(summary.latestVolumes || 0).toLocaleString('fr-FR')} detail={`Dernier snapshot ${formatEc2SnapshotHour(summary.latestSnapshotHour)}`} tone="blue" />
                  <InsightKpi label="Snapshots" value={Number(summary.snapshots || 0).toLocaleString('fr-FR')} detail="Période filtrée" tone="slate" />
                </div>
              ) : isS3 ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <InsightKpi label="Taille actuelle" value={formatBytesDecimal(summary.currentLatestBytes, { spaced: true }).text} detail={currentRange} tone="blue" />
                  <InsightKpi label="Croissance" value={formatSignedBytes(summary.currentGrowthBytes)} detail={`Actuel ${currentRange}`} tone={Number(summary.currentGrowthBytes || 0) > 0 ? 'amber' : 'green'} />
                  <InsightKpi label="Objets" value={Number(summary.latestObjects || 0).toLocaleString('fr-FR')} detail="Dernier snapshot" tone="slate" />
                  <InsightKpi label="Classe dominante" value={dominantS3Class(summary.classes)} detail="Répartition latest" tone="slate" />
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <InsightKpi label="Actuel" value={formatCurrency(summary.currentTotal || 0)} detail={currentRange} tone="blue" />
                  <InsightKpi label="Période précédente" value={formatCurrency(summary.previousTotal || 0)} detail={previousRange} tone="slate" />
                  <InsightKpi label="Écart" value={signedCurrency(summary.delta || 0)} detail={summary.deltaPct == null ? 'n/a' : formatPct(summary.deltaPct)} tone={Number(summary.delta || 0) > 0 ? 'red' : 'green'} />
                  <InsightKpi label="Moyenne jour" value={formatCurrency(summary.currentAvgDaily || 0)} detail={currentRange} tone="slate" />
                </div>
              )}

              <div className="card p-4">
                <div className="mb-3 text-base font-semibold">{isEbs ? 'Évolution taille et coût EBS' : isS3 ? 'Évolution journalière stockage' : 'Évolution journalière coût'}</div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    {isEbs ? (
                      <ComposedChart data={ebsSeries}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="snapshotHour" tick={{ fontSize: 12 }} tickFormatter={(value) => formatEc2SnapshotHour(value, { compact: true })} />
                        <YAxis yAxisId="size" tick={{ fontSize: 12 }} tickFormatter={(value) => `${Number(value || 0).toFixed(0)} GiB`} />
                        <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 12 }} tickFormatter={(value) => `$${Number(value || 0).toFixed(0)}`} />
                        <Tooltip
                          labelFormatter={(value) => formatEc2SnapshotHour(value, { withZone: true })}
                          formatter={(value, name) => {
                            if (name === 'Coût mensuel') return [value == null ? '—' : formatCurrency(value), name];
                            if (name === 'Taille') return [formatGiB(value), name];
                            return [Number(value || 0).toLocaleString('fr-FR'), name];
                          }}
                        />
                        <Legend />
                        <Area yAxisId="size" type="monotone" dataKey="totalGiB" name="Taille" stroke="#2563eb" fill="#bfdbfe" fillOpacity={0.45} />
                        <Line yAxisId="cost" type="monotone" dataKey="estimatedMonthlyCost" name="Coût mensuel" stroke="#be123c" strokeWidth={2} dot={false} />
                      </ComposedChart>
                    ) : isS3 ? (
                      <LineChart data={s3Series}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => formatBytesDecimal(value, { spaced: false }).text} />
                        <Tooltip
                          formatter={(value, name, props) => {
                            if (props?.dataKey === 'bytesTotal' || name === 'Stockage') return [formatBytesDecimal(value, { spaced: true }).text, 'Stockage'];
                            return [Number(value || 0).toLocaleString('fr-FR'), name];
                          }}
                        />
                        <Line type="monotone" dataKey="bytesTotal" name="Stockage" stroke="#0e7490" strokeWidth={2} dot={false} />
                      </LineChart>
                    ) : (
                      <ComposedChart data={costSeries}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip
                          formatter={(value, name, props) => {
                            const row = props?.payload || {};
                            const label = props?.dataKey === 'previousCost'
                              ? `Précédent ${row.previousDate || ''}`.trim()
                              : `Actuel ${row.date || ''}`.trim();
                            return [formatCurrency(value), label];
                          }}
                        />
                        <Legend />
                        <Area type="monotone" dataKey="cost" name="Actuel" stroke="#0f172a" fill="#cbd5e1" fillOpacity={0.45} />
                        <Line type="monotone" dataKey="previousCost" name="Période précédente" stroke="#f59e0b" strokeWidth={2} dot={false} />
                      </ComposedChart>
                    )}
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {isEbs ? (
                  <>
                    <div className="card p-4">
                      <div className="mb-2 text-sm font-semibold">Répartition par type</div>
                      <div className="overflow-auto">
                        <table className="table w-full text-sm">
                          <thead><tr><th>Type</th><th className="text-right">Volumes</th><th className="text-right">Taille</th><th className="text-right">Coût/mois</th></tr></thead>
                          <tbody>
                            {ebsByType.map(row => (
                              <tr key={row.volumeType}>
                                <td>{row.volumeType || '—'}</td>
                                <td className="text-right">{Number(row.totalVolumes || 0).toLocaleString('fr-FR')}</td>
                                <td className="text-right">{formatGiB(row.totalGiB)}</td>
                                <td className="text-right">{row.estimatedMonthlyCost == null ? '—' : formatCurrency(row.estimatedMonthlyCost)}</td>
                              </tr>
                            ))}
                            {!ebsByType.length && <tr><td colSpan="4" className="py-4 text-center muted">Aucune répartition EBS.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="card p-4">
                      <div className="mb-2 text-sm font-semibold">Volumes les plus chers</div>
                      <div className="overflow-auto">
                        <table className="table w-full text-sm">
                          <thead><tr><th>Volume</th><th>Type</th><th className="text-right">Taille</th><th className="text-right">Coût/mois</th></tr></thead>
                          <tbody>
                            {ebsItems.slice(0, 12).map(row => (
                              <tr key={`${row.snapshotHour}-${row.accountId}-${row.region}-${row.volumeId}`}>
                                <td>
                                  <div className="font-medium">{row.name || row.volumeId || '—'}</div>
                                  {row.name && <div className="text-[11px] muted">{row.volumeId}</div>}
                                </td>
                                <td>{row.volumeType || row.type || '—'}</td>
                                <td className="text-right">{formatGiB(row.sizeGiB)}</td>
                                <td className="text-right">{row.estimatedMonthlyCost == null ? '—' : formatCurrency(row.estimatedMonthlyCost)}</td>
                              </tr>
                            ))}
                            {!ebsItems.length && <tr><td colSpan="4" className="py-4 text-center muted">Aucun volume EBS.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                ) : isS3 ? (
                  <>
                    <div className="card p-4">
                      <div className="mb-2 text-sm font-semibold">Buckets liés</div>
                      <div className="overflow-auto">
                        <table className="table w-full text-sm">
                          <thead><tr><th>Bucket</th><th>Région</th><th className="text-right">Taille</th></tr></thead>
                          <tbody>
                            {relatedBuckets.map(row => (
                              <tr key={`${row.bucket}-${row.region}`}>
                                <td className="max-w-[260px] truncate" title={row.bucket}>{row.bucket}</td>
                                <td>{row.region || '—'}</td>
                                <td className="text-right">{formatBytesDecimal(row.bytesTotal, { spaced: true }).text}</td>
                              </tr>
                            ))}
                            {!relatedBuckets.length && <tr><td colSpan="3" className="py-4 text-center muted">Aucun bucket lié.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="card p-4">
                      <div className="mb-2 text-sm font-semibold">Comptes liés</div>
                      <div className="overflow-auto">
                        <table className="table w-full text-sm">
                          <thead><tr><th>Compte</th><th className="text-right">Taille</th></tr></thead>
                          <tbody>
                            {relatedAccounts.map(row => (
                              <tr key={row.accountId}>
                                <td>{accountMap?.get(row.accountId) || row.accountId || '—'}</td>
                                <td className="text-right">{formatBytesDecimal(row.bytesTotal, { spaced: true }).text}</td>
                              </tr>
                            ))}
                            {!relatedAccounts.length && <tr><td colSpan="2" className="py-4 text-center muted">Aucun compte lié.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="card p-4">
                      <div className="mb-2 text-sm font-semibold">Services liés</div>
                      <div className="overflow-auto">
                        <table className="table w-full text-sm">
                          <thead><tr><th>Service</th><th className="text-right">Coût</th></tr></thead>
                          <tbody>
                            {relatedServices.map(row => (
                              <tr key={row.service}>
                                <td className="max-w-[280px] truncate" title={row.service}>{row.service}</td>
                                <td className="text-right">{formatCurrency(row.cost)}</td>
                              </tr>
                            ))}
                            {!relatedServices.length && <tr><td colSpan="2" className="py-4 text-center muted">Aucun service lié.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="card p-4">
                      <div className="mb-2 text-sm font-semibold">Comptes / services liés</div>
                      <div className="overflow-auto">
                        <table className="table w-full text-sm">
                          <thead><tr><th>Compte</th><th>Service</th><th className="text-right">Coût</th></tr></thead>
                          <tbody>
                            {relatedPairs.map(row => (
                              <tr key={`${row.accountId}-${row.service}`}>
                                <td>{accountMap?.get(row.accountId) || row.accountId || '—'}</td>
                                <td className="max-w-[220px] truncate" title={row.service}>{row.service}</td>
                                <td className="text-right">{formatCurrency(row.cost)}</td>
                              </tr>
                            ))}
                            {!relatedPairs.length && <tr><td colSpan="3" className="py-4 text-center muted">Aucun lien compte/service.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InsightsTab({ start, end, snapshotEnd, metric, account, regions, accountMap, excludeTax }) {
  const insightParams = useMemo(() => Object.fromEntries(buildRangeSearchParams(start, end, {
    metric,
    accounts: account || '',
    regions: regions || '',
    excludeTax: excludeTax ? '1' : ''
  })), [start, end, metric, account, regions, excludeTax]);
  const snapshotParams = useMemo(() => Object.fromEntries(buildRangeSearchParams(start, snapshotEnd || end, {
    accounts: account || '',
    regions: regions || ''
  })), [start, end, snapshotEnd, account, regions]);
  const [state, setState] = useState({
    loading: true,
    error: null,
    trends: null,
    anomalies: null,
    s3: null,
    coverage: null,
    quality: null,
    breakdown: null,
    heatmap: null,
    actions: null,
    forecast: null,
    ec2Snapshots: null,
    ebsSnapshots: null
  });
  const [actionBusy, setActionBusy] = useState(null);
  const [drilldownTarget, setDrilldownTarget] = useState(null);
  const [drilldown, setDrilldown] = useState({ loading: false, error: null, data: null });

  const loadActions = useCallback((params = insightParams) => {
    return getJSON('/api/insights/actions', { ...params, limit: 20 })
      .then(actions => {
        setState(prev => ({ ...prev, actions }));
        return actions;
      });
  }, [insightParams]);

  useEffect(() => {
    let cancelled = false;
    const base = insightParams;
    setState(prev => ({ ...prev, loading: true, error: null }));
    Promise.all([
      getJSON('/api/costs/trends', base),
      getJSON('/api/costs/anomalies', { ...base, limit: 20, minAbs: 1, minPct: 20 }),
      getJSON('/api/s3/growth', { start: base.start, end: base.end, accounts: account || '', regions: regions || '', limit: 20 }),
      getJSON('/api/coverage/summary', { start: base.start, end: base.end }),
      getJSON('/api/meta/data-quality'),
      getJSON('/api/costs/breakdown', { ...base, limit: 12 }),
      getJSON('/api/costs/heatmap', { ...base, limit: 8 }),
      getJSON('/api/insights/actions', { ...base, limit: 20 }),
      getJSON('/api/costs/forecast', { ...base, limit: 12 }),
      getJSON('/api/ec2/snapshots/summary', snapshotParams),
      getJSON('/api/ebs/snapshots/summary', snapshotParams)
    ])
      .then(([trends, anomalies, s3, coverage, quality, breakdown, heatmap, actions, forecast, ec2Snapshots, ebsSnapshots]) => {
        if (cancelled) return;
        setState({ loading: false, error: null, trends, anomalies, s3, coverage, quality, breakdown, heatmap, actions, forecast, ec2Snapshots, ebsSnapshots });
      })
      .catch(error => {
        if (!cancelled) setState(prev => ({ ...prev, loading: false, error }));
      });
    return () => { cancelled = true; };
  }, [insightParams, snapshotParams, account, regions]);

  const trendDaily = Array.isArray(state.trends?.daily) ? state.trends.daily : [];
  const anomalies = Array.isArray(state.anomalies?.items) ? state.anomalies.items : [];
  const s3Items = Array.isArray(state.s3?.items) ? state.s3.items : [];
  const coverageDaily = Array.isArray(state.coverage?.daily) ? state.coverage.daily : [];
  const qualityMetrics = Array.isArray(state.quality?.costs?.metrics) ? state.quality.costs.metrics : [];
  const actions = Array.isArray(state.actions?.items) ? state.actions.items : [];
  const breakdownAccounts = Array.isArray(state.breakdown?.accounts) ? state.breakdown.accounts : [];
  const breakdownServices = Array.isArray(state.breakdown?.services) ? state.breakdown.services : [];
  const accountServices = Array.isArray(state.breakdown?.accountServices) ? state.breakdown.accountServices : [];
  const heatServices = Array.isArray(state.heatmap?.services) ? state.heatmap.services.map(row => row.service) : [];
  const heatDaily = Array.isArray(state.heatmap?.dailyServices) ? state.heatmap.dailyServices : [];
  const summary = state.trends?.summary || {};
  const s3GrowthBytes = s3Items.reduce((sum, row) => sum + Number(row.growthBytes || 0), 0);
  const coverageSummary = state.coverage?.summary || {};
  const concentration = state.breakdown?.concentration || {};
  const deltaTone = Number(summary.delta || 0) > 0 ? 'red' : Number(summary.delta || 0) < 0 ? 'green' : 'slate';
  const heatDates = Array.from(new Set(heatDaily.map(row => row.date).filter(Boolean))).sort();
  const heatMap = useMemo(() => {
    const map = new Map();
    for (const row of heatDaily) map.set(`${row.date}::${row.service}`, Number(row.cost || 0));
    return map;
  }, [heatDaily]);
  const heatMax = heatDaily.reduce((max, row) => Math.max(max, Number(row.cost || 0)), 0);
  const topAccountService = accountServices[0] || null;
  const forecastSummary = state.forecast?.summary || {};
  const forecastByAccount = Array.isArray(state.forecast?.byAccount) ? state.forecast.byAccount : [];
  const forecastByService = Array.isArray(state.forecast?.byService) ? state.forecast.byService : [];
  const projectedDaily = Array.isArray(state.forecast?.projectedDaily) ? state.forecast.projectedDaily : [];
  const forecastTone = Number(forecastSummary.expectedOverrun || 0) > 0 ? 'red' : 'green';
  const ec2SnapshotSeries = Array.isArray(state.ec2Snapshots?.snapshots) ? state.ec2Snapshots.snapshots : [];
  const ec2LatestItems = Array.isArray(state.ec2Snapshots?.latestItems) ? state.ec2Snapshots.latestItems : [];
  const ec2Latest = ec2SnapshotSeries.length ? ec2SnapshotSeries[ec2SnapshotSeries.length - 1] : null;
  const ec2SnapshotSummary = state.ec2Snapshots?.summary || {};
  const ebsSnapshotSeries = Array.isArray(state.ebsSnapshots?.snapshots) ? state.ebsSnapshots.snapshots : [];
  const ebsLatestByType = Array.isArray(state.ebsSnapshots?.latestByType) ? state.ebsSnapshots.latestByType : [];
  const ebsLatestByAccount = Array.isArray(state.ebsSnapshots?.latestByAccount) ? state.ebsSnapshots.latestByAccount : [];
  const ebsLatestItems = Array.isArray(state.ebsSnapshots?.latestItems) ? state.ebsSnapshots.latestItems : [];
  const ebsSnapshotSummary = state.ebsSnapshots?.summary || {};
  const trendsCurrentRange = formatDateRange(state.trends?.window?.start || start, state.trends?.window?.end || end);
  const trendsPreviousRange = formatDateRange(state.trends?.window?.previousStart, state.trends?.window?.previousEnd);
  const variationDetail = summary.deltaPct == null
    ? 'Comparaison indisponible'
    : `${formatPct(summary.deltaPct)} vs ${trendsPreviousRange}`;

  const openDrilldown = useCallback((target) => {
    const nextTarget = target || {};
    setDrilldownTarget(nextTarget);
    setDrilldown({ loading: true, error: null, data: null });
    const params = {
      ...insightParams,
      kind: nextTarget.kind || 'cost',
      accountId: nextTarget.accountId || '',
      service: nextTarget.service || '',
      bucket: nextTarget.bucket || '',
      region: nextTarget.region || ''
    };
    getJSON('/api/insights/drilldown', params)
      .then(data => setDrilldown({ loading: false, error: null, data }))
      .catch(error => setDrilldown({ loading: false, error, data: null }));
  }, [insightParams]);

  const openActionDrilldown = useCallback((action) => {
    const evidence = action?.evidence || {};
    if (action?.category === 's3' || evidence.bucket) {
      openDrilldown({
        kind: 'bucket',
        title: action.title,
        bucket: evidence.bucket,
        accountId: evidence.accountId,
        region: evidence.region
      });
      return;
    }
    openDrilldown({
      kind: action?.category === 'concentration' && evidence.accountId ? 'account' : 'service',
      title: action?.title,
      accountId: evidence.accountId,
      service: evidence.service,
      region: evidence.region
    });
  }, [openDrilldown]);

  const openEbsAccountGraph = useCallback((accountId) => {
    const selected = String(accountId || '').trim();
    if (!selected) return;
    const title = accountMap?.get(selected) || selected;
    setDrilldownTarget({ kind: 'ebs-account', title, accountId: selected });
    setDrilldown({ loading: true, error: null, data: null });
    getJSON('/api/ebs/snapshots/summary', { ...snapshotParams, accounts: selected })
      .then(data => setDrilldown({ loading: false, error: null, data: { ...data, kind: 'ebs-account' } }))
      .catch(error => setDrilldown({ loading: false, error, data: null }));
  }, [snapshotParams, accountMap]);

  const updateActionState = useCallback((action, patch) => {
    if (!action?.id) return;
    setActionBusy(action.id);
    sendJSON(`/api/insights/actions/${encodeURIComponent(action.id)}/state`, patch)
      .then(() => loadActions(insightParams))
      .catch(error => setState(prev => ({ ...prev, error })))
      .finally(() => setActionBusy(null));
  }, [insightParams, loadActions]);

  return (
    <div className="grid grid-cols-1 gap-5">
      {state.loading && <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm muted">Chargement des insights DB...</div>}
      {state.error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Erreur insights: {state.error.message || 'appel API impossible'}</div>}

      <div className="flex flex-wrap gap-2">
        <TrustBadge type="cache">DB-only</TrustBadge>
        <TrustBadge type="estimate">Analyse locale</TrustBadge>
        <TrustBadge type="cache">{metric}</TrustBadge>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
        <InsightKpi label="Total période" value={formatCurrency(summary.total || 0)} detail={trendsCurrentRange} tone="blue" />
        <InsightKpi label="Variation" value={signedCurrency(summary.delta || 0)} detail={variationDetail} tone={deltaTone} />
        <InsightKpi label="Projection mois" value={formatCurrency(summary.projectionMonthEnd || 0)} detail={`${formatCurrency(summary.avgDaily || 0)} / jour observé`} tone="slate" />
        <InsightKpi label="Anomalies" value={anomalies.length} detail="Variations coût significatives" tone={anomalies.length ? 'amber' : 'green'} />
        <InsightKpi label="Croissance S3" value={formatSignedBytes(s3GrowthBytes)} detail={`${s3Items.length} bucket(s) analysés`} tone={s3GrowthBytes > 0 ? 'amber' : 'green'} />
        <InsightKpi label="Concentration" value={`${Number(concentration.topServiceSharePct || 0).toFixed(1)}%`} detail="Top service / total" tone={Number(concentration.topServiceSharePct || 0) > 40 ? 'amber' : 'green'} />
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Action Center FinOps</div>
            <div className="text-sm muted">Priorité, impact, preuve et suivi opérationnel</div>
          </div>
          <TrustBadge type="estimate">Moteur DB</TrustBadge>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th>Priorité</th>
                <th>Action</th>
                <th className="text-right">Impact estimé</th>
                <th>Preuve</th>
                <th>Statut</th>
                <th className="text-right">Snooze</th>
              </tr>
            </thead>
            <tbody>
              {actions.map(action => (
                <tr
                  key={action.id}
                  className={`cursor-pointer hover:bg-slate-50 ${action.status === 'resolved' ? 'opacity-70' : ''}`}
                  onClick={() => openActionDrilldown(action)}
                >
                  <td><ActionPriorityBadge priority={action.priority} /></td>
                  <td>
                    <div className="font-semibold text-slate-900">{action.title}</div>
                    <div className="mt-1 max-w-xl text-xs text-slate-600">{action.detail}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <TrustBadge type="info">{action.category}</TrustBadge>
                      <ActionStatusBadge action={action} />
                    </div>
                  </td>
                  <td className="text-right font-semibold">
                    {Number(action.impactUSD || 0) ? signedCurrency(action.impactUSD) : (action.impactLabel || 'À qualifier')}
                  </td>
                  <td className="max-w-[160px] truncate" title={action.source}>{action.source || 'db'}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <select
                      className="select min-w-[130px]"
                      value={action.status || 'todo'}
                      disabled={actionBusy === action.id}
                      onChange={e => updateActionState(action, { status: e.target.value, clearSnooze: e.target.value === 'todo' })}
                    >
                      <option value="todo">À traiter</option>
                      <option value="validated">Validé</option>
                      <option value="ignored">Ignoré</option>
                      <option value="resolved">Résolu</option>
                    </select>
                  </td>
                  <td className="text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <button className="btn btn-sm" disabled={actionBusy === action.id} onClick={() => updateActionState(action, { status: action.status || 'todo', snoozeDays: 7 })}>7j</button>
                      <button className="btn btn-sm" disabled={actionBusy === action.id} onClick={() => updateActionState(action, { status: action.status || 'todo', snoozeDays: 30 })}>30j</button>
                      {action.isSnoozed && <button className="btn btn-sm" disabled={actionBusy === action.id} onClick={() => updateActionState(action, { status: action.status || 'todo', clearSnooze: true })}>Réactiver</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!actions.length && <tr><td colSpan="6" className="py-4 text-center muted">Aucune action prioritaire détectée sur la période.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Forecast avancé</div>
            <div className="text-sm muted">Fin de mois par tendance 7 jours, compte et service</div>
          </div>
          <TrustBadge type="estimate">Projection locale</TrustBadge>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <InsightKpi label="MTD actuel" value={formatCurrency(forecastSummary.currentMtd || 0)} detail={`${state.forecast?.window?.mtdStart || '—'} -> ${state.forecast?.window?.anchor || '—'}`} tone="blue" />
          <InsightKpi label="Forecast 7j" value={formatCurrency(forecastSummary.forecast7dTrend || 0)} detail={`${formatCurrency(forecastSummary.avgDaily7d || 0)} / jour`} tone={forecastTone} />
          <InsightKpi label="Forecast MTD" value={formatCurrency(forecastSummary.forecastMtdRunRate || 0)} detail={`${formatCurrency(forecastSummary.avgDailyMtd || 0)} / jour`} tone="slate" />
          <InsightKpi label="Écart vs M-1" value={signedCurrency(forecastSummary.deltaVsPreviousMonth || 0)} detail={forecastSummary.deltaVsPreviousMonthPct == null ? 'M-1 indisponible' : formatPct(forecastSummary.deltaVsPreviousMonthPct)} tone={Number(forecastSummary.deltaVsPreviousMonth || 0) > 0 ? 'red' : 'green'} />
          <InsightKpi label="Dépassement attendu" value={formatCurrency(forecastSummary.expectedOverrun || 0)} detail={`${state.forecast?.window?.daysRemaining ?? 0} j restants`} tone={forecastTone} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="xl:col-span-1">
            <div className="mb-2 text-sm font-semibold text-slate-800">Courbe de projection</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={projectedDaily}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value) => formatCurrency(value)} />
                  <Area type="monotone" dataKey="projectedCumulative" name="Cumul projeté" stroke="#0e7490" fill="#cffafe" fillOpacity={0.45} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
          <ForecastRowsTable title="Prévision par compte" rows={forecastByAccount} labelKey="accountId" accountMap={accountMap} />
          <ForecastRowsTable title="Prévision par service" rows={forecastByService} labelKey="service" accountMap={accountMap} />
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Snapshots EC2 exacts</div>
            <div className="text-sm muted">Historique horaire DB des états running, stopped et terminated</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <TrustBadge type="cache">DB-only</TrustBadge>
            <TrustBadge type="real">DescribeInstances scheduler</TrustBadge>
            <TrustBadge type="estimate">Aligné période coûts</TrustBadge>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <InsightKpi label="Dernier snapshot" value={formatEc2SnapshotHour(ec2SnapshotSummary.latestSnapshotHour)} detail={`Europe/Paris · ${Number(ec2SnapshotSummary.snapshots || 0)} snapshot(s)`} tone="slate" />
          <InsightKpi label="Running" value={Number(ec2Latest?.running || 0)} detail="Dernier snapshot" tone={Number(ec2Latest?.running || 0) ? 'green' : 'slate'} />
          <InsightKpi label="Stopped" value={Number(ec2Latest?.stopped || 0)} detail="Dernier snapshot" tone="blue" />
          <InsightKpi label="Terminated vus" value={Number(ec2Latest?.terminated || 0)} detail="Dernier snapshot" tone={Number(ec2Latest?.terminated || 0) ? 'amber' : 'slate'} />
          <InsightKpi label="Tag VLE_Cost" value={Number(ec2Latest?.backupRunning || 0)} detail="Running avec tag détecté" tone={Number(ec2Latest?.backupRunning || 0) ? 'amber' : 'slate'} />
        </div>
        {ec2SnapshotSeries.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
              <div className="mb-2 text-sm font-semibold text-slate-800">États par snapshot</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={ec2SnapshotSeries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="snapshotHour" tick={{ fontSize: 11 }} tickFormatter={(value) => formatEc2SnapshotHour(value, { compact: true })} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip labelFormatter={(value) => formatEc2SnapshotHour(value, { withZone: true })} />
                    <Legend />
                    <Line type="monotone" dataKey="running" name="running" stroke="#16a34a" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="stopped" name="stopped" stroke="#2563eb" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="terminated" name="terminated" stroke="#f43f5e" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="backupRunning" name="VLE_Cost running" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="overflow-auto">
              <div className="mb-2 text-sm font-semibold text-slate-800">Dernières instances vues</div>
              <table className="table w-full text-sm">
                <thead><tr><th>Compte</th><th>Nom</th><th>Type</th><th>AZ</th><th>IP</th><th>État</th></tr></thead>
                <tbody>
                  {ec2LatestItems.slice(0, 16).map(row => (
                    <tr key={`${row.snapshotHour}-${row.accountId}-${row.region}-${row.instanceId}`}>
                      <td>{accountMap?.get(row.accountId) || row.accountId || '—'}</td>
                      <td>
                        <div className="font-medium">{row.name || '—'}</div>
                        <div className="text-[11px] muted">{row.instanceId}</div>
                      </td>
                      <td>{row.instanceType || '—'}</td>
                      <td>{row.availabilityZone || row.region || '—'}</td>
                      <td>{row.privateIp || '—'}</td>
                      <td><Ec2StateBadge state={row.state} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm muted">
            Aucun snapshot EC2 dans la période Cost Explorer affichée ({trendsCurrentRange}). Les snapshots plus récents restent masqués ici pour garder un graphe cohérent avec la facturation.
          </div>
        )}
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">EBS</div>
            <div className="text-sm muted">Historique horaire DB des volumes, taille provisionnée et coût mensuel estimé</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <TrustBadge type="cache">DB-only</TrustBadge>
            <TrustBadge type="real">DescribeVolumes scheduler</TrustBadge>
            <TrustBadge type="estimate">Stockage + IOPS + throughput</TrustBadge>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
          <InsightKpi label="Dernier snapshot" value={formatEc2SnapshotHour(ebsSnapshotSummary.latestSnapshotHour)} detail={`Europe/Paris · ${Number(ebsSnapshotSummary.snapshots || 0)} snapshot(s)`} tone="slate" />
          <InsightKpi label="Volumes" value={Number(ebsSnapshotSummary.latestVolumes || 0).toLocaleString('fr-FR')} detail="Dernier snapshot" tone="blue" />
          <InsightKpi label="Taille totale" value={formatGiB(ebsSnapshotSummary.latestSizeGiB)} detail={`${Number(ebsSnapshotSummary.latestSizeGiB || 0).toLocaleString('fr-FR')} GiB`} tone="blue" />
          <InsightKpi label="Écart taille" value={signedGiB(ebsSnapshotSummary.deltaSizeGiB)} detail={ebsSnapshotSummary.deltaSizePct == null ? 'vs premier snapshot' : `${formatPct(ebsSnapshotSummary.deltaSizePct)} vs premier`} tone={Number(ebsSnapshotSummary.deltaSizeGiB || 0) > 0 ? 'amber' : Number(ebsSnapshotSummary.deltaSizeGiB || 0) < 0 ? 'green' : 'slate'} />
          <InsightKpi label="Coût mensuel" value={ebsSnapshotSummary.latestMonthlyCost == null ? '—' : formatCurrency(ebsSnapshotSummary.latestMonthlyCost)} detail="Estimé hors snapshots AWS EBS" tone="slate" />
          <InsightKpi label="Écart coût" value={ebsSnapshotSummary.deltaMonthlyCost == null ? '—' : signedCurrency(ebsSnapshotSummary.deltaMonthlyCost)} detail={ebsSnapshotSummary.deltaMonthlyCostPct == null ? 'vs premier snapshot' : `${formatPct(ebsSnapshotSummary.deltaMonthlyCostPct)} vs premier`} tone={Number(ebsSnapshotSummary.deltaMonthlyCost || 0) > 0 ? 'red' : Number(ebsSnapshotSummary.deltaMonthlyCost || 0) < 0 ? 'green' : 'slate'} />
        </div>
        {ebsSnapshotSeries.length > 0 ? (
          <>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div>
                <div className="mb-2 text-sm font-semibold text-slate-800">Taille et coût par snapshot</div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={ebsSnapshotSeries}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="snapshotHour" tick={{ fontSize: 11 }} tickFormatter={(value) => formatEc2SnapshotHour(value, { compact: true })} />
                      <YAxis yAxisId="size" tick={{ fontSize: 11 }} tickFormatter={(value) => `${Number(value || 0).toFixed(0)} GiB`} />
                      <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(value) => `$${Number(value || 0).toFixed(0)}`} />
                      <Tooltip
                        labelFormatter={(value) => formatEc2SnapshotHour(value, { withZone: true })}
                        formatter={(value, name) => {
                          if (name === 'Coût mensuel') return [value == null ? '—' : formatCurrency(value), name];
                          if (name === 'Taille totale') return [formatGiB(value), name];
                          return [Number(value || 0).toLocaleString('fr-FR'), name];
                        }}
                      />
                      <Legend />
                      <Area yAxisId="size" type="monotone" dataKey="totalGiB" name="Taille totale" stroke="#2563eb" fill="#dbeafe" fillOpacity={0.45} />
                      <Line yAxisId="cost" type="monotone" dataKey="estimatedMonthlyCost" name="Coût mensuel" stroke="#0f766e" strokeWidth={2} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="overflow-auto">
                <div className="mb-2 text-sm font-semibold text-slate-800">Dernier snapshot par type</div>
                <table className="table w-full text-sm">
                  <thead><tr><th>Type</th><th className="text-right">Volumes</th><th className="text-right">Taille</th><th className="text-right">IOPS</th><th className="text-right">Throughput</th><th className="text-right">Coût/mois</th></tr></thead>
                  <tbody>
                    {ebsLatestByType.map(row => (
                      <tr key={row.volumeType}>
                        <td>{row.volumeType || '—'}</td>
                        <td className="text-right">{Number(row.totalVolumes || 0).toLocaleString('fr-FR')}</td>
                        <td className="text-right">{formatGiB(row.totalGiB)}</td>
                        <td className="text-right">{Number(row.totalIops || 0).toLocaleString('fr-FR')}</td>
                        <td className="text-right">{Number(row.totalThroughput || 0).toLocaleString('fr-FR')}</td>
                        <td className="text-right">{row.estimatedMonthlyCost == null ? '—' : formatCurrency(row.estimatedMonthlyCost)}</td>
                      </tr>
                    ))}
                    {!ebsLatestByType.length && <tr><td colSpan="6" className="py-4 text-center muted">Aucun volume au dernier snapshot.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="overflow-auto">
                <div className="mb-2 text-sm font-semibold text-slate-800">Dernier snapshot par compte</div>
                <table className="table w-full text-sm">
                  <thead><tr><th>Compte</th><th className="text-right">Volumes</th><th className="text-right">Taille</th><th className="text-right">Coût/mois</th></tr></thead>
                  <tbody>
                    {ebsLatestByAccount.slice(0, 12).map(row => (
                      <tr
                        key={row.accountId}
                        className={`cursor-pointer hover:bg-slate-50 ${drilldownTarget?.kind === 'ebs-account' && drilldownTarget?.accountId === row.accountId ? 'bg-blue-50/70' : ''}`}
                        onClick={() => openEbsAccountGraph(row.accountId)}
                        title="Afficher l'évolution EBS de ce compte"
                      >
                        <td className="font-medium text-slate-900">{accountMap?.get(row.accountId) || row.accountId || '—'}</td>
                        <td className="text-right">{Number(row.totalVolumes || 0).toLocaleString('fr-FR')}</td>
                        <td className="text-right">{formatGiB(row.totalGiB)}</td>
                        <td className="text-right">{row.estimatedMonthlyCost == null ? '—' : formatCurrency(row.estimatedMonthlyCost)}</td>
                      </tr>
                    ))}
                    {!ebsLatestByAccount.length && <tr><td colSpan="4" className="py-4 text-center muted">Aucun compte au dernier snapshot.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="overflow-auto">
                <div className="mb-2 text-sm font-semibold text-slate-800">Volumes les plus chers</div>
                <table className="table w-full text-sm">
                  <thead><tr><th>Compte</th><th>Volume</th><th>Type</th><th className="text-right">Taille</th><th className="text-right">Coût/mois</th></tr></thead>
                  <tbody>
                    {ebsLatestItems.slice(0, 12).map(row => (
                      <tr key={`${row.snapshotHour}-${row.accountId}-${row.region}-${row.volumeId}`}>
                        <td>{accountMap?.get(row.accountId) || row.accountId || '—'}</td>
                        <td>
                          <div className="font-medium">{row.name || row.volumeId || '—'}</div>
                          {row.name && <div className="text-[11px] muted">{row.volumeId}</div>}
                        </td>
                        <td>{row.volumeType || row.type || '—'}</td>
                        <td className="text-right">{formatGiB(row.sizeGiB)}</td>
                        <td className="text-right">{row.estimatedMonthlyCost == null ? '—' : formatCurrency(row.estimatedMonthlyCost)}</td>
                      </tr>
                    ))}
                    {!ebsLatestItems.length && <tr><td colSpan="5" className="py-4 text-center muted">Aucun volume au dernier snapshot.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm muted">
            Aucun snapshot EBS dans la période Cost Explorer affichée ({trendsCurrentRange}). Le scheduler EC2 capture aussi DescribeVolumes après redémarrage.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="card p-4 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-base font-semibold">Tendance coûts</div>
              <div className="text-sm muted">Coût journalier et moyenne mobile 7 jours</div>
            </div>
            <TrustBadge type="cache">cost_daily</TrustBadge>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trendDaily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => formatCurrency(value)} />
                <Legend />
                <Area type="monotone" dataKey="cost" name="Coût" stroke="#0f172a" fill="#cbd5e1" fillOpacity={0.45} />
                <Line type="monotone" dataKey="movingAverage7d" name="Moy. 7j" stroke="#0284c7" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-base font-semibold">RI local</div>
              <div className="text-sm muted">Couverture et utilisation depuis la DB</div>
            </div>
            <TrustBadge type="cache">ri_*</TrustBadge>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <InsightKpi label="Couverture moy." value={`${Number(coverageSummary.avgCoveragePct || 0).toFixed(1)}%`} detail="Running hours réservées" tone="green" />
            <InsightKpi label="Utilisation moy." value={`${Number(coverageSummary.avgUtilizationPct || 0).toFixed(1)}%`} detail={`${Number(coverageSummary.unusedHours || 0).toFixed(0)} h inutilisées`} tone={Number(coverageSummary.unusedHours || 0) > 0 ? 'amber' : 'green'} />
          </div>
          <div className="mt-4 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={coverageDaily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" hide />
                <YAxis domain={[0, 100]} hide />
                <Tooltip formatter={(value) => `${Number(value || 0).toFixed(1)}%`} />
                <Line type="monotone" dataKey="coveragePct" name="Couverture" stroke="#16a34a" dot={false} />
                <Line type="monotone" dataKey="utilizationPct" name="Utilisation" stroke="#f59e0b" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-base font-semibold">Répartition par compte</div>
              <div className="text-sm muted">Part de coût sur la période filtrée</div>
            </div>
            <TrustBadge type="cache">cost_daily</TrustBadge>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={breakdownAccounts.slice(0, 10).map(row => ({ ...row, label: accountMap?.get(row.accountId) || row.accountId }))} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(value) => `$${Number(value || 0).toFixed(0)}`} />
                <YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => formatCurrency(value)} />
                <Bar
                  dataKey="cost"
                  name="Coût"
                  fill="#0e7490"
                  cursor="pointer"
                  onClick={(entry) => {
                    const row = entry?.payload || entry;
                    openDrilldown({ kind: 'account', title: row?.label, accountId: row?.accountId });
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-base font-semibold">Mix services</div>
              <div className="text-sm muted">Top services et part du total</div>
            </div>
            <TrustBadge type="cache">cost_daily</TrustBadge>
          </div>
          <div className="overflow-auto">
            <table className="table w-full text-sm">
              <thead><tr><th>Service</th><th className="text-right">Coût</th><th className="text-right">Part</th></tr></thead>
              <tbody>
                {breakdownServices.slice(0, 10).map(row => (
                  <tr key={row.service} className="cursor-pointer hover:bg-slate-50" onClick={() => openDrilldown({ kind: 'service', title: row.service, service: row.service })}>
                    <td>{row.service}</td>
                    <td className="text-right">{formatCurrency(row.cost)}</td>
                    <td className="text-right">{Number(row.sharePct || 0).toFixed(1)}%</td>
                  </tr>
                ))}
                {!breakdownServices.length && <tr><td colSpan="3" className="py-4 text-center muted">Aucun coût disponible.</td></tr>}
              </tbody>
            </table>
          </div>
          {topAccountService && (
            <button
              type="button"
              className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-left text-sm hover:bg-slate-100"
              onClick={() => openDrilldown({
                kind: 'service',
                title: `${accountMap?.get(topAccountService.accountId) || topAccountService.accountId} · ${topAccountService.service}`,
                accountId: topAccountService.accountId,
                service: topAccountService.service
              })}
            >
              <span className="font-semibold">Plus gros couple compte/service:</span> {(accountMap?.get(topAccountService.accountId) || topAccountService.accountId)} · {topAccountService.service} · {formatCurrency(topAccountService.cost)}
            </button>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Heatmap services / jours</div>
            <div className="text-sm muted">Repère les pics journaliers par service sans appeler AWS</div>
          </div>
          <TrustBadge type="cache">cost_daily</TrustBadge>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-xs">
            <thead>
              <tr>
                <th>Date</th>
                {heatServices.map(service => <th key={service} className="min-w-[120px] text-right">{service.replace(/^Amazon\s+/i, '').slice(0, 28)}</th>)}
              </tr>
            </thead>
            <tbody>
              {heatDates.map(date => (
                <tr key={date}>
                  <td className="font-medium">{date}</td>
                  {heatServices.map(service => {
                    const value = heatMap.get(`${date}::${service}`) || 0;
                    const color = heatCellColor(value, heatMax);
                    const textColor = value > heatMax * 0.45 ? 'white' : '#0f172a';
                    return (
                      <td key={service} className="text-right tabular-nums" style={{ background: color, color: textColor }}>
                        {value ? formatCurrency(value, 'USD', { maximumFractionDigits: 0 }) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!heatDates.length && <tr><td colSpan={Math.max(1, heatServices.length + 1)} className="py-4 text-center muted">Aucune donnée heatmap.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-base font-semibold">Anomalies coût</div>
              <div className="text-sm muted">Comparaison avec la période précédente équivalente</div>
            </div>
            <TrustBadge type="cache">cost_daily</TrustBadge>
          </div>
          <div className="overflow-auto">
            <table className="table w-full text-sm">
              <thead><tr><th>Compte</th><th>Service</th><th>Région</th><th className="text-right">Actuel</th><th className="text-right">Écart</th><th className="text-right">%</th></tr></thead>
              <tbody>
                {anomalies.slice(0, 12).map((row, idx) => {
                  const accountLabel = accountMap?.get(row.accountId) || row.accountId || '—';
                  const isUp = Number(row.delta || 0) > 0;
                  return (
                    <tr
                      key={`${row.accountId}-${row.service}-${row.region}-${idx}`}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => openDrilldown({
                        kind: 'anomaly',
                        title: `${accountLabel} · ${row.service || 'Service'}`,
                        accountId: row.accountId,
                        service: row.service,
                        region: row.region || ''
                      })}
                    >
                      <td>{accountLabel}</td>
                      <td>{row.service || '—'}</td>
                      <td>{row.region || '—'}</td>
                      <td className="text-right">{formatCurrency(row.currentCost)}</td>
                      <td className={`text-right ${isUp ? 'text-rose-600' : 'text-emerald-600'}`}>{signedCurrency(row.delta)}</td>
                      <td className={`text-right ${isUp ? 'text-rose-600' : 'text-emerald-600'}`}>{row.deltaPct == null ? 'new' : formatPct(row.deltaPct)}</td>
                    </tr>
                  );
                })}
                {!anomalies.length && <tr><td colSpan="6" className="py-4 text-center muted">Aucune anomalie significative sur la période.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-base font-semibold">Croissance S3</div>
              <div className="text-sm muted">Évolution stockage entre premier et dernier snapshot</div>
            </div>
            <TrustBadge type="cache">s3_bucket_daily</TrustBadge>
          </div>
          <div className="overflow-auto">
            <table className="table w-full text-sm">
              <thead><tr><th>Bucket</th><th>Compte</th><th>Région</th><th>Classe dominante</th><th className="text-right">Taille</th><th className="text-right">Croissance</th></tr></thead>
              <tbody>
                {s3Items.slice(0, 12).map((row, idx) => {
                  const accountLabel = accountMap?.get(row.accountId) || row.accountId || '—';
                  const growth = Number(row.growthBytes || 0);
                  return (
                    <tr
                      key={`${row.bucket}-${row.region}-${idx}`}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => openDrilldown({
                        kind: 'bucket',
                        title: row.bucket,
                        bucket: row.bucket,
                        accountId: row.accountId,
                        region: row.region
                      })}
                    >
                      <td className="font-medium">{row.bucket}</td>
                      <td>{accountLabel}</td>
                      <td>{row.region || '—'}</td>
                      <td>{dominantS3Class(row.classes)}</td>
                      <td className="text-right">{formatBytesDecimal(row.latestBytes, { spaced: true }).text}</td>
                      <td className={`text-right ${growth > 0 ? 'text-amber-700' : growth < 0 ? 'text-emerald-700' : ''}`}>
                        {formatSignedBytes(growth)}
                      </td>
                    </tr>
                  );
                })}
                {!s3Items.length && <tr><td colSpan="6" className="py-4 text-center muted">Aucun snapshot S3 disponible.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Qualité des données</div>
            <div className="text-sm muted">Fraîcheur, couverture métriques et trous de dates</div>
          </div>
          <TrustBadge type="cache">Contrôle DB</TrustBadge>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr><th>Métrique</th><th>Début</th><th>Fin</th><th className="text-right">Lignes</th><th className="text-right">Comptes</th><th className="text-right">Services</th><th className="text-right">Jours manquants</th></tr></thead>
            <tbody>
              {qualityMetrics.map(row => (
                <tr key={row.metric}>
                  <td>{row.metric}</td>
                  <td>{row.minDay || '—'}</td>
                  <td>{row.maxDay || '—'}</td>
                  <td className="text-right">{Number(row.rows || 0).toLocaleString('fr-FR')}</td>
                  <td className="text-right">{Number(row.accounts || 0).toLocaleString('fr-FR')}</td>
                  <td className="text-right">{Number(row.services || 0).toLocaleString('fr-FR')}</td>
                  <td className={`text-right ${Number(row.missingDays || 0) ? 'text-amber-700' : 'text-emerald-700'}`}>{Number(row.missingDays || 0)}</td>
                </tr>
              ))}
              {!qualityMetrics.length && <tr><td colSpan="7" className="py-4 text-center muted">Aucune métrique coût disponible.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <DrilldownPanel
        target={drilldownTarget}
        data={drilldown.data}
        loading={drilldown.loading}
        error={drilldown.error}
        accountMap={accountMap}
        onClose={() => {
          setDrilldownTarget(null);
          setDrilldown({ loading: false, error: null, data: null });
        }}
      />
    </div>
  );
}

function SpTab({ start, end, selectedRegionsCsv = '', accountMap }) {
  const [utilRows, setUtilRows] = useState([]);
  const [utilSummary, setUtilSummary] = useState(null);
  const [coverageRows, setCoverageRows] = useState([]);
  const [spGroups, setSpGroups] = useState([]);
  const [spUncovered, setSpUncovered] = useState([]);
  const [mappingSummary, setMappingSummary] = useState(null);
  const [mappingMode, setMappingMode] = useState('');
  const [spInventory, setSpInventory] = useState([]);
  const [hideInactiveInstances, setHideInactiveInstances] = useState(true);
  const [costRows, setCostRows] = useState([]);

  const [typeFilter, setTypeFilter] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [coverageRegionFilter, setCoverageRegionFilter] = useState('');

  const [coverageSort, setCoverageSort] = useState({ key: 'coveragePct', dir: 'desc' });
  const [groupSort, setGroupSort] = useState({ key: 'coveragePct', dir: 'desc' });
  const [uncoveredSort, setUncoveredSort] = useState({ key: 'launchTime', dir: 'desc' });

  const [coveragePage, setCoveragePage] = useState(0);
  const [groupPage, setGroupPage] = useState(0);
  const [uncoveredPage, setUncoveredPage] = useState(0);

  const [utilLoading, setUtilLoading] = useState(false);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [costLoading, setCostLoading] = useState(false);
  const [utilError, setUtilError] = useState(null);
  const [coverageError, setCoverageError] = useState(null);
  const [mappingError, setMappingError] = useState(null);
  const [inventoryError, setInventoryError] = useState(null);
  const [costError, setCostError] = useState(null);

  const selectedRegions = useMemo(() => {
    return String(selectedRegionsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  }, [selectedRegionsCsv]);

  useEffect(() => {
    let cancelled = false;
    const params = buildRangeSearchParams(start, end);
    setUtilLoading(true);
    setUtilError(null);
    fetch('/api/sp/utilization?' + params.toString())
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const normalizedRows = normalizeRows(data?.rows || data || []);
        setUtilRows(normalizedRows);
        setUtilSummary(data?.summary || null);
      })
      .catch(err => {
        if (cancelled) return;
        setUtilRows([]);
        setUtilSummary(null);
        setUtilError(err);
      })
      .finally(() => { if (!cancelled) setUtilLoading(false); });
    return () => { cancelled = true; };
  }, [start, end]);

  useEffect(() => {
    let cancelled = false;
    const params = buildRangeSearchParams(start, end, { by: 'SAVINGS_PLAN_ARN,REGION,SAVINGS_PLANS_TYPE,PAYMENT_OPTION' });
    setCoverageLoading(true);
    setCoverageError(null);
    fetch('/api/sp/coverage?' + params.toString())
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        setCoverageRows(normalizeRows(data));
      })
      .catch(err => {
        if (cancelled) return;
        setCoverageRows([]);
        setCoverageError(err);
      })
      .finally(() => { if (!cancelled) setCoverageLoading(false); });
    return () => { cancelled = true; };
  }, [start, end]);

  useEffect(() => {
    let cancelled = false;
    const params = buildRangeSearchParams(start, end);
    if (selectedRegions.length) params.set('regions', selectedRegions.join(','));
    setMappingLoading(true);
    setMappingError(null);
    fetch('/api/sp/mapping?' + params.toString())
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const groups = Array.isArray(data?.groups) ? data.groups : [];
        const uncovered = Array.isArray(data?.uncoveredInstances) ? data.uncoveredInstances : [];
        setSpGroups(groups);
        setSpUncovered(uncovered);
        setMappingSummary(data?.summary || null);
        setMappingMode(String(data?.mode || ''));
      })
      .catch(err => {
        if (cancelled) return;
        setSpGroups([]);
        setSpUncovered([]);
        setMappingSummary(null);
        setMappingMode('');
        setMappingError(err);
      })
      .finally(() => { if (!cancelled) setMappingLoading(false); });
    return () => { cancelled = true; };
  }, [start, end, selectedRegions.join(',')]);

  useEffect(() => {
    let cancelled = false;
    setInventoryLoading(true);
    setInventoryError(null);
    fetch('/api/sp/inventory')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        setSpInventory(Array.isArray(data) ? data : []);
      })
      .catch(err => {
        if (cancelled) return;
        setSpInventory([]);
        setInventoryError(err);
      })
      .finally(() => { if (!cancelled) setInventoryLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (selectedRegions.length) params.set('regions', selectedRegions.join(','));
    params.set('include_ri', '0');
    params.set('includeRi', '0');
    setCostLoading(true);
    setCostError(null);
    getJSON('/api/ec2/cost-estimates', Object.fromEntries(params), { cacheTtlMs: 5 * 60 * 1000 })
      .then(data => {
        if (cancelled) return;
        setCostRows(normalizeRows(data));
      })
      .catch(err => {
        if (cancelled) return;
        setCostRows([]);
        setCostError(err);
      })
      .finally(() => { if (!cancelled) setCostLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRegions.join(',')]);

  const latestUtilization = useMemo(() => {
    if (!Array.isArray(utilRows) || utilRows.length === 0) return null;
    const sorted = utilRows.slice().sort((a, b) => {
      const ta = a.date ? Date.parse(a.date) : 0;
      const tb = b.date ? Date.parse(b.date) : 0;
      return tb - ta;
    });
    return sorted[0];
  }, [utilRows]);

  const previousUtilization = useMemo(() => {
    if (!Array.isArray(utilRows) || utilRows.length < 2) return null;
    const sorted = utilRows.slice().sort((a, b) => {
      const ta = a.date ? Date.parse(a.date) : 0;
      const tb = b.date ? Date.parse(b.date) : 0;
      return tb - ta;
    });
    return sorted[1] || null;
  }, [utilRows]);

  const utilizationDeltaPct = useMemo(() => {
    if (!latestUtilization || !previousUtilization) return null;
    return Number(latestUtilization.utilizationPct || 0) - Number(previousUtilization.utilizationPct || 0);
  }, [latestUtilization, previousUtilization]);

  const utilizationChartData = useMemo(() => {
    return (Array.isArray(utilRows) ? utilRows : []).map(row => ({
      date: row.date || '',
      utilizationPct: Number(row.utilizationPct ?? row.UtilizationPercentage ?? 0),
      used: Number(row.usedCommitment ?? row.UsedCommitment ?? 0),
      total: Number(row.totalCommitment ?? row.TotalCommitment ?? 0),
      unused: Number(row.unusedCommitment ?? row.UnusedCommitment ?? 0),
      savings: Number(row?.savings?.netSavings ?? row.NetSavings ?? 0)
    }));
  }, [utilRows]);

  const savingsSparkData = useMemo(() => {
    return utilizationChartData.map(row => ({ date: row.date, value: row.savings }));
  }, [utilizationChartData]);

  const spInventoryProcessed = useMemo(() => {
    const toLabel = (value) => {
      if (!value) return '—';
      const str = String(value);
      if (!str.includes('T')) return str;
      return str.replace('T', ' ').slice(0, 19);
    };
    return (Array.isArray(spInventory) ? spInventory : [])
      .map(plan => {
        const currency = plan.currency || plan.Currency || 'USD';
        const commitment = Number(plan.commitment ?? plan.Commitment ?? 0);
        const upfront = Number(plan.upfrontPaymentAmount ?? plan.UpfrontPaymentAmount ?? 0);
        const recurring = Number(plan.recurringPaymentAmount ?? plan.RecurringPaymentAmount ?? 0);
        const productTypes = Array.isArray(plan.productTypes || plan.ProductTypes) ? (plan.productTypes || plan.ProductTypes) : [];
        const startRaw = plan.start || plan.Start;
        const endRaw = plan.end || plan.End;
        return {
          id: plan.id || plan.savingsPlanId || plan.SavingsPlanId || '—',
          arn: plan.arn || plan.savingsPlanArn || plan.SavingsPlanArn || '—',
          description: plan.description || plan.Description || '',
          state: plan.state || plan.State || '—',
          type: plan.type || plan.savingsPlanType || plan.SavingsPlanType || '—',
          paymentOption: plan.paymentOption || plan.PaymentOption || '—',
          region: plan.region || plan.Region || 'Any',
          instanceFamily: plan.instanceFamily || plan.ec2InstanceFamily || plan.EC2InstanceFamily || '—',
          currency,
          commitment,
          upfront,
          recurring,
          start: toLabel(startRaw),
          end: toLabel(endRaw),
          startRaw,
          endRaw,
          productTypes,
        };
      })
      .sort((a, b) => {
        const ta = a.startRaw ? Date.parse(a.startRaw) : 0;
        const tb = b.startRaw ? Date.parse(b.startRaw) : 0;
        return tb - ta;
      });
  }, [spInventory]);

  const coverageProcessed = useMemo(() => {
    return (Array.isArray(coverageRows) ? coverageRows : []).map(row => {
      const attrs = row.attributes || {};
      const region = attrs.region || attrs.Region || attrs.REGION || '—';
      const spType = attrs.savingsPlansType || attrs.SavingsPlansType || attrs.SAVINGS_PLANS_TYPE || '—';
      const payment = attrs.paymentOption || attrs.PaymentOption || attrs.PAYMENT_OPTION || '—';
      return {
        date: row.date || '',
        arn: attrs.savingsPlanArn || attrs.SavingsPlanArn || attrs.SAVINGS_PLAN_ARN || '—',
        region,
        type: spType,
        payment,
        coveragePct: Number(row.coveragePct ?? row.CoveragePercentage ?? 0),
        spendCovered: Number(row.spendCoveredBySp ?? row.SpendCoveredBySavingsPlans ?? 0),
        onDemandCost: Number(row.onDemandCost ?? row.OnDemandCost ?? 0),
        totalCost: Number(row.totalCost ?? row.TotalCost ?? 0)
      };
    });
  }, [coverageRows]);

  const coverageFiltered = useMemo(() => {
    const regionNeedle = coverageRegionFilter.toLowerCase();
    const typeNeedle = typeFilter.toLowerCase();
    const paymentNeedle = paymentFilter.toLowerCase();
    return coverageProcessed.filter(row => {
      const regionMatch = regionNeedle ? String(row.region || '').toLowerCase() === regionNeedle : true;
      const typeMatch = typeNeedle ? String(row.type || '').toLowerCase().includes(typeNeedle) : true;
      const payMatch = paymentNeedle ? String(row.payment || '').toLowerCase().includes(paymentNeedle) : true;
      return regionMatch && typeMatch && payMatch;
    });
  }, [coverageProcessed, coverageRegionFilter, typeFilter, paymentFilter]);

  const coverageSorted = useMemo(() => {
    const arr = coverageFiltered.slice();
    const { key, dir } = coverageSort;
    const getVal = (row) => {
      switch (key) {
        case 'date': return row.date || '';
        case 'type': return row.type || '';
        case 'payment': return row.payment || '';
        case 'region': return row.region || '';
        case 'coveragePct': return row.coveragePct;
        case 'spendCovered': return row.spendCovered;
        case 'onDemandCost': return row.onDemandCost;
        case 'totalCost': return row.totalCost;
        default: return null;
      }
    };
    arr.sort((a, b) => {
      const av = getVal(a); const bv = getVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return dir === 'asc' ? 1 : -1;
      if (bv == null) return dir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      return dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [coverageFiltered, coverageSort]);

  useEffect(() => { setCoveragePage(0); }, [coverageFiltered.length, coverageSort, coverageRegionFilter, typeFilter, paymentFilter]);
  const coveragePageSize = 25;
  const coveragePageCount = Math.max(1, Math.ceil((coverageSorted.length || 0) / coveragePageSize));
  const coveragePageData = coverageSorted.slice(coveragePage * coveragePageSize, (coveragePage + 1) * coveragePageSize);

  const spGroupsProcessed = useMemo(() => {
    return (Array.isArray(spGroups) ? spGroups : []).map(group => ({
      rowId: group.rowId || group.planId || group.arn || '',
      planId: group.planId || '—',
      arn: group.arn || '',
      description: group.description || '',
      type: group.type || '—',
      paymentOption: group.paymentOption || '—',
      region: group.region || '—',
      family: group.family || 'any',
      coveragePct: Number(group.coveragePct || 0),
      commitment: Number(group.commitment || 0),
      usedCommitment: Number(group.usedCommitment || 0),
      unusedCommitment: Number(group.unusedCommitment || 0),
      eligibleHourly: Number(group.eligibleHourly || 0),
      totalInstances: Number(group.totalInstances || 0),
      coveredInstancesCount: Number(group.coveredInstancesCount || 0),
      matchedInstances: Array.isArray(group.matchedInstances) ? group.matchedInstances : [],
    }));
  }, [spGroups]);

  const spGroupsFiltered = useMemo(() => {
    const regionNeedle = coverageRegionFilter.toLowerCase();
    return spGroupsProcessed.filter(group => {
      const regionMatch = regionNeedle ? String(group.region || '').toLowerCase() === regionNeedle : true;
      return regionMatch;
    });
  }, [spGroupsProcessed, coverageRegionFilter]);

  const spGroupsSorted = useMemo(() => {
    const arr = spGroupsFiltered.slice();
    const { key, dir } = groupSort;
    const getVal = (row) => {
      switch (key) {
        case 'plan': return row.planId || '';
        case 'type': return row.type || '';
        case 'payment': return row.paymentOption || '';
        case 'region': return row.region || '';
        case 'family': return row.family || '';
        case 'coveragePct': return row.coveragePct;
        case 'commitment': return row.commitment;
        case 'usedCommitment': return row.usedCommitment;
        case 'unusedCommitment': return row.unusedCommitment;
        case 'eligibleHourly': return row.eligibleHourly;
        case 'covered': return row.coveredInstancesCount;
        case 'instances': return row.totalInstances;
        default: return null;
      }
    };
    arr.sort((a, b) => {
      const av = getVal(a); const bv = getVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return dir === 'asc' ? 1 : -1;
      if (bv == null) return dir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      return dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [spGroupsFiltered, groupSort]);

  useEffect(() => { setGroupPage(0); }, [spGroupsFiltered.length, groupSort, coverageRegionFilter]);
  const groupPageSize = 15;
  const groupPageCount = Math.max(1, Math.ceil((spGroupsSorted.length || 0) / groupPageSize));
  const spGroupsPage = spGroupsSorted.slice(groupPage * groupPageSize, (groupPage + 1) * groupPageSize);

  const getInstanceState = useCallback((inst = {}) => {
    const raw = inst.state || inst.State || inst.instanceState || inst.InstanceState || inst.status || inst.Status || '';
    return String(raw || '');
  }, []);

  const isInactiveInstance = useCallback((inst = {}) => {
    const state = getInstanceState(inst).toLowerCase();
    if (!state) return false;
    if (state.includes('stopp')) return true;
    if (state.includes('termin')) return true;
    return false;
  }, [getInstanceState]);

  const spUncoveredFiltered = useMemo(() => {
    const regionNeedle = coverageRegionFilter.toLowerCase();
    const base = Array.isArray(spUncovered) ? spUncovered : [];
    const filteredByState = hideInactiveInstances ? base.filter(inst => !isInactiveInstance(inst)) : base;
    return filteredByState.filter(inst => {
      if (!regionNeedle) return true;
      const instRegion = (inst.region || (inst.az ? String(inst.az).slice(0, -1) : '') || '').toLowerCase();
      return instRegion === regionNeedle;
    });
  }, [spUncovered, hideInactiveInstances, isInactiveInstance, coverageRegionFilter]);

  const uncoveredSorted = useMemo(() => {
    const arr = spUncoveredFiltered.slice();
    const { key, dir } = uncoveredSort;
    const getVal = (inst) => {
      switch (key) {
        case 'account': return extractAccountId(inst) || '';
        case 'instanceId': return inst.instanceId || '';
        case 'name': return inst.name || '';
        case 'type': return inst.instanceType || '';
        case 'az': return inst.az || inst.availabilityZone || '';
        case 'platform': return inst.platform || 'Linux/UNIX';
        case 'state': return inst.state || inst.Status || '';
        case 'launchTime': {
          const ts = inst.launchTime ? Date.parse(inst.launchTime) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        default: return null;
      }
    };
    arr.sort((a, b) => {
      const av = getVal(a); const bv = getVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return dir === 'asc' ? 1 : -1;
      if (bv == null) return dir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      return dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [spUncoveredFiltered, uncoveredSort]);

  useEffect(() => { setUncoveredPage(0); }, [uncoveredSort, spUncoveredFiltered.length, coverageRegionFilter, hideInactiveInstances]);
  const uncoveredPageSize = 30;
  const uncoveredPageCount = Math.max(1, Math.ceil((uncoveredSorted.length || 0) / uncoveredPageSize));
  const uncoveredPageData = uncoveredSorted.slice(uncoveredPage * uncoveredPageSize, (uncoveredPage + 1) * uncoveredPageSize);

  const handleCoverageSort = (key) => {
    setCoverageSort(prev => {
      const dir = prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : (['coveragePct', 'spendCovered', 'onDemandCost', 'totalCost'].includes(key) ? 'desc' : 'asc');
      return { key, dir };
    });
  };

  const handleGroupSort = (key) => {
    setGroupSort(prev => {
      const dir = prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : (['coveragePct', 'commitment', 'usedCommitment', 'unusedCommitment', 'eligibleHourly', 'covered', 'instances'].includes(key) ? 'desc' : 'asc');
      return { key, dir };
    });
  };

  const handleUncoveredSort = (key) => {
    setUncoveredSort(prev => {
      const dir = prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : (key === 'launchTime' ? 'desc' : 'asc');
      return { key, dir };
    });
  };

  const coverageEmptyHelp = coverageLoading ? null : "Aucune donnée Saving Plan. Vérifie les droits Cost Explorer (ce:GetSavingsPlansCoverage/utilization).";

  const costMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(costRows) ? costRows : []).forEach(row => {
      const id = row.instanceId || row.InstanceId || row.resourceId || row.id;
      const rate = Number(row.onDemandHourly ?? row.on_demand_hourly ?? row.on_demand_hourly_usd ?? row.onDemandPricePerHour);
      if (!id) return;
      if (!Number.isFinite(rate) || rate <= 0) return;
      map.set(String(id), rate);
    });
    return map;
  }, [costRows]);

  const normalizeFamily = (type = '') => String(type || '').split('.')[0] || '';
  const normalizeRegion = (inst = {}) => {
    const region = inst.region || '';
    if (region) return region;
    const az = inst.az || inst.availabilityZone || '';
    return az ? az.slice(0, -1) : '';
  };

  const spPlanEstimates = useMemo(() => {
    const activePlans = spInventoryProcessed.filter(p => String(p.state || '').toLowerCase() === 'active');
    const regionFilter = coverageRegionFilter.toLowerCase();
    return activePlans.map(plan => {
      const planRegion = String(plan.region || 'Any');
      const regionKey = planRegion.toLowerCase();
      const familyKey = String(plan.instanceFamily || '').toLowerCase();
      const eligible = spUncoveredFiltered.filter(inst => {
        const instRegion = normalizeRegion(inst).toLowerCase();
        const instFamily = normalizeFamily(inst.instanceType).toLowerCase();
        const regionMatch = regionKey === 'any' || (instRegion && instRegion === regionKey);
        const filterMatch = !regionFilter || instRegion === regionFilter;
        const familyMatch = familyKey ? instFamily === familyKey : true;
        return regionMatch && filterMatch && familyMatch;
      });
      const prices = eligible.map(inst => ({
        inst,
        rate: costMap.get(inst.instanceId) || 0
      })).filter(x => x.rate > 0);
      const totalNeed = prices.reduce((s, p) => s + p.rate, 0);
      const commitment = Number(plan.commitment || 0);
      let remaining = commitment;
      const covered = [];
      prices.sort((a, b) => b.rate - a.rate).forEach(({ inst, rate }) => {
        const frac = rate > 0 ? Math.min(1, remaining / rate) : 0;
        if (frac > 0) {
          remaining -= frac * rate;
        }
        covered.push({ inst, rate, fraction: frac });
      });
      const coveragePct = totalNeed > 0 ? Math.min(100, (commitment / totalNeed) * 100) : null;
      return {
        plan,
        eligibleCount: eligible.length,
        totalNeed,
        coveragePct,
        covered
      };
    }).filter(est => est.eligibleCount > 0);
  }, [spInventoryProcessed, spUncoveredFiltered, coverageRegionFilter, costMap]);

  return (
    <>
      <div className="card p-4 mb-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold">Inventaire Savings Plans</div>
              <TrustBadge type="real">Réel AWS</TrustBadge>
              <TrustBadge type="cache">Cache navigateur</TrustBadge>
            </div>
            <div className="text-sm muted">Plans achetés détectés via l'API AWS Savings Plans</div>
          </div>
          <div className="text-sm muted">{inventoryLoading ? 'Chargement…' : `${spInventory.length} plan(s)`}</div>
        </div>
        {inventoryError && <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 p-2 rounded">Erreur inventaire: {inventoryError.message || 'appel /api/sp/inventory'}</div>}
        <div className="overflow-auto mt-4">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>État</th>
                <th>Option de paiement</th>
                <th>Produit</th>
                <th>Région</th>
                <th>Famille</th>
                <th>Engagement horaire</th>
                <th>Upfront</th>
                <th>Recurrence</th>
                <th>Début</th>
                <th>Fin</th>
              </tr>
            </thead>
            <tbody>
              {spInventoryProcessed.map(plan => {
                const commitmentLabel = plan.commitment ? formatCurrency(plan.commitment, plan.currency, { maximumFractionDigits: 6 }) : '—';
                const upfrontLabel = plan.upfront ? formatCurrency(plan.upfront, plan.currency, { maximumFractionDigits: 2 }) : '—';
                const recurringLabel = plan.recurring ? formatCurrency(plan.recurring, plan.currency, { maximumFractionDigits: 2 }) : '—';
                return (
                  <tr key={plan.id || plan.arn}>
                    <td>
                      <div className="flex flex-col">
                        <span className="font-medium">{plan.id || '—'}</span>
                        {plan.arn && <span className="text-[11px] muted break-all">{plan.arn}</span>}
                        {plan.description && <span className="text-[11px] text-slate-600">{plan.description}</span>}
                      </div>
                    </td>
                    <td>{plan.type || '—'}</td>
                    <td>{plan.state || '—'}</td>
                    <td>{plan.paymentOption || '—'}</td>
                    <td>{plan.productTypes && plan.productTypes.length ? plan.productTypes.join(', ') : '—'}</td>
                    <td>{plan.region || '—'}</td>
                    <td>{plan.instanceFamily || '—'}</td>
                    <td>{commitmentLabel}</td>
                    <td>{upfrontLabel}</td>
                    <td>{recurringLabel}</td>
                    <td>{plan.start || '—'}</td>
                    <td>{plan.end || '—'}</td>
                  </tr>
                );
              })}
              {spInventoryProcessed.length === 0 && !inventoryLoading && (
                <tr><td colSpan="12" className="text-center muted py-4">Aucun Savings Plan détecté.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4 mt-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold">Couverture potentielle par Savings Plan</div>
              <TrustBadge type="estimate">Estimation locale</TrustBadge>
              <TrustBadge type="cache">Tarifs EC2 locaux</TrustBadge>
            </div>
            <div className="text-sm muted">Calcule une couverture théorique à partir des plans actifs (commitment horaire) et des instances non couvertes par SP.</div>
            {costError && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded mt-1">Tarifs on-demand indisponibles: {costError.message || 'appel /api/ec2/cost-estimates'}</div>}
          </div>
          <div className="text-sm muted">
            {costLoading ? 'Tarifs: chargement…' : `Tarifs chargés pour ${costMap.size} instance(s)`}{coverageRegionFilter ? ` • région ${coverageRegionFilter}` : ''}
          </div>
        </div>
        <div className="overflow-auto mt-3">
          <table className="table w-full text-sm table-wrap">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Région</th>
                <th>Famille</th>
                <th className="text-right">Commitment (h)</th>
                <th className="text-right">Besoin total (h)</th>
                <th className="text-right">Couverture estimée</th>
                <th>Instances éligibles (ordre coût)</th>
              </tr>
            </thead>
            <tbody>
              {spPlanEstimates.map(est => {
                const { plan, eligibleCount, totalNeed, coveragePct, covered } = est;
                const label = plan.description || plan.id || plan.arn || 'Plan';
                return (
                  <tr key={plan.id || plan.arn}>
                    <td>
                      <div className="flex flex-col">
                        <span className="font-medium">{label}</span>
                        <span className="text-[11px] text-slate-600">{plan.type || plan.savingsPlanType || ''} • {plan.paymentOption || ''}</span>
                      </div>
                    </td>
                    <td>{plan.region || 'Any'}</td>
                    <td>{plan.instanceFamily || '—'}</td>
                    <td className="text-right">{plan.commitment ? formatCurrency(plan.commitment, plan.currency || 'USD', { maximumFractionDigits: 4 }) : '—'}</td>
                    <td className="text-right">{totalNeed ? formatCurrency(totalNeed, plan.currency || 'USD', { maximumFractionDigits: 4 }) : '—'}</td>
                    <td className="text-right">
                      {coveragePct != null ? (
                        <span className={coveragePct >= 100 ? 'text-emerald-700' : 'text-amber-700'}>
                          {coveragePct.toFixed(1)}%
                        </span>
                      ) : '—'}
                      <div className="text-[11px] muted">{eligibleCount} instance(s) éligibles</div>
                    </td>
                    <td>
                      {covered.length ? (
                        <div className="flex flex-wrap gap-2">
                          {covered.slice(0, 8).map((c, idx) => {
                            const name = c.inst.name || c.inst.instanceId || '—';
                            const frac = c.fraction;
                            const pct = Math.round(frac * 100);
                            return (
                              <span key={`${c.inst.instanceId || idx}`} className="px-2 py-1 rounded-full bg-slate-200 text-slate-700 text-xs inline-flex flex-col">
                                <span className="font-medium">{name}</span>
                                <span className="text-[11px] text-slate-600">{c.inst.instanceType || ''} · {formatCurrency(c.rate)}</span>
                                <span className={`text-[11px] ${frac >= 1 ? 'text-emerald-700' : 'text-amber-700'}`}>{pct}% couvert</span>
                              </span>
                            );
                          })}
                          {covered.length > 8 && <span className="text-[11px] muted">+{covered.length - 8} autres</span>}
                        </div>
                      ) : (
                        <span className="muted text-xs">Aucune instance éligible (ou tarif manquant).</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!spPlanEstimates.length && (
                <tr><td colSpan="7" className="text-center muted py-4">Aucune estimation possible (pas de plan actif ou pas d'instances éligibles dans la sélection).</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4 mb-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold">Utilisation des Saving Plans officielle AWS</div>
              <TrustBadge type="real">Réel AWS officiel</TrustBadge>
              <TrustBadge type="cache">Cache CE</TrustBadge>
            </div>
            <div className="text-sm muted">Période du {start} au {end}</div>
            {utilError && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-2 py-1 mt-1 rounded">Erreur utilisation: {utilError.message || 'appel /api/sp/utilization'}</div>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              <div className="text-xs uppercase tracking-wide text-emerald-700">Utilisation</div>
              <div className="text-2xl font-semibold text-emerald-900">
                {utilLoading ? '…' : latestUtilization ? `${Number(latestUtilization.utilizationPct || 0).toFixed(1)}%` : '—'}
              </div>
              {utilizationDeltaPct != null && (
                <div className={`text-xs ${utilizationDeltaPct >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {utilizationDeltaPct >= 0 ? '▲' : '▼'} {Math.abs(utilizationDeltaPct).toFixed(1)}% vs point précédent
                </div>
              )}
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="text-xs uppercase tracking-wide text-blue-700">Engagement utilisé</div>
              <div className="text-lg font-semibold text-blue-900">
                {utilLoading ? '…' : latestUtilization ? formatCurrency(Number(latestUtilization.usedCommitment), 'USD', { maximumFractionDigits: 2 }) : '—'}
              </div>
            </div>
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
              <div className="text-xs uppercase tracking-wide text-orange-700">Inutilisé</div>
              <div className="text-lg font-semibold text-orange-900">
                {utilLoading ? '…' : latestUtilization ? formatCurrency(Number(latestUtilization.unusedCommitment), 'USD', { maximumFractionDigits: 2 }) : '—'}
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="text-xs uppercase tracking-wide text-amber-700">Économies nettes</div>
              <div className="text-lg font-semibold text-amber-900">
                {utilLoading ? '…' : utilSummary ? formatCurrency(Number(utilSummary?.savings?.netSavings ?? 0), 'USD', { maximumFractionDigits: 2 }) : '—'}
              </div>
              <MiniSparkline data={savingsSparkData.slice(-30)} />
            </div>
          </div>
        </div>
        <div className="h-72 mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={utilizationChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 12 }} domain={[0, 100]} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} hide />
              <Tooltip formatter={(value, name) => {
                if (name === 'utilizationPct') return [`${Number(value || 0).toFixed(1)}%`, 'Utilisation'];
                return [formatCurrency(value, 'USD', { maximumFractionDigits: 2 }), name];
              }} />
              <Legend />
              <Area yAxisId="left" type="monotone" dataKey="utilizationPct" name="Utilisation %" stroke="#22c55e" fill="#bbf7d0" />
              <Area yAxisId="right" type="monotone" dataKey="used" name="Engagement utilisé" stroke="#3b82f6" fill="#dbeafe" />
              <Area yAxisId="right" type="monotone" dataKey="unused" name="Engagement inutilisé" stroke="#f97316" fill="#ffedd5" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold">Couverture Savings Plans officielle AWS</div>
              <TrustBadge type="real">Réel AWS officiel</TrustBadge>
              <TrustBadge type="cache">Cache CE</TrustBadge>
            </div>
            <div className="text-sm muted">Regroupé par ARN, région, type et option de paiement</div>
            {coverageError && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded mt-1">Erreur couverture: {coverageError.message || 'appel /api/sp/coverage'}</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="input" placeholder="Filtre région (ex: eu-west-3)" value={coverageRegionFilter} onChange={e=>setCoverageRegionFilter(e.target.value)} />
            <input className="input" placeholder="Filtre type" value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} />
            <input className="input" placeholder="Filtre option paiement" value={paymentFilter} onChange={e=>setPaymentFilter(e.target.value)} />
          </div>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-sm table-wrap">
            <thead>
              <tr>
                <th className="cursor-pointer" onClick={()=>handleCoverageSort('date')}>Date <SortIndicator active={coverageSort.key==='date'} dir={coverageSort.dir} /></th>
                <th>ARN</th>
                <th className="cursor-pointer" onClick={()=>handleCoverageSort('type')}>Type <SortIndicator active={coverageSort.key==='type'} dir={coverageSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleCoverageSort('payment')}>Option <SortIndicator active={coverageSort.key==='payment'} dir={coverageSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleCoverageSort('region')}>Région <SortIndicator active={coverageSort.key==='region'} dir={coverageSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleCoverageSort('coveragePct')}>Couverture % <SortIndicator active={coverageSort.key==='coveragePct'} dir={coverageSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleCoverageSort('spendCovered')}>Spend couvert <SortIndicator active={coverageSort.key==='spendCovered'} dir={coverageSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleCoverageSort('onDemandCost')}>Coût on-demand <SortIndicator active={coverageSort.key==='onDemandCost'} dir={coverageSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleCoverageSort('totalCost')}>Coût total <SortIndicator active={coverageSort.key==='totalCost'} dir={coverageSort.dir} /></th>
              </tr>
            </thead>
            <tbody>
              {coveragePageData.map((row, i) => (
                <tr key={`${row.arn}-${i}`}>
                  <td>{row.date || '—'}</td>
                  <td className="max-w-xs break-all">{row.arn}</td>
                  <td>{row.type || '—'}</td>
                  <td>{row.payment || '—'}</td>
                  <td>{row.region || '—'}</td>
                  <td className="text-right">{row.coveragePct.toFixed(1)}%</td>
                  <td className="text-right">{formatCurrency(row.spendCovered)}</td>
                  <td className="text-right">{formatCurrency(row.onDemandCost)}</td>
                  <td className="text-right">{formatCurrency(row.totalCost)}</td>
                </tr>
              ))}
              {!coverageLoading && coveragePageData.length === 0 && (
                <tr><td colSpan="9" className="text-center muted py-4">{coverageEmptyHelp}</td></tr>
              )}
              {coverageLoading && <tr><td colSpan="9" className="text-center muted py-4">Chargement…</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={coveragePage} pageCount={coveragePageCount} onPageChange={setCoveragePage} />
      </div>

      <div className="card p-4 mt-6">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold">Mapping estimé Saving Plan ↔ Instances</div>
              <TrustBadge type="estimate">Estimation locale</TrustBadge>
              <TrustBadge type="real">Engagement réel AWS</TrustBadge>
            </div>
            <div className="text-sm muted">Allocation commitment-aware estimée à partir de l'engagement horaire réel des plans actifs</div>
            {mappingSummary && (
              <div className="text-xs text-slate-600 mt-1">
                Mode: {mappingMode || 'commitment_aware_hourly'} · Plans: {Number(mappingSummary.plans || 0)} ·
                Commitment total: {formatCurrency(Number(mappingSummary.totalCommitment || 0), 'USD', { maximumFractionDigits: 4 })}/h ·
                Utilisé: {formatCurrency(Number(mappingSummary.usedCommitment || 0), 'USD', { maximumFractionDigits: 4 })}/h ·
                Restant: {formatCurrency(Number(mappingSummary.unusedCommitment || 0), 'USD', { maximumFractionDigits: 4 })}/h
              </div>
            )}
            {mappingError && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded mt-1">Erreur mapping: {mappingError.message || 'appel /api/sp/mapping'}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input className="input" placeholder="Région (ex: eu-west-3)" value={coverageRegionFilter} onChange={e=>setCoverageRegionFilter(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="checkbox" checked={hideInactiveInstances} onChange={e=>setHideInactiveInstances(e.target.checked)} />
              <span>Masquer les instances stopped/terminated</span>
            </label>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-sm table-wrap">
            <thead>
              <tr>
                <th className="cursor-pointer" onClick={()=>handleGroupSort('plan')}>Plan <SortIndicator active={groupSort.key==='plan'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleGroupSort('type')}>Type <SortIndicator active={groupSort.key==='type'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleGroupSort('payment')}>Paiement <SortIndicator active={groupSort.key==='payment'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleGroupSort('region')}>Région <SortIndicator active={groupSort.key==='region'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleGroupSort('family')}>Famille <SortIndicator active={groupSort.key==='family'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('coveragePct')}>Couverture % <SortIndicator active={groupSort.key==='coveragePct'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('commitment')}>Commitment (USD/h) <SortIndicator active={groupSort.key==='commitment'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('usedCommitment')}>Utilisé (USD/h) <SortIndicator active={groupSort.key==='usedCommitment'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('unusedCommitment')}>Restant (USD/h) <SortIndicator active={groupSort.key==='unusedCommitment'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('covered')}>Couvert <SortIndicator active={groupSort.key==='covered'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('eligibleHourly')}>Besoin éligible (USD/h) <SortIndicator active={groupSort.key==='eligibleHourly'} dir={groupSort.dir} /></th>
                <th className="cursor-pointer text-right" onClick={()=>handleGroupSort('instances')}>Instances <SortIndicator active={groupSort.key==='instances'} dir={groupSort.dir} /></th>
              </tr>
            </thead>
            <tbody>
              {spGroupsPage.map((group, i) => (
                <tr key={`${group.rowId || group.planId || group.arn || 'sp'}-${i}`}>
                  <td>
                    <div className="flex flex-col">
                      <span className="font-medium">{group.planId || '—'}</span>
                      {group.description ? <span className="text-[11px] text-slate-600">{group.description}</span> : null}
                      {group.arn ? <span className="text-[11px] muted break-all">{group.arn}</span> : null}
                    </div>
                  </td>
                  <td>{group.type}</td>
                  <td>{group.paymentOption}</td>
                  <td>{group.region}</td>
                  <td>{group.family}</td>
                  <td className="text-right">{group.coveragePct.toFixed(1)}%</td>
                  <td className="text-right">{formatCurrency(group.commitment, 'USD', { maximumFractionDigits: 4 })}</td>
                  <td className="text-right">{formatCurrency(group.usedCommitment, 'USD', { maximumFractionDigits: 4 })}</td>
                  <td className="text-right">{formatCurrency(group.unusedCommitment, 'USD', { maximumFractionDigits: 4 })}</td>
                  <td className="text-right">{group.coveredInstancesCount}/{group.totalInstances}</td>
                  <td className="text-right">{formatCurrency(group.eligibleHourly, 'USD', { maximumFractionDigits: 4 })}</td>
                  <td>
                    {group.matchedInstances.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {group.matchedInstances.map((inst, idx) => {
                          const acctName = accountMap?.get(inst.accountId) || inst.accountId || '';
                          const parts = [];
                          if (acctName) parts.push(acctName);
                          if (inst.instanceType) parts.push(inst.instanceType);
                          if (inst.family) parts.push(inst.family);
                          if (inst.region) parts.push(inst.region);
                          const subtitle = parts.join(' · ');
                          const allocatedLabel = Number.isFinite(Number(inst.allocatedHourly))
                            ? `${formatCurrency(Number(inst.allocatedHourly), 'USD', { maximumFractionDigits: 4 })}/h`
                            : null;
                          const coveredLabel = Number.isFinite(Number(inst.allocatedCoveragePct))
                            ? `${Number(inst.allocatedCoveragePct).toFixed(1)}%`
                            : null;
                          return (
                            <span key={`${inst.instanceId || inst.name || 'sp'}-${idx}`} className="px-2 py-1 rounded-full bg-slate-200 text-slate-700 text-xs inline-flex flex-col">
                              <span className="font-medium">{inst.name || inst.instanceId || '—'}</span>
                              <span className="text-[11px] text-slate-600">{subtitle || '—'}</span>
                              <span className="text-[11px] text-slate-600">
                                {allocatedLabel || '—'}{coveredLabel ? ` · ${coveredLabel}` : ''}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="muted text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!mappingLoading && spGroupsPage.length === 0 && (
                <tr><td colSpan="12" className="text-center muted py-4">Pas de correspondance Saving Plan disponible.</td></tr>
              )}
              {mappingLoading && <tr><td colSpan="12" className="text-center muted py-4">Chargement…</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={groupPage} pageCount={groupPageCount} onPageChange={setGroupPage} />
      </div>

      <div className="card p-4 mt-6">
        <div className="text-base font-semibold mb-2">Instances non couvertes par les Savings Plans</div>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('account')}>Compte <SortIndicator active={uncoveredSort.key==='account'} dir={uncoveredSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('instanceId')}>InstanceId <SortIndicator active={uncoveredSort.key==='instanceId'} dir={uncoveredSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('name')}>Nom <SortIndicator active={uncoveredSort.key==='name'} dir={uncoveredSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('type')}>Type <SortIndicator active={uncoveredSort.key==='type'} dir={uncoveredSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('platform')}>Plateforme <SortIndicator active={uncoveredSort.key==='platform'} dir={uncoveredSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('az')}>AZ <SortIndicator active={uncoveredSort.key==='az'} dir={uncoveredSort.dir} /></th>
                <th>PrivIP</th>
                <th>PubIP</th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('launchTime')}>Lancement <SortIndicator active={uncoveredSort.key==='launchTime'} dir={uncoveredSort.dir} /></th>
                <th className="cursor-pointer" onClick={()=>handleUncoveredSort('state')}>État <SortIndicator active={uncoveredSort.key==='state'} dir={uncoveredSort.dir} /></th>
              </tr>
            </thead>
            <tbody>
              {uncoveredPageData.map((inst, i) => {
                const accountId = extractAccountId(inst);
                const accountName = (accountMap && accountMap.get(accountId)) || accountId || '—';
                const launchStr = String(inst.launchTime || '').slice(0, 19).replace('T', ' ');
                return (
                  <tr key={`${inst.instanceId || inst.name || 'uncovered-sp'}-${i}`}>
                    <td>{accountName}</td>
                    <td>{inst.instanceId || '—'}</td>
                    <td>{inst.name || '—'}</td>
                    <td>{inst.instanceType || '—'}</td>
                    <td>{inst.platform || 'Linux/UNIX'}</td>
                    <td>{inst.az || inst.availabilityZone || '—'}</td>
                    <td>{inst.privateIp || '—'}</td>
                    <td>{inst.publicIp || '—'}</td>
                    <td>{launchStr || '—'}</td>
                    <td>{getInstanceState(inst) || '—'}</td>
                  </tr>
                );
              })}
              {!mappingLoading && uncoveredPageData.length === 0 && (
                <tr><td colSpan="10" className="text-center muted py-4">Toutes les instances sont couvertes ou aucune donnée disponible.</td></tr>
              )}
              {mappingLoading && <tr><td colSpan="10" className="text-center muted py-4">Chargement…</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={uncoveredPage} pageCount={uncoveredPageCount} onPageChange={setUncoveredPage} />
      </div>
    </>
  );
}

function EC2Tab({accountMap, selectedRegionsCsv, regionsEffective, selectedAccount}){
  const [instances,setInstances]=useState([]); const [vols,setVols]=useState([]);
  // --- Filtres EC2
  const [q,setQ]=useState('');
  const [state,setState]=useState('');
  const [family,setFamily]=useState('');
  const [platform,setPlatform]=useState('');
  const [hasPubIp,setHasPubIp]=useState('');
  const [az,setAz]=useState('');
  const [vpcId,setVpcId]=useState('');
  const [riStatus,setRiStatus]=useState('');
  const [acc,setAcc]=useState('');
  const instanceNameMap = useMemo(()=>{
    const m = new Map();
    for (const inst of instances||[]) {
      const id = inst?.instanceId || inst?.id;
      if (!id) continue;
      const nm = extractInstanceName(inst);
      if (nm) m.set(id, nm);
    }
    return m;
  }, [instances]);

  const instancesFiltered = useMemo(()=>{
    const needle = q.toLowerCase();
    return (instances||[]).filter(x=>{
      const accountId = extractAccountId(x);
      if (acc && accountId!==acc) return false;
      if (selectedAccount && accountId!==selectedAccount) return false;
      if (state && String(x.state||'').toLowerCase()!==state) return false;
      if (family && !String(x.type||'').toLowerCase().startsWith(family.toLowerCase())) return false;
      if (platform && String(x.platform||'').toLowerCase().indexOf(platform.toLowerCase())===-1) return false;
      if (az && String(x.az||'')!==az) return false;
      if (vpcId && String(x.vpcId||'')!==vpcId) return false;
      if (riStatus==='covered' && !x.riCovered) return false;
      if (riStatus==='uncovered' && x.riCovered) return false;
      if (hasPubIp==='yes' && !x.publicIp) return false;
      if (hasPubIp==='no' && x.publicIp) return false;
      if (needle){
        const accName = (accountMap && accountMap.get(accountId)) || accountId || '';
        const scheduleName = x?.schedule?.name || x?.tagMap?.Scheduled_vle || x?.tagMap?.Scheduled_VLE || '';
        const hay = [x.instanceId, x.name, x.privateIp, x.publicIp, x.type, x.region, x.az, x.vpcId, accName, scheduleName].join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [instances, acc, selectedAccount, q, state, family, platform, hasPubIp, az, vpcId, riStatus, accountMap]);

  const [instanceSortKey, setInstanceSortKey] = useState(null);
  const [instanceSortDir, setInstanceSortDir] = useState('asc');

  const handleInstanceSort = (key) => {
    setInstanceSortKey((prevKey) => {
      if (prevKey === key) {
        setInstanceSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      const defaultDir = key === 'launchTime' ? 'desc' : 'asc';
      setInstanceSortDir(defaultDir);
      return key;
    });
  };

  const renderInstanceSortIndicator = (key) => {
    if (instanceSortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{instanceSortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const instancesSorted = useMemo(() => {
    const arr = instancesFiltered.slice();
    if (!instanceSortKey) return arr;
    const getValue = (row, key) => {
      switch (key) {
        case 'account':
          return (accountMap && accountMap.get(extractAccountId(row))) || extractAccountId(row) || '';
        case 'instanceId':
          return row.instanceId || row.InstanceId || row.id || '';
        case 'name':
          return extractInstanceName(row) || '';
        case 'type':
          return row.instanceType || row.type || '';
        case 'platform':
          return row.platform || 'Linux/UNIX';
        case 'ri':
          return row.riCovered ? 1 : 0;
        case 'schedule':
          return (row.schedule && row.schedule.name) || '';
        case 'az':
          return row.availabilityZone || row.az || '';
        case 'privIp':
          return row.privateIp || '';
        case 'pubIp':
          return row.publicIp || '';
        case 'launchTime': {
          const str = row.launchTime || row.LaunchTime || '';
          const ts = str ? Date.parse(str) : NaN;
          return Number.isFinite(ts) ? ts : null;
        }
        case 'state':
          return row.state || '';
        default:
          return null;
      }
    };
    arr.sort((a, b) => {
      const av = getValue(a, instanceSortKey);
      const bv = getValue(b, instanceSortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return instanceSortDir === 'asc' ? 1 : -1;
      if (bv == null) return instanceSortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return instanceSortDir === 'asc' ? av - bv : bv - av;
      }
      return instanceSortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [instancesFiltered, instanceSortKey, instanceSortDir, accountMap]);

  const [isExportingInstances, setIsExportingInstances] = useState(false);
  const handleExportInstancesCsv = useCallback(async () => {
    if (isExportingInstances) return;
    setIsExportingInstances(true);
    try {
      const headers = [
        'Compte',
        'InstanceId',
        'Nom',
        'Type',
        'Plateforme',
        'RI',
        'RI ID',
        'Tarif RI effectif',
        'Horaire',
        'Plages horaire',
        'Jours actifs',
        'AZ',
        'IP privée',
        'IP publique',
        'Lancement',
        'Etat',
        'Region',
        'VPC ID',
      ];

      const rows = instancesSorted.map((row) => {
        const accountId = extractAccountId(row);
        const accountLabel = (accountMap && accountMap.get(accountId)) || accountId || '—';
        const coverage = row.riCoverage || {};
        const currencyCode = coverage.currencyCode || coverage.CurrencyCode || 'USD';
        const effectiveRateLabel = (coverage.effectiveHourlyRate != null && coverage.effectiveHourlyRate !== '')
          ? formatHourlyRate(Number(coverage.effectiveHourlyRate), currencyCode)
          : '';
        const schedule = row.schedule || null;
        const scheduleName = schedule?.name || '';
        const schedulePeriods = Array.isArray(schedule?.periods) ? schedule.periods.filter(Boolean) : [];
        const scheduleRanges = schedulePeriods
          .map((period) => formatSchedulePeriodRange(period))
          .filter(Boolean)
          .join(' | ');
        const activeDaysSet = collectScheduleActiveDays(schedulePeriods);
        const activeDays = SCHEDULE_DAY_DISPLAY
          .filter((day) => activeDaysSet.has(day.key))
          .map((day) => day.label)
          .join(' ');
        const launch = (row.launchTime || row.LaunchTime || '').slice(0, 19).replace('T', ' ');
        return [
          accountLabel,
          row.instanceId || row.InstanceId || row.id || '—',
          extractInstanceName(row) || '—',
          row.instanceType || row.type || '—',
          row.platform || 'Linux/UNIX',
          row.riCovered ? 'Oui' : 'Non',
          coverage.reservedInstancesId || '',
          effectiveRateLabel || '',
          scheduleName || '',
          scheduleRanges || '',
          activeDays || '',
          row.availabilityZone || row.az || '—',
          row.privateIp || '—',
          row.publicIp || '—',
          launch || '—',
          row.state || '—',
          row.region || '—',
          row.vpcId || '—',
        ];
      });

      const escapeCsvValue = (value) => {
        const str = String(value ?? '');
        return /[",\n\r;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const csv = [headers, ...rows]
        .map((line) => line.map(escapeCsvValue).join(';'))
        .join('\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
      const accountSuffix = selectedAccount ? String(selectedAccount).replace(/[^a-z0-9_-]/gi, '_') : 'all-accounts';
      const filename = `ec2-instances-${accountSuffix}-${ts}.csv`;
      const link = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      URL.revokeObjectURL(objectUrl);
      link.remove();
    } catch (err) {
      console.error('EC2 CSV export failed', err);
      window.alert("L'export CSV a échoué. Ouvrez la console pour plus de détails.");
    } finally {
      setIsExportingInstances(false);
    }
  }, [instancesSorted, accountMap, selectedAccount, isExportingInstances]);

  // --- Filtres EBS
  const [vStatus,setVStatus]=useState('');
  const [vType,setVType]=useState('');
  const [vEncrypted,setVEncrypted]=useState('');
  const [vMulti,setVMulti]=useState('');
  const [vMinSize,setVMinSize]=useState('');
  const [vMaxSize,setVMaxSize]=useState('');
  const [vAz,setVAz]=useState('');
  const [vQ,setVQ]=useState('');
  const [volSortKey, setVolSortKey] = useState(null);
  const [volSortDir, setVolSortDir] = useState('asc');

  const handleVolSort = (key) => {
    setVolSortKey((prevKey) => {
      if (prevKey === key) {
        setVolSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      const defaultDir = ['size', 'iops', 'throughput', 'cost'].includes(key) ? 'desc' : 'asc';
      setVolSortDir(defaultDir);
      return key;
    });
  };

  const renderVolSortIndicator = (key) => {
    if (volSortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{volSortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const volsFiltered = useMemo(()=>{
    const needle = vQ.toLowerCase();
    const azNeedle = vAz.toLowerCase();
    return (vols||[]).filter(v=>{
      const accountId = extractAccountId(v);
      if (acc && accountId!==acc) return false;
      if (selectedAccount && accountId!==selectedAccount) return false;
      if (vStatus && String(v.state||'').toLowerCase()!==vStatus) return false;
      if (vType && String(v.type||'').toLowerCase()!==vType) return false;
      if (vEncrypted==='yes' && !v.encrypted) return false;
      if (vEncrypted==='no' && v.encrypted) return false;
      if (vMulti==='yes' && !v.multiAttachEnabled) return false;
      if (vMulti==='no' && v.multiAttachEnabled) return false;
      const size = Number(v.size||v.sizeGiB||0);
      if (vMinSize && size < Number(vMinSize)) return false;
      if (vMaxSize && size > Number(vMaxSize)) return false;
      if (azNeedle){
        const zone = String(v.availabilityZone||v.az||'').toLowerCase();
        if (!zone.includes(azNeedle)) return false;
      }
      if (needle){
        const accName = (accountMap && accountMap.get(accountId)) || accountId || '';
        const attachments = (v.attachments||[]).map(a=>{
          const id = a.instanceId || a.InstanceId || a.id || '';
          const nm = instanceNameMap.get(id) || '';
          return [nm, id].filter(Boolean).join(' ');
        }).join(' ');
        const hay = [v.volumeId, v.name, v.volumeType || v.type, v.state, v.availabilityZone || v.az, v.iops, v.throughput, v.estimatedMonthlyCost, accName, attachments]
          .map(s=>String(s||'').toLowerCase()).join(' ');
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [vols, acc, selectedAccount, vStatus, vType, vEncrypted, vMulti, vMinSize, vMaxSize, vAz, vQ, accountMap, instanceNameMap]);

  const volsSorted = useMemo(() => {
    const arr = volsFiltered.slice();
    if (!volSortKey) return arr;
    const getValue = (row, key) => {
      switch (key) {
        case 'account':
          return (accountMap && accountMap.get(extractAccountId(row))) || extractAccountId(row) || '';
        case 'volumeId':
          return row.volumeId || row.VolumeId || '';
        case 'type':
          return row.volumeType || row.type || '';
        case 'az':
          return row.availabilityZone || row.az || '';
        case 'size': {
          const raw = row.size != null ? row.size : row.sizeGiB;
          const num = Number(raw);
          return Number.isFinite(num) ? num : null;
        }
        case 'iops': {
          const num = Number(row.iops ?? row.Iops);
          return Number.isFinite(num) ? num : null;
        }
        case 'throughput': {
          const num = Number(row.throughput ?? row.Throughput);
          return Number.isFinite(num) ? num : null;
        }
        case 'cost': {
          const num = Number(row.estimatedMonthlyCost ?? row.costMonthly ?? row.ebsCost?.monthly);
          return Number.isFinite(num) ? num : null;
        }
        case 'attached': {
          const attachments = Array.isArray(row.attachments) ? row.attachments : [];
          const labels = attachments.map(a => {
            const id = a.instanceId || a.InstanceId || a.id || '';
            const nm = instanceNameMap.get(id) || '';
            return [nm, id].filter(Boolean).join(' ');
          }).filter(Boolean);
          return labels.join(' ') || '';
        }
        case 'state':
          return row.state || '';
        default:
          return null;
      }
    };
    arr.sort((a, b) => {
      const av = getValue(a, volSortKey);
      const bv = getValue(b, volSortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return volSortDir === 'asc' ? 1 : -1;
      if (bv == null) return volSortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return volSortDir === 'asc' ? av - bv : bv - av;
      }
      return volSortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [volsFiltered, volSortKey, volSortDir, accountMap, instanceNameMap]);

  const regions = useMemo(() => {
    const fromHeader = String(selectedRegionsCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (fromHeader.length) return fromHeader;
    return Array.isArray(regionsEffective) ? regionsEffective : [];
  }, [selectedRegionsCsv, regionsEffective]);

  useEffect(()=>{
    if(!regions.length) return;
    const q='?regions='+regions.join(',');
    fetch('/api/ec2/instances'+q)
      .then(r=>r.json())
      .then(d=>{
        const rows = normalizeRows(d).map(row=>{
          const accountId = extractAccountId(row);
          const name = extractInstanceName(row);
          return {
            ...row,
            ...(accountId ? { accountId } : {}),
            ...(name ? { name } : {}),
          };
        });
        setInstances(rows);
      })
      .catch(()=>setInstances([]));
  },[regions.join(',')]);
  useEffect(()=>{
    if(!regions.length) return;
    const q='?regions='+regions.join(',');
    fetch('/api/ebs/volumes'+q)
      .then(r=>r.json())
      .then(d=>{
        const rows = normalizeRows(d).map(row=>{
          const accountId = extractAccountId(row);
          return {
            ...row,
            ...(accountId ? { accountId } : {}),
          };
        });
        setVols(rows);
      })
      .catch(()=>setVols([]));
  },[regions.join(',')]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="text-base font-semibold">EC2 – Instances</div>
          <TrustBadge type="real">Réel AWS</TrustBadge>
          <TrustBadge type="estimate">Couverture RI/SP locale</TrustBadge>
        </div>
        <div className="flex flex-wrap gap-2 mb-3 items-end">
          <input className="input" placeholder="Recherche (id, nom, ip…)" value={q} onChange={e=>setQ(e.target.value)} />
          <select className="input" value={acc} onChange={e=>setAcc(e.target.value)}>
            <option value="">Compte (tous)</option>
            {Array.from(accountMap ? accountMap.entries() : []).map(([id,name]) => (<option key={id} value={id}>{name || id}</option>))}
          </select>
          <select className="input" value={state} onChange={e=>setState(e.target.value)}>
            <option value="">État</option><option value="running">running</option><option value="stopped">stopped</option><option value="terminated">terminated</option>
          </select>
          <input className="input" placeholder="Famille (ex: m6g, c7g…)" value={family} onChange={e=>setFamily(e.target.value)} />
          <select className="input" value={platform} onChange={e=>setPlatform(e.target.value)}>
            <option value="">Plateforme</option><option value="linux">Linux/UNIX</option><option value="windows">Windows</option>
          </select>
          <select className="input" value={hasPubIp} onChange={e=>setHasPubIp(e.target.value)}>
            <option value="">IP publique ?</option><option value="yes">oui</option><option value="no">non</option>
          </select>
          <input className="input" placeholder="AZ (ex: eu-west-3a)" value={az} onChange={e=>setAz(e.target.value)} />
          <input className="input" placeholder="VPC ID (vpc-...)" value={vpcId} onChange={e=>setVpcId(e.target.value)} />
          <select className="input" value={riStatus} onChange={e=>setRiStatus(e.target.value)}>
            <option value="">RI ?</option>
            <option value="covered">Couvert par RI</option>
            <option value="uncovered">Sans RI</option>
          </select>
          <button
            className="btn btn-sm"
            type="button"
            disabled={isExportingInstances || instancesSorted.length === 0}
            onClick={handleExportInstancesCsv}
            title={instancesSorted.length === 0 ? 'Aucune ligne à exporter' : "Exporter le tableau filtré en CSV"}
          >
            {isExportingInstances ? 'Export…' : `Export CSV (${instancesSorted.length})`}
          </button>
        </div>

        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('account')}>Compte {renderInstanceSortIndicator('account')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('instanceId')}>InstanceId {renderInstanceSortIndicator('instanceId')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('name')}>Nom {renderInstanceSortIndicator('name')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('type')}>Type {renderInstanceSortIndicator('type')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('platform')}>Plateforme {renderInstanceSortIndicator('platform')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('ri')}>RI {renderInstanceSortIndicator('ri')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('schedule')}>Horaire {renderInstanceSortIndicator('schedule')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('az')}>AZ {renderInstanceSortIndicator('az')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('privIp')}>PrivIP {renderInstanceSortIndicator('privIp')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('pubIp')}>PubIP {renderInstanceSortIndicator('pubIp')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('launchTime')}>Lancement {renderInstanceSortIndicator('launchTime')}</th>
              <th className="cursor-pointer" onClick={() => handleInstanceSort('state')}>État {renderInstanceSortIndicator('state')}</th>
            </tr></thead>
            <tbody>
              {instancesSorted.map((x,i)=>{
                const rowAccountId = extractAccountId(x);
                const coverage = x.riCoverage || {};
                const currencyCode = coverage.currencyCode || coverage.CurrencyCode || 'USD';
                const effectiveRateLabel = (coverage.effectiveHourlyRate != null && coverage.effectiveHourlyRate !== '')
                  ? formatHourlyRate(Number(coverage.effectiveHourlyRate), currencyCode)
                  : '';
                const usageRateLabel = (coverage.usagePrice != null && coverage.usagePrice !== '')
                  ? formatHourlyRate(Number(coverage.usagePrice), currencyCode)
                  : '';
                const upfrontLabel = (coverage.fixedPrice != null && coverage.fixedPrice !== '' && Number(coverage.fixedPrice) !== 0)
                  ? formatCurrency(Number(coverage.fixedPrice), currencyCode)
                  : '';
                const durationLabel = formatDurationFromSeconds(coverage.duration ?? coverage.Duration);
                const recurringLabel = formatRecurringChargesTooltip(coverage.recurringCharges, currencyCode);
                const riTitle = x.riCovered
                  ? [
                      coverage.reservedInstancesId ? `RI: ${coverage.reservedInstancesId}` : null,
                      coverage.scope ? `Scope: ${coverage.scope}` : null,
                      coverage.availabilityZone ? `AZ: ${coverage.availabilityZone}` : null,
                      coverage.end ? `Fin: ${String(coverage.end).slice(0,10)}` : null,
                      coverage.offeringClass ? `Classe: ${coverage.offeringClass}` : null,
                      coverage.offeringType ? `Offre: ${coverage.offeringType}` : null,
                      durationLabel ? `Durée: ${durationLabel}` : null,
                      usageRateLabel ? `Tarif usage: ${usageRateLabel}` : null,
                      upfrontLabel ? `Upfront: ${upfrontLabel}` : null,
                      effectiveRateLabel ? `Tarif effectif: ${effectiveRateLabel}` : null,
                      recurringLabel ? `Charges récurrentes:\n${recurringLabel}` : null,
                      coverage.currencyCode ? `Devise: ${coverage.currencyCode}` : null
                    ].filter(Boolean).join('\n')
                  : '';
                const schedule = x.schedule || null;
                const scheduleName = schedule?.name || '';
                const scheduleMissing = !!(schedule && schedule.missing);
                const scheduleAvgActive = Number.isFinite(schedule?.averageDailyHours) ? schedule.averageDailyHours : null;
                const scheduleAvgAllDays = Number.isFinite(schedule?.averageDailyHoursAllDays) ? schedule.averageDailyHoursAllDays : null;
                const scheduleWeeklyHours = Number.isFinite(schedule?.totalWeeklyHours) ? schedule.totalWeeklyHours : null;
                const scheduleTimezone = schedule?.timezone || '';
                const scheduleTitle = buildScheduleTooltip(schedule);
                const scheduleAvgAllDaysLabel = scheduleAvgAllDays != null ? formatHours(scheduleAvgAllDays) : '';
                const scheduleAvgActiveLabel = scheduleAvgActive != null ? formatHours(scheduleAvgActive) : '';
                const scheduleWeeklyLabel = scheduleWeeklyHours != null ? formatHours(scheduleWeeklyHours) : '';
                const schedulePeriods = Array.isArray(schedule?.periods) ? schedule.periods.filter(Boolean) : [];
                const schedulePeriodRanges = schedulePeriods
                  .map((period, idx) => {
                    const label = formatSchedulePeriodRange(period);
                    if (!label) return null;
                    const periodName = period?.name ? String(period.name) : '';
                    return { key: periodName ? `${periodName}-${idx}` : `period-${idx}`, label };
                  })
                  .filter(Boolean);
                const scheduleActiveDays = collectScheduleActiveDays(schedulePeriods);
                return (
                  <tr key={i}>
                    <td>{(accountMap && accountMap.get(rowAccountId)) || rowAccountId || '—'}</td>
                    <td>{x.instanceId||'—'}</td>
                    <td>{extractInstanceName(x) || '—'}</td>
                    <td>{x.instanceType||x.type||'—'}</td>
                    <td>{x.platform||'Linux/UNIX'}</td>
                    <td title={riTitle || undefined}>
                      {x.riCovered
                        ? <span className="inline-flex flex-col text-emerald-600 text-xs font-medium">
                            <span>Oui</span>
                            {x.riCoverage?.reservedInstancesId && <span className="text-[11px] text-emerald-700/80">{x.riCoverage.reservedInstancesId}</span>}
                            {effectiveRateLabel && <span className="text-[11px] text-emerald-700/80">{effectiveRateLabel}</span>}
                            {coverage.offeringType && <span className="text-[10px] uppercase tracking-wide text-emerald-700/70">{coverage.offeringType}</span>}
                          </span>
                        : <span className="muted text-xs">Non</span>}
                    </td>
                    <td title={scheduleTitle || undefined}>
                      {scheduleName
                        ? (
                            <span className="inline-flex flex-col text-xs text-slate-700">
                              <span className="text-sm font-medium text-slate-800">{scheduleName}</span>
                              {scheduleMissing
                                ? <span className="text-[11px] text-rose-600">Introuvable</span>
                                : (
                                  <>
                                    {schedulePeriodRanges.map(period => (
                                      <span key={period.key} className="text-[11px] text-slate-600">{period.label}</span>
                                    ))}
                                    {scheduleActiveDays.size > 0 && (
                                      <span className="mt-0.5 inline-flex text-[11px] font-semibold">
                                        {SCHEDULE_DAY_DISPLAY.map(day => (
                                          <span
                                            key={day.key}
                                            className={`leading-none ${scheduleActiveDays.has(day.key) ? 'text-emerald-600' : 'text-rose-500'}`}
                                          >
                                            {day.label}
                                          </span>
                                        ))}
                                      </span>
                                    )}
                                    {scheduleAvgAllDaysLabel && <span className="text-[11px] text-slate-600">{scheduleAvgAllDaysLabel} h/j (7j)</span>}
                                    {!scheduleAvgAllDaysLabel && scheduleAvgActiveLabel && <span className="text-[11px] text-slate-600">{scheduleAvgActiveLabel} h/j (actif)</span>}
                                    {scheduleWeeklyLabel && <span className="text-[11px] text-slate-500">{scheduleWeeklyLabel} h/sem</span>}
                                    {scheduleTimezone && <span className="text-[10px] uppercase tracking-wide text-slate-400">{scheduleTimezone}</span>}
                                  </>
                              )}
                          </span>
                        )
                        : <span className="muted text-xs">—</span>}
                    </td>
                    <td>{x.availabilityZone||x.az||'—'}</td>
                    <td>{x.privateIp||'—'}</td>
                    <td>{x.publicIp||'—'}</td>
                    <td>{(x.launchTime||'').slice(0,19).replace('T',' ')}</td>
                    <td>{x.state||'—'}</td>
                  </tr>
                );
              })}
              {instances.length===0 && <tr><td colSpan="12" className="text-center muted py-4">Aucune instance (ou droits EC2 insuffisants).</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="text-base font-semibold">EBS – Volumes</div>
          <TrustBadge type="real">Réel AWS</TrustBadge>
          <TrustBadge type="estimate">Coût EBS estimé</TrustBadge>
        </div>
        <div className="flex flex-wrap gap-2 mb-3 items-end">
          <select className="input" value={vStatus} onChange={e=>setVStatus(e.target.value)}>
            <option value="">Statut</option><option value="in-use">in-use</option><option value="available">available</option>
          </select>
          <select className="input" value={vType} onChange={e=>setVType(e.target.value)}>
            <option value="">Type</option><option value="gp3">gp3</option><option value="gp2">gp2</option><option value="io1">io1</option><option value="io2">io2</option><option value="st1">st1</option><option value="sc1">sc1</option>
          </select>
          <select className="input" value={vEncrypted} onChange={e=>setVEncrypted(e.target.value)}>
            <option value="">Chiffré ?</option><option value="yes">oui</option><option value="no">non</option>
          </select>
          <select className="input" value={vMulti} onChange={e=>setVMulti(e.target.value)}>
            <option value="">Multi-attach ?</option><option value="yes">oui</option><option value="no">non</option>
          </select>
          <input className="input w-28" placeholder="Taille min" value={vMinSize} onChange={e=>setVMinSize(e.target.value)} />
          <input className="input w-28" placeholder="Taille max" value={vMaxSize} onChange={e=>setVMaxSize(e.target.value)} />
          <input className="input" placeholder="AZ (ex: eu-west-3a)" value={vAz} onChange={e=>setVAz(e.target.value)} />
          <input className="input flex-1 min-w-[180px]" placeholder="Recherche (ID, nom instance…)" value={vQ}
            onChange={e=>setVQ(e.target.value)} />
        </div>

        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr>
              <th className="cursor-pointer" onClick={() => handleVolSort('account')}>Compte {renderVolSortIndicator('account')}</th>
              <th className="cursor-pointer" onClick={() => handleVolSort('volumeId')}>VolumeId {renderVolSortIndicator('volumeId')}</th>
              <th className="cursor-pointer" onClick={() => handleVolSort('type')}>Type {renderVolSortIndicator('type')}</th>
              <th className="cursor-pointer" onClick={() => handleVolSort('az')}>AZ {renderVolSortIndicator('az')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleVolSort('size')}>Taille (GiB) {renderVolSortIndicator('size')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleVolSort('iops')}>IOPS {renderVolSortIndicator('iops')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleVolSort('throughput')}>Throughput (MB/s) {renderVolSortIndicator('throughput')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleVolSort('cost')}>Coût/mois {renderVolSortIndicator('cost')}</th>
              <th className="cursor-pointer" onClick={() => handleVolSort('attached')}>Attaché à {renderVolSortIndicator('attached')}</th>
              <th className="cursor-pointer" onClick={() => handleVolSort('state')}>État {renderVolSortIndicator('state')}</th>
            </tr></thead>
            <tbody>
              {volsSorted.map((v,i)=>{
                const rowAccountId = extractAccountId(v);
                const attachments = (v.attachments||[]).map(a=>{
                  const id = a.instanceId || a.InstanceId || a.id || '';
                  const nm = instanceNameMap.get(id);
                  if (nm && id) return `${nm} (${id})`;
                  return nm || id || '';
                }).filter(Boolean).join(', ');
                const iopsValue = Number(v.iops ?? v.Iops);
                const throughputValue = Number(v.throughput ?? v.Throughput);
                const costValueRaw = v.estimatedMonthlyCost ?? v.costMonthly ?? v.ebsCost?.monthly;
                const costValue = Number(costValueRaw);
                const costComponents = v.ebsCost?.components || {};
                const costTitle = v.ebsCost
                  ? [
                      `Source: ${v.ebsCost.source || '—'}`,
                      `Stockage: ${formatCurrency(costComponents.storageMonthly || 0)}`,
                      costComponents.iopsMonthly ? `IOPS: ${formatCurrency(costComponents.iopsMonthly)}` : null,
                      costComponents.throughputMonthly ? `Throughput: ${formatCurrency(costComponents.throughputMonthly)}` : null,
                      Array.isArray(v.ebsCost.assumptions) && v.ebsCost.assumptions.length ? v.ebsCost.assumptions.join('\n') : null
                    ].filter(Boolean).join('\n')
                  : undefined;
                return (
                  <tr key={i}>
                    <td>{(accountMap && accountMap.get(rowAccountId)) || rowAccountId || '—'}</td>
                    <td>{v.volumeId||'—'}</td>
                    <td>{v.volumeType||v.type||'—'}</td>
                    <td>{v.availabilityZone||v.az||'—'}</td>
                    <td className="text-right">{v.size||v.sizeGiB||0}</td>
                    <td className="text-right">{Number.isFinite(iopsValue) && iopsValue > 0 ? iopsValue.toLocaleString('fr-FR') : '—'}</td>
                    <td className="text-right">{Number.isFinite(throughputValue) && throughputValue > 0 ? throughputValue.toLocaleString('fr-FR') : '—'}</td>
                    <td className="text-right" title={costTitle}>{Number.isFinite(costValue) ? formatCurrency(costValue) : '—'}</td>
                    <td>{attachments || '—'}</td>
                    <td>{v.state||'—'}</td>
                  </tr>
                );
              })}
              {vols.length===0 && <tr><td colSpan="10" className="text-center muted py-4">Aucun volume (ou droits EC2 insuffisants).</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}



function CalculatorTab({ accountMap, selectedRegionsCsv, regionsEffective, selectedAccount, riMode }){
  const [accountFilter, setAccountFilter] = useState(selectedAccount || '');
  useEffect(() => { setAccountFilter(selectedAccount || ''); }, [selectedAccount]);

  const [regionsFilter, setRegionsFilter] = useState(selectedRegionsCsv || '');
  useEffect(() => { setRegionsFilter(selectedRegionsCsv || ''); }, [selectedRegionsCsv]);

  const [search, setSearch] = useState('');
  const [includeCoverage, setIncludeCoverage] = useState(!!riMode);
  useEffect(() => { setIncludeCoverage(!!riMode); }, [riMode]);

  const [hideNoPrice, setHideNoPrice] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const cacheRef = useRef(new Map());

  const fetchKey = useMemo(() => JSON.stringify({
    account: accountFilter || '',
    regions: regionsFilter || '',
    includeCoverage: includeCoverage ? 1 : 0,
  }), [accountFilter, regionsFilter, includeCoverage]);

  useEffect(() => {
    const key = fetchKey;
    const cached = cacheRef.current.get(key);
    if (cached && Array.isArray(cached.rows)) {
      setRows(cached.rows);
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = {
      regions: regionsFilter || undefined,
      region: regionsFilter || undefined,
      accounts: accountFilter || undefined,
      account: accountFilter || undefined,
      accountId: accountFilter || undefined,
      include_ri: includeCoverage ? '1' : '0',
      includeRi: includeCoverage ? '1' : '0',
      includeRiCoverage: includeCoverage ? '1' : '0',
    };
    getJSON('/api/ec2/cost-estimates', params, { signal: controller.signal })
      .then(data => {
        const arr = normalizeRows(data);
        setRows(arr);
        cacheRef.current.set(key, { rows: arr, ts: Date.now() });
        setLoading(false);
      })
      .catch(err => {
        if (err?.name === 'AbortError') return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [fetchKey, accountFilter, regionsFilter, includeCoverage]);

  const pickNumber = useCallback((values = []) => {
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }, []);

  const parseCoverageBoolean = useCallback((value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
      if (value > 1) return value >= 100;
      if (value < 0) return null;
    }
    const str = String(value).trim().toLowerCase();
    if (!str) return null;
    if (['yes', 'true', '1', 'covered', 'oui'].includes(str)) return true;
    if (['no', 'false', '0', 'non', 'notcovered'].includes(str)) return false;
    return null;
  }, []);

  const processedRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const base = Array.isArray(rows) ? rows : [];
    const out = [];
    base.forEach((row, idx) => {
      const accountId = extractAccountId(row);
      const region = row.region || row.Region || row.location || row.availabilityZone || row.az || '';
      const instanceType = row.instanceType || row.InstanceType || row.type || '';
      const instanceId = row.instanceId || row.InstanceId || row.id || row.resourceId || '';
      const name = extractInstanceName(row);
      const schedule = row.schedule && typeof row.schedule === 'object' ? row.schedule : null;
      const hoursPerDayRaw = pickNumber([
        row.hoursPerDay,
        row.hours_per_day,
        row.dailyHours,
        row.daily_hours,
        schedule?.averageDailyHoursAllDays,
        schedule?.averageDailyHours,
      ]);
      const normalizedHoursPerDay = Number.isFinite(hoursPerDayRaw) && hoursPerDayRaw > 0
        ? hoursPerDayRaw
        : HOURS_PER_DAY;
      const onDemandHourly = pickNumber([
        row.onDemandPricePerHour,
        row.on_demand_price_per_hour,
        row.onDemandHourlyUsd,
        row.on_demand_hourly_usd,
        row.hourlyOnDemandPrice,
        row.ondemandHourly,
        row.ondemand_hourly,
        row.onDemandHourly,
      ]);
      const riHourly = pickNumber([
        row.riPricePerHour,
        row.ri_hourly_usd,
        row.riHourlyUsd,
        row.riEffectiveHourly,
        row.reservedHourlyUsd,
        row.riEffectiveHourlyPrice,
        row.coveredHourlyUsd,
        row.effectiveHourly,
        row.riCoverage?.effectiveHourlyRate,
        row.riCoverage?.effectiveHourlyRateTotal,
      ]);
      let coveragePct = pickNumber([
        row.coveragePct,
        row.coverage_percentage,
        row.coveragePercent,
        row.riCoveragePct,
        row.riCoverage,
        row.coverage,
        row.spCoveragePct
      ]);
      if (coveragePct != null && coveragePct <= 1 && coveragePct >= 0) {
        coveragePct = coveragePct * 100;
      }
      const coverageBool = parseCoverageBoolean(row.riCovered ?? row.covered ?? row.isCovered ?? row.coveredByRi ?? row.hasCoverage);
      const coverageSource = row.coverageSource || (row.riCovered ? 'RI' : null);
      if (coverageSource === 'SP' && (coveragePct == null || !Number.isFinite(coveragePct)) && Number.isFinite(Number(row.spCoveragePct))) {
        coveragePct = Number(row.spCoveragePct);
      }
      let effectiveCoverageBool = coverageBool;
      if (coveragePct != null) {
        effectiveCoverageBool = coveragePct > 0;
      }
      if (coverageSource === 'RI' && effectiveCoverageBool == null) {
        effectiveCoverageBool = true;
      }
      const hasPricing = (onDemandHourly != null && onDemandHourly >= 0) || (riHourly != null && riHourly >= 0);
      const scheduleName = schedule?.name || '';
      const haystack = [instanceId, instanceType, name, region, accountId, scheduleName].join(' ').toLowerCase();
      if (needle && !haystack.includes(needle)) return;
      if (hideNoPrice && !hasPricing) return;

      out.push({
        original: row,
        accountId,
        region,
        instanceType,
        instanceId,
        name,
        onDemandHourly,
        riHourly,
        coveragePct,
        coverageBool: effectiveCoverageBool,
        coverageSource,
        hoursPerDay: normalizedHoursPerDay,
        schedule,
        riCovered: !!row.riCovered,
        key: instanceId || `${accountId || '∅'}|${instanceType || 'type'}|${region || 'region'}|${idx}`,
      });
    });
    return out;
  }, [rows, search, hideNoPrice, pickNumber, parseCoverageBoolean]);

  const [sortKey, setSortKey] = useState('onDemandHourly');
  const [sortDir, setSortDir] = useState('desc');

  const sortedRows = useMemo(() => {
    const arr = processedRows.slice();
    const getValue = (row, key) => {
      const hoursPerDay = Number.isFinite(row.hoursPerDay) && row.hoursPerDay > 0
        ? row.hoursPerDay
        : HOURS_PER_DAY;
      const monthlyFactor = hoursPerDay * (HOURS_PER_MONTH / HOURS_PER_DAY);
      const yearlyFactor = hoursPerDay * (HOURS_PER_YEAR / HOURS_PER_DAY);
      switch (key) {
        case 'instance':
          return row.name || row.instanceId || row.instanceType || '';
        case 'account':
          return row.accountId || '';
        case 'region':
          return row.region || '';
        case 'type':
          return row.instanceType || '';
        case 'hoursPerDay':
          return hoursPerDay;
        case 'coverage':
          if (row.coverageSource === 'RI') return 200;
          if (row.coverageSource === 'SP' && row.coveragePct != null) return 100 + row.coveragePct;
          if (row.coveragePct != null) return row.coveragePct;
          if (row.coverageBool === true) return 1;
          if (row.coverageBool === false) return 0;
          return null;
        case 'onDemandHourly':
          return row.onDemandHourly;
        case 'onDemandDaily':
          return row.onDemandHourly != null ? row.onDemandHourly * hoursPerDay : null;
        case 'onDemandMonthly':
          return row.onDemandHourly != null ? row.onDemandHourly * monthlyFactor : null;
        case 'onDemandYearly':
          return row.onDemandHourly != null ? row.onDemandHourly * yearlyFactor : null;
        case 'riHourly':
          return row.riHourly;
        case 'riDaily':
          return row.riHourly != null ? row.riHourly * hoursPerDay : null;
        case 'riMonthly':
          return row.riHourly != null ? row.riHourly * monthlyFactor : null;
        case 'riYearly':
          return row.riHourly != null ? row.riHourly * yearlyFactor : null;
        default:
          return null;
      }
    };
    arr.sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return sortDir === 'asc' ? 1 : -1;
      if (bv == null) return sortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [processedRows, sortKey, sortDir]);

  const totals = useMemo(() => {
    let ondemandHourly = 0;
    let ondemandDaily = 0;
    let ondemandMonthly = 0;
    let ondemandYearly = 0;
    let riHourly = 0;
    let riDaily = 0;
    let riMonthly = 0;
    let riYearly = 0;
    let savingsHourly = 0;
    let savingsDaily = 0;
    let savingsMonthly = 0;
    let savingsYearly = 0;
    let coverageSum = 0;
    let coverageCount = 0;
    let coveredHourly = 0;
    let coveredDaily = 0;
    let coveredMonthly = 0;
    let uncoveredHourly = 0;
    let uncoveredDaily = 0;
    let uncoveredMonthly = 0;
    let unknownHourly = 0;
    let unknownDaily = 0;
    let unknownMonthly = 0;
    let coveredCount = 0;
    let uncoveredCount = 0;
    let unknownCount = 0;
    let coverageInfoCount = 0;

    processedRows.forEach(row => {
      const onDemandHourly = row.onDemandHourly != null ? Number(row.onDemandHourly) : null;
      let riHourlyValue = row.riHourly != null ? Number(row.riHourly) : null;
      const hoursPerDay = Number.isFinite(row.hoursPerDay) && row.hoursPerDay > 0 ? row.hoursPerDay : HOURS_PER_DAY;
      const dailyFactor = hoursPerDay;
      const monthlyFactor = hoursPerDay * DAYS_PER_MONTH_APPROX;
      const yearlyFactor = hoursPerDay * DAYS_PER_YEAR;

      if (onDemandHourly != null) {
        ondemandHourly += onDemandHourly;
        ondemandDaily += onDemandHourly * dailyFactor;
        ondemandMonthly += onDemandHourly * monthlyFactor;
        ondemandYearly += onDemandHourly * yearlyFactor;
      }

      let coveragePercent = null;
      if (row.coveragePct != null && Number.isFinite(Number(row.coveragePct))) {
        const pct = Math.max(0, Math.min(100, Number(row.coveragePct)));
        coveragePercent = pct;
      } else if (row.coverageBool === true) {
        coveragePercent = 100;
      } else if (row.coverageBool === false) {
        coveragePercent = 0;
      }

      if (riHourlyValue != null && !Number.isFinite(riHourlyValue)) {
        riHourlyValue = null;
      }

      if (riHourlyValue != null) {
        const isZeroLike = Math.abs(riHourlyValue) <= 1e-9;
        if (
          isZeroLike &&
          onDemandHourly != null &&
          (
            (coveragePercent != null && coveragePercent <= 0) ||
            row.coverageBool === false
          )
        ) {
          riHourlyValue = null;
        }
      }

      if (riHourlyValue != null) {
        riHourly += riHourlyValue;
        riDaily += riHourlyValue * dailyFactor;
        riMonthly += riHourlyValue * monthlyFactor;
        riYearly += riHourlyValue * yearlyFactor;
        if (onDemandHourly != null) {
          const hourlySavings = Math.max(0, onDemandHourly - riHourlyValue);
          savingsHourly += hourlySavings;
          savingsDaily += hourlySavings * dailyFactor;
          savingsMonthly += hourlySavings * monthlyFactor;
          savingsYearly += hourlySavings * yearlyFactor;
        }
      } else if (onDemandHourly != null) {
        riHourly += onDemandHourly;
        riDaily += onDemandHourly * dailyFactor;
        riMonthly += onDemandHourly * monthlyFactor;
        riYearly += onDemandHourly * yearlyFactor;
      }

      if (coveragePercent != null) {
        coverageSum += coveragePercent;
        coverageCount += 1;
      }

      const coverageFraction = coveragePercent != null ? Math.max(0, Math.min(1, coveragePercent / 100)) : null;
      const effectiveHourly = riHourlyValue != null
        ? riHourlyValue
        : (onDemandHourly != null ? onDemandHourly : null);

      if (effectiveHourly != null) {
        if (coverageFraction != null) {
          coverageInfoCount += 1;
          const coveredFraction = coverageFraction;
          const uncoveredFraction = Math.max(0, Math.min(1, 1 - coveredFraction));
          let uncoveredPortion = uncoveredFraction;
          // Guard against rounding issues when coverageFraction is slightly above 1.
          if (coveredFraction + uncoveredFraction > 1.000001) {
            const totalFrac = coveredFraction + uncoveredFraction;
            const scale = totalFrac > 0 ? 1 / totalFrac : 1;
            uncoveredPortion *= scale;
          }
          let uncoveredCost = onDemandHourly != null
            ? onDemandHourly * uncoveredPortion
            : effectiveHourly * uncoveredPortion;
          if (!Number.isFinite(uncoveredCost)) uncoveredCost = 0;
          let coveredCost = effectiveHourly - uncoveredCost;
          if (!Number.isFinite(coveredCost)) coveredCost = 0;
          if (coveredCost < 0) {
            uncoveredCost = effectiveHourly;
            coveredCost = 0;
          }
          coveredHourly += coveredCost;
          uncoveredHourly += uncoveredCost;
          coveredDaily += coveredCost * dailyFactor;
          coveredMonthly += coveredCost * monthlyFactor;
          uncoveredDaily += uncoveredCost * dailyFactor;
          uncoveredMonthly += uncoveredCost * monthlyFactor;
          coveredCount += coveredFraction;
          uncoveredCount += uncoveredPortion;
        } else {
          unknownHourly += effectiveHourly;
          unknownDaily += effectiveHourly * dailyFactor;
          unknownMonthly += effectiveHourly * monthlyFactor;
          unknownCount += 1;
        }
      } else {
        if (coverageFraction != null) {
          coverageInfoCount += 1;
          const coveredFraction = coverageFraction;
          const uncoveredFraction = Math.max(0, Math.min(1, 1 - coveredFraction));
          coveredCount += coveredFraction;
          uncoveredCount += uncoveredFraction;
        } else {
          unknownCount += 1;
        }
      }
    });

    const breakdownHourlySum = coveredHourly + uncoveredHourly + unknownHourly;
    const breakdownHourlyDiff = riHourly - breakdownHourlySum;
    const breakdownDailySum = coveredDaily + uncoveredDaily + unknownDaily;
    const breakdownDailyDiff = riDaily - breakdownDailySum;
    const breakdownMonthlySum = coveredMonthly + uncoveredMonthly + unknownMonthly;
    const breakdownMonthlyDiff = riMonthly - breakdownMonthlySum;

    const hasHourlyAdjustment = Math.abs(breakdownHourlyDiff) > 1e-6;
    const hasDailyAdjustment = Math.abs(breakdownDailyDiff) > 1e-4;
    const hasMonthlyAdjustment = Math.abs(breakdownMonthlyDiff) > 1e-4;

    if (hasHourlyAdjustment || hasDailyAdjustment || hasMonthlyAdjustment) {
      if (
        unknownHourly + breakdownHourlyDiff >= 0 &&
        unknownDaily + breakdownDailyDiff >= 0 &&
        unknownMonthly + breakdownMonthlyDiff >= 0
      ) {
        unknownHourly += breakdownHourlyDiff;
        unknownDaily += breakdownDailyDiff;
        unknownMonthly += breakdownMonthlyDiff;
      } else if (
        coveredHourly + breakdownHourlyDiff >= 0 &&
        coveredDaily + breakdownDailyDiff >= 0 &&
        coveredMonthly + breakdownMonthlyDiff >= 0
      ) {
        coveredHourly += breakdownHourlyDiff;
        coveredDaily += breakdownDailyDiff;
        coveredMonthly += breakdownMonthlyDiff;
      } else {
        uncoveredHourly += breakdownHourlyDiff;
        uncoveredDaily += breakdownDailyDiff;
        uncoveredMonthly += breakdownMonthlyDiff;
      }
    }

    return {
      ondemandHourly,
      ondemandDaily,
      ondemandMonthly,
      ondemandYearly,
      riHourly,
      riDaily,
      riMonthly,
      riYearly,
      savingsHourly,
      savingsDaily,
      savingsMonthly,
      savingsYearly,
      avgCoverage: coverageCount ? (coverageSum / coverageCount) : null,
      count: processedRows.length,
      coveredHourly,
      coveredDaily,
      coveredMonthly,
      uncoveredHourly,
      uncoveredDaily,
      uncoveredMonthly,
      unknownHourly,
      unknownDaily,
      unknownMonthly,
      coveredCount,
      uncoveredCount,
      unknownCount,
      hasCoverageDetails: coverageInfoCount > 0,
    };
  }, [processedRows]);

  const accountOptions = useMemo(() => {
    if (accountMap && typeof accountMap.entries === 'function') {
      return Array.from(accountMap.entries()).map(([id, name]) => ({ id, name }));
    }
    return [];
  }, [accountMap]);

  const formatCurrencySafe = (value, options) => {
    if (value == null) return '—';
    return formatCurrency(value, 'USD', options);
  };

  const formatInstanceCount = (value) => {
    if (value == null) return '—';
    const normalized = Math.round(Number(value) * 100) / 100;
    if (!Number.isFinite(normalized)) return '—';
    const diff = Math.abs(Math.round(normalized) - normalized);
    const hasDecimals = diff > 1e-4;
    const options = hasDecimals
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumFractionDigits: 0 };
    return normalized.toLocaleString('fr-FR', options);
  };

  const handleSort = (key) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setSortDir(key === 'instance' || key === 'account' || key === 'region' ? 'asc' : 'desc');
      return key;
    });
  };

  const renderSortIndicator = (key) => {
    if (sortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const badgeClass = (variant) => {
    switch (variant) {
      case 'success':
        return 'bg-emerald-100 text-emerald-700';
      case 'warning':
        return 'bg-amber-100 text-amber-700';
      case 'danger':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-slate-100 text-slate-600';
    }
  };

  const renderCoverageBadge = (row) => {
    const source = String(row.coverageSource || (row.riCovered ? 'RI' : '')).toUpperCase();
    const isRi = source === 'RI';
    const isSp = source === 'SP';
    if (isRi) {
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass('success')}`}>
          Couvert (RI)
        </span>
      );
    }
    if (isSp && row.coveragePct != null && row.coveragePct > 0) {
      const variant = row.coveragePct >= 90 ? 'success' : row.coveragePct >= 50 ? 'warning' : 'danger';
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass(variant)}`}>
          {row.coveragePct.toFixed(1)}% SP
        </span>
      );
    }
    if (row.coverageBool === true) {
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass('success')}`}>
          Couvert
        </span>
      );
    }
    if (row.coverageBool === false || row.coveragePct === 0) {
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass('muted')}`}>
          Non couvert
        </span>
      );
    }
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass('muted')}`}>
        —
      </span>
    );
  };

  const totalsOnDemandMonthly = totals.ondemandMonthly ?? (totals.ondemandHourly * HOURS_PER_MONTH);
  const totalsRiMonthly = totals.riMonthly ?? (totals.riHourly * HOURS_PER_MONTH);
  const totalsSavingsMonthly = totals.savingsMonthly ?? (totals.savingsHourly * HOURS_PER_MONTH);
  const coveredHourly = totals.coveredHourly ?? 0;
  const uncoveredHourly = totals.uncoveredHourly ?? 0;
  const unknownHourly = totals.unknownHourly ?? 0;
  const coveredDaily = totals.coveredDaily ?? (coveredHourly * HOURS_PER_DAY);
  const coveredMonthly = totals.coveredMonthly ?? (coveredHourly * HOURS_PER_MONTH);
  const uncoveredDaily = totals.uncoveredDaily ?? (uncoveredHourly * HOURS_PER_DAY);
  const uncoveredMonthly = totals.uncoveredMonthly ?? (uncoveredHourly * HOURS_PER_MONTH);
  const unknownDaily = totals.unknownDaily ?? (unknownHourly * HOURS_PER_DAY);
  const unknownMonthly = totals.unknownMonthly ?? (unknownHourly * HOURS_PER_MONTH);
  const coveredCount = totals.coveredCount ?? 0;
  const uncoveredCount = totals.uncoveredCount ?? 0;
  const unknownCount = totals.unknownCount ?? 0;
  const showCoverageBreakdown = includeCoverage && totals.hasCoverageDetails;
  const includeUnknownCard = Math.abs(unknownHourly) > 1e-6 || unknownCount > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="text-base font-semibold">Calculateur EC2</div>
          <TrustBadge type="estimate">Estimation locale</TrustBadge>
          <TrustBadge type="real">Tarifs AWS Pricing</TrustBadge>
          {includeCoverage && <TrustBadge type="estimate">Couverture RI/SP estimée</TrustBadge>}
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <div className="flex flex-col gap-1 min-w-[200px]">
            <span className="muted text-xs uppercase tracking-wide">Compte</span>
            <select className="select" value={accountFilter} onChange={e => setAccountFilter(e.target.value)}>
              <option value="">Tous les comptes</option>
              {accountOptions.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.name ? `${opt.name} (${opt.id})` : opt.id}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 min-w-[220px]">
            <span className="muted text-xs uppercase tracking-wide">Régions</span>
            <RegionsPicker value={regionsFilter} onChange={setRegionsFilter} knownRegions={regionsEffective} />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="muted text-xs uppercase tracking-wide">Recherche</span>
            <input className="input" placeholder="Filtrer (nom, type, instance…)" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={includeCoverage} onChange={setIncludeCoverage} label="Inclure couverture RI/SP" />
            <Toggle checked={hideNoPrice} onChange={setHideNoPrice} label="Masquer sans tarif" />
          </div>
        </div>
      </div>

      {error && (
        <div className="card border border-red-200 bg-red-50 text-red-700 p-4">
          <div className="font-semibold mb-1">Erreur lors du chargement</div>
          <div className="text-sm">{error.message || 'Une erreur est survenue.'}</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-sm muted">Total On-Demand (mois)</div>
          <div className="text-2xl font-semibold">{formatCurrencySafe(totalsOnDemandMonthly)}</div>
          <div className="text-xs muted mt-1">{formatCurrencySafe(totals.ondemandHourly, { maximumFractionDigits: 4 })} / h • {formatCurrencySafe(totals.ondemandDaily)} / jour</div>
        </div>
        <div className="card p-4">
          <div className="text-sm muted">Total avec RI/SP (mois)</div>
          <div className="text-2xl font-semibold">{formatCurrencySafe(totalsRiMonthly)}</div>
          <div className="text-xs muted mt-1">{formatCurrencySafe(totals.riHourly, { maximumFractionDigits: 4 })} / h • {formatCurrencySafe(totals.riDaily)} / jour</div>
        </div>
        <div className="card p-4">
          <div className="text-sm muted">Économie potentielle (mois)</div>
          <div className="text-2xl font-semibold text-emerald-700">{formatCurrencySafe(totalsSavingsMonthly)}</div>
          <div className="text-xs muted mt-1">Instances: {totals.count.toLocaleString('fr-FR')} • Couverture moyenne: {totals.avgCoverage != null ? `${totals.avgCoverage.toFixed(1)}%` : '—'}</div>
        </div>
      </div>

      {showCoverageBreakdown && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="card p-4">
            <div className="text-sm muted">Couvert (RI/SP) (mois)</div>
            <div className="text-2xl font-semibold text-emerald-700">{formatCurrencySafe(coveredMonthly)}</div>
            <div className="text-xs muted mt-1">{formatCurrencySafe(coveredHourly, { maximumFractionDigits: 4 })} / h • {formatCurrencySafe(coveredDaily)} / jour</div>
            <div className="text-xs muted mt-1">Instances: {formatInstanceCount(coveredCount)}</div>
          </div>
          <div className="card p-4">
            <div className="text-sm muted">Non couvert (mois)</div>
            <div className="text-2xl font-semibold text-amber-700">{formatCurrencySafe(uncoveredMonthly)}</div>
            <div className="text-xs muted mt-1">{formatCurrencySafe(uncoveredHourly, { maximumFractionDigits: 4 })} / h • {formatCurrencySafe(uncoveredDaily)} / jour</div>
            <div className="text-xs muted mt-1">Instances: {formatInstanceCount(uncoveredCount)}</div>
          </div>
          {includeUnknownCard && (
            <div className="card p-4">
              <div className="text-sm muted">Inconnu (mois)</div>
              <div className="text-2xl font-semibold text-slate-700">{formatCurrencySafe(unknownMonthly)}</div>
              <div className="text-xs muted mt-1">{formatCurrencySafe(unknownHourly, { maximumFractionDigits: 4 })} / h • {formatCurrencySafe(unknownDaily)} / jour</div>
              <div className="text-xs muted mt-1">Instances: {formatInstanceCount(unknownCount)}</div>
            </div>
          )}
        </div>
      )}

      <div className="card p-4">
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead>
            <tr>
              <th className="cursor-pointer" onClick={() => handleSort('instance')}>Instance {renderSortIndicator('instance')}</th>
              <th className="cursor-pointer" onClick={() => handleSort('account')}>Compte {renderSortIndicator('account')}</th>
              <th className="cursor-pointer" onClick={() => handleSort('region')}>Région {renderSortIndicator('region')}</th>
              <th className="cursor-pointer" onClick={() => handleSort('type')}>Type {renderSortIndicator('type')}</th>
              <th className="cursor-pointer" onClick={() => handleSort('coverage')}>Couverture {renderSortIndicator('coverage')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleSort('hoursPerDay')}>Horaire (h/j) {renderSortIndicator('hoursPerDay')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleSort('onDemandHourly')}>Prix On-Demand (h) {renderSortIndicator('onDemandHourly')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleSort('onDemandDaily')}>On-Demand (jour) {renderSortIndicator('onDemandDaily')}</th>
              <th className="cursor-pointer text-right" onClick={() => handleSort('onDemandMonthly')}>On-Demand (mois) {renderSortIndicator('onDemandMonthly')}</th>
                <th className="cursor-pointer text-right" onClick={() => handleSort('onDemandYearly')}>On-Demand (an) {renderSortIndicator('onDemandYearly')}</th>
                <th className="cursor-pointer text-right" onClick={() => handleSort('riHourly')}>Prix avec RI/SP (h) {renderSortIndicator('riHourly')}</th>
                <th className="cursor-pointer text-right" onClick={() => handleSort('riDaily')}>Avec RI/SP (jour) {renderSortIndicator('riDaily')}</th>
                <th className="cursor-pointer text-right" onClick={() => handleSort('riMonthly')}>Avec RI/SP (mois) {renderSortIndicator('riMonthly')}</th>
                <th className="cursor-pointer text-right" onClick={() => handleSort('riYearly')}>Avec RI/SP (an) {renderSortIndicator('riYearly')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, idx) => {
                const accountName = (accountMap && accountMap.get && accountMap.get(row.accountId)) || row.accountId || '—';
                const displayName = row.name || row.instanceId || row.instanceType || '—';
                const subtitleParts = [row.instanceId, row.instanceType].filter(Boolean);
                const schedule = row.schedule && typeof row.schedule === 'object' ? row.schedule : null;
                const scheduleTitle = schedule ? buildScheduleTooltip(schedule) : '';
                const scheduleName = schedule?.name || '';
                const scheduleMissing = !!schedule?.missing;
                const hoursPerDay = Number.isFinite(row.hoursPerDay) && row.hoursPerDay > 0 ? row.hoursPerDay : HOURS_PER_DAY;
                const hoursLabel = formatHours(hoursPerDay);
                const dailyFactor = hoursPerDay;
                const monthlyFactor = hoursPerDay * DAYS_PER_MONTH_APPROX;
                const yearlyFactor = hoursPerDay * DAYS_PER_YEAR;
                const onDemandDaily = row.onDemandHourly != null ? row.onDemandHourly * dailyFactor : null;
                const onDemandMonthly = row.onDemandHourly != null ? row.onDemandHourly * monthlyFactor : null;
                const onDemandYearly = row.onDemandHourly != null ? row.onDemandHourly * yearlyFactor : null;
                const riDaily = row.riHourly != null ? row.riHourly * dailyFactor : null;
                const riMonthly = row.riHourly != null ? row.riHourly * monthlyFactor : null;
                const riYearly = row.riHourly != null ? row.riHourly * yearlyFactor : null;
                return (
              <tr key={row.key || idx}>
                <td>
                  <div className="font-medium">{displayName}</div>
                  {subtitleParts.length > 0 && <div className="text-xs muted">{subtitleParts.join(' · ')}</div>}
                </td>
                <td>{accountName}</td>
                <td>{row.region || '—'}</td>
                <td>{row.instanceType || '—'}</td>
                <td>{renderCoverageBadge(row)}</td>
                <td className="text-right tabular-nums" title={scheduleTitle || undefined}>
                  <div className="flex flex-col items-end leading-tight">
                    <span>{hoursLabel ? `${hoursLabel} h/j` : '—'}</span>
                    {scheduleName && (
                      <span className={`text-[11px] ${scheduleMissing ? 'text-amber-600' : 'text-slate-500'}`}>
                            {scheduleName}{scheduleMissing ? ' (introuvable)' : ''}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(row.onDemandHourly, { maximumFractionDigits: 4 })}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(onDemandDaily)}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(onDemandMonthly)}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(onDemandYearly)}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(row.riHourly, { maximumFractionDigits: 4 })}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(riDaily)}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(riMonthly)}</td>
                    <td className="text-right tabular-nums">{formatCurrencySafe(riYearly)}</td>
                  </tr>
                );
              })}
              {loading && <tr><td colSpan="14" className="text-center py-4 text-sm muted">Chargement…</td></tr>}
              {!loading && sortedRows.length === 0 && (
                <tr><td colSpan="14" className="text-center py-4 text-sm muted">Aucune instance correspondante.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


function VPCTab({ accountMap, selectedRegionsCsv, regionsEffective }){
  const regions = React.useMemo(() => {
    const fromHeader = String(selectedRegionsCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (fromHeader.length) return fromHeader;
    return Array.isArray(regionsEffective) ? regionsEffective : [];
  }, [selectedRegionsCsv, regionsEffective]);

  const [vpcs, setVpcs] = useState([]);
  const [lbs, setLbs] = useState([]);
  const [interfaces, setInterfaces] = useState([]);
  const [q, setQ] = useState('');

  useEffect(()=>{
    if (!regions.length) return;
    const qstr = regions.join(',');
    getJSON('/api/network/vpc-inventory', { regions: qstr }).then(d=>setVpcs(Array.isArray(d.items)?d.items:[])).catch(()=>setVpcs([]));
    getJSON('/api/network/load-balancers', { regions: qstr }).then(d=>setLbs(Array.isArray(d.items)?d.items:[])).catch(()=>setLbs([]));
    getJSON('/api/network/interfaces', { regions: qstr }).then(d=>setInterfaces(Array.isArray(d.items)?d.items:[])).catch(()=>setInterfaces([]));
  }, [regions.join(',')]);

  const accountNameFor = useCallback((accountId) => {
    if (!accountMap) return accountId || '';
    if (typeof accountMap.get === 'function') {
      return accountMap.get(accountId) || accountId || '';
    }
    return accountId || '';
  }, [accountMap]);

  const vpcsFiltered = useMemo(()=>{
    const needle = q.toLowerCase();
    if (!needle) return vpcs;
    return vpcs.filter(v=>{
      const accName = accountNameFor(v.accountId);
      const tagStr = Object.entries(v.tags||{}).map(([k,val])=>`${k}=${val}`).join(' ');
      return [v.vpcId, v.region, accName, v.cidr, tagStr].join(' ').toLowerCase().includes(needle);
    });
  }, [q, vpcs, accountNameFor]);

  const lbsFiltered = useMemo(()=>{
    const needle = q.toLowerCase();
    if (!needle) return lbs;
    return lbs.filter(x=>{
      const accName = accountNameFor(x.accountId);
      return [x.name, x.type, x.vpcId, x.region, accName, x.scheme].join(' ').toLowerCase().includes(needle);
    });
  }, [q, lbs, accountNameFor]);

  const interfacesFiltered = useMemo(()=>{
    const needle = q.toLowerCase();
    if (!needle) return interfaces;
    return interfaces.filter(eni=>{
      const accName = accountNameFor(eni.accountId);
      const priv = (eni.privateIps||[]).map(p=>[p.address, p.publicIp, p.allocationId].join(' ')).join(' ');
      const ipv6 = (eni.ipv6Addresses||[]).join(' ');
      const sgs = (eni.securityGroups||[]).map(g=>[g.id,g.name].join(' ')).join(' ');
      const attach = eni.attachment ? [eni.attachment.instanceId, eni.attachment.ownerId, eni.attachment.status].join(' ') : '';
      const fields = [
        eni.networkInterfaceId,
        eni.vpcId,
        eni.subnetId,
        eni.type,
        eni.status,
        eni.description,
        accName,
        eni.region,
        priv,
        ipv6,
        sgs,
        attach
      ].join(' ').toLowerCase();
      return fields.includes(needle);
    });
  }, [q, interfaces, accountNameFor]);

  const renderSortIndicator = useCallback((currentKey, activeKey, direction) => {
    if (activeKey !== currentKey) {
      return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    }
    return <span className="ml-1 text-[10px] text-slate-500">{direction === 'asc' ? '↑' : '↓'}</span>;
  }, []);

  const toggleSort = useCallback((setter, key, defaultDir = 'asc') => {
    setter((prev) => {
      if (!prev || prev.key !== key) {
        return { key, dir: defaultDir };
      }
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  const [vpcSort, setVpcSort] = useState({ key: 'account', dir: 'asc' });
  const [lbSort, setLbSort] = useState({ key: 'account', dir: 'asc' });
  const [eniSort, setEniSort] = useState({ key: 'account', dir: 'asc' });

  const compareValues = useCallback((av, bv, dir) => {
    const direction = dir === 'desc' ? -1 : 1;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const aNum = typeof av === 'number' ? av : Number.NaN;
    const bNum = typeof bv === 'number' ? bv : Number.NaN;
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      if (aNum === bNum) return 0;
      return direction === 1 ? aNum - bNum : bNum - aNum;
    }
    const aStr = String(av).toLowerCase();
    const bStr = String(bv).toLowerCase();
    if (aStr === bStr) return 0;
    return direction === 1
      ? aStr.localeCompare(bStr, undefined, { numeric: true, sensitivity: 'base' })
      : bStr.localeCompare(aStr, undefined, { numeric: true, sensitivity: 'base' });
  }, []);

  const sortedVpcs = useMemo(() => {
    const arr = vpcsFiltered.slice();
    const { key, dir } = vpcSort;
    const getValue = (item) => {
      switch (key) {
        case 'account':
          return accountNameFor(item.accountId);
        case 'region':
          return item.region;
        case 'vpc':
          return item.vpcId;
        case 'cidr':
          return item.cidr;
        case 'default':
          return item.isDefault ? 1 : 0;
        case 'subnets':
          return Number(item.subnetsCount || 0);
        case 'nat':
          return Number(item.natCount || 0);
        case 'endpoints':
          return `${Number(item.endpoints?.interface || 0)}-${Number(item.endpoints?.gateway || 0)}`;
        case 'igw':
          return item.igwAttached ? 1 : 0;
        case 'eip':
          return Number(item.eipCount || 0);
        case 'nacl':
          return Number(item.naclCount || 0);
        case 'flowLogs':
          return item.flowLogsEnabled ? 1 : 0;
        case 'tags':
          return Object.entries(item.tags || {}).map(([k, val]) => `${k}=${val}`).join(' ');
        default:
          return null;
      }
    };
    arr.sort((a, b) => compareValues(getValue(a), getValue(b), dir));
    return arr;
  }, [vpcsFiltered, vpcSort, compareValues, accountNameFor]);

  const sortedLbs = useMemo(() => {
    const arr = lbsFiltered.slice();
    const { key, dir } = lbSort;
    const getValue = (item) => {
      switch (key) {
        case 'account':
          return accountNameFor(item.accountId);
        case 'region':
          return item.region;
        case 'name':
          return item.name;
        case 'type':
          return item.type;
        case 'scheme':
          return item.scheme;
        case 'vpc':
          return item.vpcId;
        case 'az':
          return Number(item.azCount || 0);
        case 'state':
          return item.state;
        default:
          return null;
      }
    };
    arr.sort((a, b) => compareValues(getValue(a), getValue(b), dir));
    return arr;
  }, [lbsFiltered, lbSort, compareValues, accountNameFor]);

  const sortedEnis = useMemo(() => {
    const arr = interfacesFiltered.slice();
    const { key, dir } = eniSort;
    const getValue = (item) => {
      switch (key) {
        case 'account':
          return accountNameFor(item.accountId);
        case 'region':
          return item.region;
        case 'interface':
          return item.networkInterfaceId;
        case 'type':
          return item.type;
        case 'state':
          return item.status;
        case 'vpc':
          return item.vpcId;
        case 'subnet':
          return item.subnetId;
        case 'private':
          return (item.privateIps || []).map(p => p.address || '').join(', ');
        case 'public':
          return (item.privateIps || []).map(p => p.publicIp || '').filter(Boolean).join(', ');
        case 'ipv6':
          return (item.ipv6Addresses || []).join(', ');
        case 'attached':
          if (item.attachment && item.attachment.instanceId) {
            return `${item.attachment.instanceId} ${item.attachment.status || ''}`.trim();
          }
          if (item.attachment && item.attachment.ownerId) return item.attachment.ownerId;
          return '';
        case 'sg':
          return (item.securityGroups || []).map(g => g.name || g.id || '').join(', ');
        case 'description':
          return item.description || '';
        default:
          return null;
      }
    };
    arr.sort((a, b) => compareValues(getValue(a), getValue(b), dir));
    return arr;
  }, [interfacesFiltered, eniSort, compareValues, accountNameFor]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex items-center gap-3">
        <input className="input" placeholder="Filtrer (VPC, région, tags, LB…)" value={q} onChange={e=>setQ(e.target.value)} />
        <div className="muted text-sm">Régions: {regions.join(', ')||'—'}</div>
      </div>

      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="text-base font-semibold">Inventaire VPC</div>
          <TrustBadge type="real">Réel AWS</TrustBadge>
        </div>
        <div className="overflow-auto">
          <table className="table table-wrap w-full text-sm">
            <thead><tr>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'account')}>Compte {renderSortIndicator('account', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'region')}>Région {renderSortIndicator('region', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'vpc')}>VPC {renderSortIndicator('vpc', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'cidr')}>CIDR {renderSortIndicator('cidr', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'default')}>Default {renderSortIndicator('default', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'subnets', 'desc')}>#Subnets {renderSortIndicator('subnets', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'nat', 'desc')}>NAT {renderSortIndicator('nat', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'endpoints', 'desc')}>Endpoints (I/G) {renderSortIndicator('endpoints', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'igw', 'desc')}>IGW {renderSortIndicator('igw', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'eip', 'desc')}>#EIP {renderSortIndicator('eip', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'nacl', 'desc')}>#NACL {renderSortIndicator('nacl', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'flowLogs', 'desc')}>Flow Logs {renderSortIndicator('flowLogs', vpcSort.key, vpcSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setVpcSort, 'tags')}>Tags {renderSortIndicator('tags', vpcSort.key, vpcSort.dir)}</th>
            </tr></thead>
            <tbody>
              {sortedVpcs.map((v,i)=>{
                const accName = accountNameFor(v.accountId) || '—';
                const tagStr = Object.entries(v.tags||{}).slice(0,4).map(([k,val])=>`${k}=${val}`).join(', ');
                return (<tr key={v.vpcId || i}>
                  <td>{accName}</td><td>{v.region}</td><td>{v.vpcId}</td><td>{v.cidr||'—'}</td>
                  <td>{v.isDefault?'oui':'non'}</td>
                  <td className="text-right">{v.subnetsCount||0}</td>
                  <td className="text-right">{v.natCount||0}</td>
                  <td className="text-right">{(v.endpoints&&v.endpoints.interface)||0}/{(v.endpoints&&v.endpoints.gateway)||0}</td>
                  <td>{v.igwAttached?'oui':'non'}</td><td className="text-right">{v.eipCount||0}</td><td className="text-right">{v.naclCount||0}</td>
                  <td>{v.flowLogsEnabled?'ON':'OFF'}</td>
                  <td className="max-w-[240px] whitespace-pre-wrap break-words">{tagStr||'—'}</td>
                </tr>);
              })}
              {sortedVpcs.length===0 && <tr><td colSpan="13" className="text-center muted py-4">Aucun VPC trouvé (ou droits EC2 insuffisants).</td></tr>}
          </tbody>
        </table>
      </div>
    </div>

      <div className="card p-4">
        <div className="text-base font-semibold mb-2">Load Balancers (ALB / NLB / GWLB)</div>
        <div className="overflow-auto">
          <table className="table table-wrap w-full text-sm">
            <thead><tr>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'account')}>Compte {renderSortIndicator('account', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'region')}>Région {renderSortIndicator('region', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'name')}>Nom {renderSortIndicator('name', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'type')}>Type {renderSortIndicator('type', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'scheme')}>Schéma {renderSortIndicator('scheme', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'vpc')}>VPC {renderSortIndicator('vpc', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'az', 'desc')}>AZ {renderSortIndicator('az', lbSort.key, lbSort.dir)}</th>
              <th className="cursor-pointer select-none" onClick={() => toggleSort(setLbSort, 'state')}>État {renderSortIndicator('state', lbSort.key, lbSort.dir)}</th>
            </tr></thead>
            <tbody>
              {sortedLbs.map((x,i)=>{
                const accName = accountNameFor(x.accountId) || '—';
                return (<tr key={x.arn || x.name || i}>
                  <td>{accName}</td><td>{x.region}</td><td className="max-w-[220px] whitespace-pre-wrap break-words">{x.name}</td><td>{x.type}</td>
                  <td>{x.scheme||'—'}</td><td>{x.vpcId||'—'}</td><td className="text-right">{x.azCount||0}</td><td>{x.state||'—'}</td>
                </tr>);
              })}
              {sortedLbs.length===0 && <tr><td colSpan="8" className="text-center muted py-4">Aucun load balancer trouvé (ou droits insuffisants).</td></tr>}
            </tbody>
          </table>
      </div>
    </div>

      <div className="card p-4">
        <div className="text-base font-semibold mb-2">Interfaces réseau &amp; adresses IP</div>
        <div className="overflow-auto">
          <table className="table table-wrap w-full text-sm">
            <thead>
              <tr>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'account')}>Compte {renderSortIndicator('account', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'region')}>Région {renderSortIndicator('region', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'interface')}>Interface {renderSortIndicator('interface', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'type')}>Type {renderSortIndicator('type', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'state')}>État {renderSortIndicator('state', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'vpc')}>VPC {renderSortIndicator('vpc', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'subnet')}>Subnet {renderSortIndicator('subnet', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'private')}>Privées {renderSortIndicator('private', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'public')}>Publiques {renderSortIndicator('public', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'ipv6')}>IPv6 {renderSortIndicator('ipv6', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'attached')}>Attaché à {renderSortIndicator('attached', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'sg')}>SG {renderSortIndicator('sg', eniSort.key, eniSort.dir)}</th>
                <th className="cursor-pointer select-none" onClick={() => toggleSort(setEniSort, 'description')}>Description {renderSortIndicator('description', eniSort.key, eniSort.dir)}</th>
              </tr>
            </thead>
            <tbody>
              {sortedEnis.map((eni,i)=>{
                const accName = accountNameFor(eni.accountId) || '—';
                const priv = (eni.privateIps||[]).map(p=>{
                  const suffix = p.primary ? ' *' : '';
                  return (p.address||'') + suffix;
                }).filter(Boolean).join(', ');
                const pub = (eni.privateIps||[]).map(p=>p.publicIp).filter(Boolean).join(', ');
                const ipv6 = (eni.ipv6Addresses||[]).join(', ');
                const attach = eni.attachment && eni.attachment.instanceId
                  ? `${eni.attachment.instanceId}${eni.attachment.status ? ` (${eni.attachment.status})` : ''}`
                  : (eni.attachment && eni.attachment.ownerId) ? eni.attachment.ownerId : '—';
                const sgs = (eni.securityGroups||[]).map(g=>g.name||g.id).filter(Boolean).join(', ');
                return (
                  <tr key={eni.networkInterfaceId || i}>
                    <td>{accName}</td>
                    <td>{eni.region}</td>
                    <td className="whitespace-nowrap">{eni.networkInterfaceId}</td>
                    <td>{eni.type||'—'}</td>
                    <td>{eni.status||'—'}</td>
                    <td>{eni.vpcId||'—'}</td>
                    <td>{eni.subnetId||'—'}</td>
                    <td className="max-w-[220px] whitespace-pre-wrap break-words" title={priv}>{priv||'—'}</td>
                    <td className="max-w-[180px] whitespace-pre-wrap break-words" title={pub}>{pub||'—'}</td>
                    <td className="max-w-[180px] whitespace-pre-wrap break-words" title={ipv6}>{ipv6||'—'}</td>
                    <td className="max-w-[200px] whitespace-pre-wrap break-words" title={attach}>{attach||'—'}</td>
                    <td className="max-w-[200px] whitespace-pre-wrap break-words" title={sgs}>{sgs||'—'}</td>
                    <td className="max-w-[220px] whitespace-pre-wrap break-words" title={eni.description||''}>{eni.description||'—'}</td>
                  </tr>
                );
              })}
              {sortedEnis.length===0 && <tr><td colSpan="13" className="text-center muted py-4">Aucune interface réseau trouvée (ou droits insuffisants).</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NetworkUsageBadge({ state, label }) {
  const value = String(state || 'unknown').toLowerCase();
  const type = value === 'idle' ? 'warn' : value === 'low' ? 'estimate' : value === 'active' ? 'real' : 'cache';
  const fallback = value === 'idle' ? 'Nul/quasi nul' : value === 'low' ? 'Faible' : value === 'active' ? 'Actif' : 'À qualifier';
  return <TrustBadge type={type}>{label || fallback}</TrustBadge>;
}

function NetworkTrafficTooltip({ active, payload, label, name = 'Trafic' }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const point = payload.find(entry => entry && entry.dataKey === 'gb') || payload[0];
  const value = Number(point?.value || 0);
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
      <div className="font-medium text-slate-900">{label}</div>
      <div className="text-slate-700">{name}: {value.toLocaleString('fr-FR')} GB</div>
    </div>
  );
}

function NetworkFinOpsDrawer({ item, accountMap, onClose }) {
  const [selectedMetricDay, setSelectedMetricDay] = useState(null);
  useEffect(() => {
    setSelectedMetricDay(null);
  }, [item?.accountId, item?.region, item?.resourceId]);
  const series = useMemo(() => {
    return Array.isArray(item?.metricSeries)
      ? item.metricSeries.map(point => ({ ...point, gb: Number(point.gb || 0) }))
      : [];
  }, [item?.metricSeries]);
  if (!item) return null;
  const accountLabel = accountMap?.get(item.accountId) || item.accountId || '—';
  const hasSeries = series.length > 0;
  const selectedMetric = (selectedMetricDay && series.find(point => point.date === selectedMetricDay))
    || series[series.length - 1]
    || null;
  const datapoints = Number(item.metricDatapoints || 0);
  const datapointsLabel = item.resourceType === 'public_ipv4'
    ? 'Non applicable'
    : `${datapoints.toLocaleString('fr-FR')} point(s)`;
  const metricDimensionsLabel = Array.isArray(item.metricDimensions) && item.metricDimensions.length
    ? item.metricDimensions.map(dim => dim?.Name).filter(Boolean).join(', ')
    : '—';
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-5xl overflow-auto border-l border-slate-200 bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-slate-900">{item.label || item.resourceId}</div>
            <div className="text-sm muted">{item.typeLabel} · {accountLabel} · {item.region || '—'} · {item.vpcId || 'sans VPC'}</div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>Fermer</button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <InsightKpi label="Coût mensuel" value={formatCurrency(item.monthlyCost || 0)} detail="Estimation locale" tone="blue" />
            <InsightKpi label="Fixe mensuel" value={formatCurrency(item.fixedMonthlyCost || 0)} detail="Ressource provisionnée" tone="slate" />
            <InsightKpi label="Trafic mesuré" value={item.metricGb == null ? '—' : `${Number(item.metricGb || 0).toLocaleString('fr-FR')} GB`} detail={datapointsLabel} tone={item.usageState === 'idle' ? 'amber' : item.usageState === 'active' ? 'green' : 'slate'} />
            <InsightKpi label="Économie" value={formatCurrency(item.potentialMonthlySavings || 0)} detail={item.usageState === 'active' ? 'Aucune action' : 'Hypothèse à valider'} tone={Number(item.potentialMonthlySavings || 0) > 0 ? 'green' : 'slate'} />
          </div>

          <div className="card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-base font-semibold">Usage réseau</div>
                <div className="text-sm muted">{item.recommendation}</div>
              </div>
              <NetworkUsageBadge state={item.usageState} label={item.usageLabel} />
            </div>
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-4">
              <div><span className="font-semibold">Preuve:</span> {item.usageEvidence || '—'}</div>
              <div><span className="font-semibold">Datapoints:</span> {datapointsLabel}</div>
              <div><span className="font-semibold">Dimension CW:</span> {metricDimensionsLabel}</div>
              <div><span className="font-semibold">Erreur métrique:</span> {item.metricError || '—'}</div>
            </div>
            {selectedMetric && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-cyan-100 bg-cyan-50 px-3 py-2 text-sm text-cyan-950">
                <span className="font-semibold">Jour sélectionné:</span>
                <span>{selectedMetric.date}</span>
                <span className="font-semibold">{Number(selectedMetric.gb || 0).toLocaleString('fr-FR')} GB</span>
              </div>
            )}
            <div className="h-80">
              {hasSeries ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={series}
                    margin={{ top: 8, right: 20, bottom: 6, left: 8 }}
                    onClick={(chart) => {
                      const point = chart?.activePayload?.[0]?.payload;
                      if (point?.date) setSelectedMetricDay(point.date);
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={18} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => `${Number(value || 0).toFixed(1)} GB`} />
                    <Tooltip content={<NetworkTrafficTooltip name="Trafic" />} />
                    <Legend />
                    <Bar dataKey="gb" name="GB / jour" fill="#bae6fd" radius={[3, 3, 0, 0]} />
                    <Area type="monotone" dataKey="gb" name="Tendance" stroke="#0e7490" fill="#cffafe" fillOpacity={0.25} activeDot={{ r: 6 }} />
                    <Line type="monotone" dataKey="gb" name="Trafic" stroke="#164e63" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 6 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm muted">
                  Aucune métrique CloudWatch exploitable sur la période.
                </div>
              )}
            </div>
            {hasSeries && (
              <div className="mt-4 overflow-auto rounded-lg border border-slate-200">
                <table className="table w-full text-sm">
                  <thead><tr><th>Jour</th><th className="text-right">GB observés</th></tr></thead>
                  <tbody>
                    {series.map(point => {
                      const active = selectedMetric?.date === point.date;
                      return (
                        <tr
                          key={point.date}
                          className={`cursor-pointer hover:bg-slate-50 ${active ? 'bg-cyan-50' : ''}`}
                          onClick={() => setSelectedMetricDay(point.date)}
                        >
                          <td className={active ? 'font-semibold text-cyan-950' : ''}>{point.date}</td>
                          <td className={`text-right tabular-nums ${active ? 'font-semibold text-cyan-950' : ''}`}>{Number(point.gb || 0).toLocaleString('fr-FR')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="card p-4">
              <div className="mb-2 text-sm font-semibold">Ressource</div>
              <table className="table w-full text-sm">
                <tbody>
                  <tr><td>Type</td><td>{item.typeLabel || '—'}</td></tr>
                  <tr><td>Compte</td><td>{accountLabel}</td></tr>
                  <tr><td>Région</td><td>{item.region || '—'}</td></tr>
                  <tr><td>VPC</td><td>{item.vpcId || '—'}</td></tr>
                  <tr><td>État</td><td>{item.state || '—'}</td></tr>
                  <tr><td>Signal</td><td>{item.usageLabel || '—'}</td></tr>
                  <tr><td>ID</td><td className="break-all">{item.resourceId || '—'}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="card p-4">
              <div className="mb-2 text-sm font-semibold">Coût</div>
              <table className="table w-full text-sm">
                <tbody>
                  <tr><td>Fixe mensuel</td><td className="text-right">{formatCurrency(item.fixedMonthlyCost || 0)}</td></tr>
                  <tr><td>Data processing</td><td className="text-right">{formatCurrency(item.dataMonthlyCost || 0)}</td></tr>
                  <tr><td>Total mensuel</td><td className="text-right font-semibold">{formatCurrency(item.monthlyCost || 0)}</td></tr>
                  <tr><td>Économie potentielle</td><td className="text-right font-semibold">{formatCurrency(item.potentialMonthlySavings || 0)}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NetworkFinOpsGroupDrawer({ group, items, accountMap, onClose, onSelectItem }) {
  const [selectedMetricDay, setSelectedMetricDay] = useState(null);
  useEffect(() => {
    setSelectedMetricDay(null);
  }, [group?.kind, group?.key]);
  const accountNameFor = (accountId) => accountMap?.get(accountId) || accountId || '—';
  const groupItems = useMemo(() => {
    if (!group) return [];
    return (Array.isArray(items) ? items : []).filter(item => (
      group.kind === 'account'
        ? item.accountId === group.key
        : item.resourceType === group.key
    ));
  }, [group?.kind, group?.key, items]);
  const groupSeries = useMemo(() => {
    const byDay = new Map();
    for (const item of groupItems) {
      const itemSeries = Array.isArray(item.metricSeries) ? item.metricSeries : [];
      for (const point of itemSeries) {
        if (!point?.date) continue;
        byDay.set(point.date, (byDay.get(point.date) || 0) + Number(point.gb || 0));
      }
    }
    return Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, gb]) => ({ date, gb: Math.round(gb * 1000) / 1000 }));
  }, [groupItems]);
  const selectedMetric = (selectedMetricDay && groupSeries.find(point => point.date === selectedMetricDay))
    || groupSeries[groupSeries.length - 1]
    || null;
  if (!group) return null;
  const title = group.label || group.key || '—';
  const groupLabel = group.kind === 'account' ? 'Compte' : 'Type';
  const monthlyCost = groupItems.reduce((sum, item) => sum + Number(item.monthlyCost || 0), 0);
  const potentialMonthlySavings = groupItems.reduce((sum, item) => sum + Number(item.potentialMonthlySavings || 0), 0);
  const measuredItems = groupItems.filter(item => item.metricGb != null);
  const totalMetricGb = measuredItems.reduce((sum, item) => sum + Number(item.metricGb || 0), 0);
  const usageCounts = groupItems.reduce((acc, item) => {
    const key = item.usageState || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const breakdownMap = new Map();
  for (const item of groupItems) {
    const key = group.kind === 'account' ? (item.resourceType || 'unknown') : (item.accountId || 'unknown');
    const label = group.kind === 'account'
      ? (item.typeLabel || item.resourceType || '—')
      : accountNameFor(item.accountId);
    const row = breakdownMap.get(key) || { key, label, resources: 0, monthlyCost: 0, potentialMonthlySavings: 0 };
    row.resources += 1;
    row.monthlyCost += Number(item.monthlyCost || 0);
    row.potentialMonthlySavings += Number(item.potentialMonthlySavings || 0);
    breakdownMap.set(key, row);
  }
  const breakdown = Array.from(breakdownMap.values()).sort((a, b) => b.monthlyCost - a.monthlyCost);
  const sortedItems = groupItems.slice().sort((a, b) => Number(b.monthlyCost || 0) - Number(a.monthlyCost || 0));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-5xl overflow-auto border-l border-slate-200 bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-slate-900">{title}</div>
            <div className="text-sm muted">{groupLabel} · {groupItems.length.toLocaleString('fr-FR')} ressource(s)</div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>Fermer</button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <InsightKpi label="Coût mensuel" value={formatCurrency(monthlyCost)} detail="Somme des ressources" tone="blue" />
            <InsightKpi label="Économie" value={formatCurrency(potentialMonthlySavings)} detail="Hypothèse à valider" tone={potentialMonthlySavings > 0 ? 'green' : 'slate'} />
            <InsightKpi label="Trafic mesuré" value={measuredItems.length ? `${totalMetricGb.toLocaleString('fr-FR')} GB` : '—'} detail={`${measuredItems.length}/${groupItems.length} avec métriques`} tone="slate" />
            <InsightKpi label="À qualifier" value={Number(usageCounts.unknown || 0).toLocaleString('fr-FR')} detail="Métriques absentes/droits" tone={usageCounts.unknown ? 'amber' : 'slate'} />
          </div>

          <div className="card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-base font-semibold">Usage réseau agrégé</div>
                <div className="text-sm muted">Somme GB/jour des ressources {group.kind === 'account' ? 'du compte' : 'du type'} avec métriques CloudWatch.</div>
              </div>
              <TrustBadge type="cache">{groupSeries.length} jour(s)</TrustBadge>
            </div>
            {selectedMetric && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-cyan-100 bg-cyan-50 px-3 py-2 text-sm text-cyan-950">
                <span className="font-semibold">Jour sélectionné:</span>
                <span>{selectedMetric.date}</span>
                <span className="font-semibold">{Number(selectedMetric.gb || 0).toLocaleString('fr-FR')} GB</span>
              </div>
            )}
            <div className="h-80">
              {groupSeries.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={groupSeries}
                    margin={{ top: 8, right: 20, bottom: 6, left: 8 }}
                    onClick={(chart) => {
                      const point = chart?.activePayload?.[0]?.payload;
                      if (point?.date) setSelectedMetricDay(point.date);
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={18} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => `${Number(value || 0).toFixed(1)} GB`} />
                    <Tooltip content={<NetworkTrafficTooltip name="Trafic agrégé" />} />
                    <Legend />
                    <Bar dataKey="gb" name="GB / jour" fill="#bae6fd" radius={[3, 3, 0, 0]} />
                    <Area type="monotone" dataKey="gb" name="Tendance" stroke="#0e7490" fill="#cffafe" fillOpacity={0.25} activeDot={{ r: 6 }} />
                    <Line type="monotone" dataKey="gb" name="Trafic" stroke="#164e63" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 6 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm muted">
                  Aucune série CloudWatch exploitable pour ce regroupement.
                </div>
              )}
            </div>
            {groupSeries.length > 0 && (
              <div className="mt-4 overflow-auto rounded-lg border border-slate-200">
                <table className="table w-full text-sm">
                  <thead><tr><th>Jour</th><th className="text-right">GB agrégés</th></tr></thead>
                  <tbody>
                    {groupSeries.map(point => {
                      const active = selectedMetric?.date === point.date;
                      return (
                        <tr
                          key={point.date}
                          className={`cursor-pointer hover:bg-slate-50 ${active ? 'bg-cyan-50' : ''}`}
                          onClick={() => setSelectedMetricDay(point.date)}
                        >
                          <td className={active ? 'font-semibold text-cyan-950' : ''}>{point.date}</td>
                          <td className={`text-right tabular-nums ${active ? 'font-semibold text-cyan-950' : ''}`}>{Number(point.gb || 0).toLocaleString('fr-FR')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card p-4">
            <div className="mb-2 text-sm font-semibold text-slate-800">
              {group.kind === 'account' ? 'Coût par type' : 'Coût par compte'}
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={breakdown.slice(0, 12)} layout="vertical" margin={{ left: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tickFormatter={(value) => `$${Number(value || 0).toFixed(0)}`} />
                  <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value) => formatCurrency(value)} />
                  <Bar dataKey="monthlyCost" name="Coût mensuel" fill="#0e7490" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="card p-4">
              <div className="mb-2 text-sm font-semibold">Répartition</div>
              <div className="overflow-auto">
                <table className="table w-full text-sm">
                  <thead><tr><th>{group.kind === 'account' ? 'Type' : 'Compte'}</th><th className="text-right">Ressources</th><th className="text-right">Coût/mois</th><th className="text-right">Économie</th></tr></thead>
                  <tbody>
                    {breakdown.map(row => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td className="text-right">{Number(row.resources || 0).toLocaleString('fr-FR')}</td>
                        <td className="text-right">{formatCurrency(row.monthlyCost || 0)}</td>
                        <td className="text-right">{formatCurrency(row.potentialMonthlySavings || 0)}</td>
                      </tr>
                    ))}
                    {!breakdown.length && <tr><td colSpan="4" className="py-4 text-center muted">Aucune donnée.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card p-4">
              <div className="mb-2 text-sm font-semibold">Signaux</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border border-slate-200 p-3"><div className="muted text-xs">Actif</div><div className="text-lg font-semibold">{Number(usageCounts.active || 0).toLocaleString('fr-FR')}</div></div>
                <div className="rounded-lg border border-slate-200 p-3"><div className="muted text-xs">Faible</div><div className="text-lg font-semibold">{Number(usageCounts.low || 0).toLocaleString('fr-FR')}</div></div>
                <div className="rounded-lg border border-slate-200 p-3"><div className="muted text-xs">Nul/quasi nul</div><div className="text-lg font-semibold">{Number(usageCounts.idle || 0).toLocaleString('fr-FR')}</div></div>
                <div className="rounded-lg border border-slate-200 p-3"><div className="muted text-xs">À qualifier</div><div className="text-lg font-semibold">{Number(usageCounts.unknown || 0).toLocaleString('fr-FR')}</div></div>
              </div>
            </div>
          </div>

          <div className="card p-4">
            <div className="mb-2 text-sm font-semibold">Ressources</div>
            <div className="overflow-auto">
              <table className="table w-full text-sm">
                <thead><tr><th>Ressource</th><th>Compte</th><th>Région</th><th>Signal</th><th className="text-right">GB</th><th className="text-right">Coût/mois</th><th className="text-right">Économie</th></tr></thead>
                <tbody>
                  {sortedItems.map(item => (
                    <tr key={`${item.resourceType}-${item.accountId}-${item.region}-${item.resourceId}`} className="cursor-pointer hover:bg-slate-50" onClick={() => onSelectItem?.(item)}>
                      <td>
                        <div className="font-medium text-slate-900">{item.label || item.resourceId}</div>
                        <div className="text-[11px] muted">{item.typeLabel} · {item.vpcId || 'sans VPC'}</div>
                      </td>
                      <td>{accountNameFor(item.accountId)}</td>
                      <td>{item.region || '—'}</td>
                      <td><NetworkUsageBadge state={item.usageState} label={item.usageLabel} /></td>
                      <td className="text-right">{item.metricGb == null ? '—' : Number(item.metricGb || 0).toLocaleString('fr-FR')}</td>
                      <td className="text-right font-semibold">{formatCurrency(item.monthlyCost || 0)}</td>
                      <td className="text-right text-emerald-700">{formatCurrency(item.potentialMonthlySavings || 0)}</td>
                    </tr>
                  ))}
                  {!sortedItems.length && <tr><td colSpan="7" className="py-4 text-center muted">Aucune ressource.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NetworkFinOpsTab({ accountMap, selectedRegionsCsv, regionsEffective, selectedAccount, start, end }) {
  const regions = useMemo(() => {
    const fromHeader = String(selectedRegionsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
    if (fromHeader.length) return fromHeader;
    return Array.isArray(regionsEffective) ? regionsEffective : [];
  }, [selectedRegionsCsv, regionsEffective]);
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [usageFilter, setUsageFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [isExportingXlsx, setIsExportingXlsx] = useState(false);

  useEffect(() => {
    if (!regions.length) return;
    let cancelled = false;
    const params = Object.fromEntries(buildRangeSearchParams(start, end, {
      regions: regions.join(','),
      accounts: selectedAccount || '',
      days: 30
    }));
    setState(prev => ({ ...prev, loading: true, error: null }));
    getJSON('/api/network/finops', params)
      .then(data => {
        if (!cancelled) setState({ loading: false, error: null, data });
      })
      .catch(error => {
        if (!cancelled) setState({ loading: false, error, data: null });
      });
    return () => { cancelled = true; };
  }, [regions.join(','), selectedAccount, start, end]);

  const summary = state.data?.summary || {};
  const items = Array.isArray(state.data?.items) ? state.data.items : [];
  const byAccount = Array.isArray(summary.byAccount) ? summary.byAccount : [];
  const byType = Array.isArray(summary.byType) ? summary.byType : [];
  const typeOptions = Array.from(new Set(items.map(item => item.resourceType).filter(Boolean))).sort();
  const accountNameFor = useCallback((accountId) => accountMap?.get(accountId) || accountId || '—', [accountMap]);
  const accountChartData = useMemo(() => byAccount.slice(0, 10).map(row => ({ ...row, label: accountNameFor(row.accountId) })), [byAccount, accountNameFor]);

  const filteredItems = useMemo(() => {
    const needle = q.toLowerCase();
    return items.filter(item => {
      if (typeFilter && item.resourceType !== typeFilter) return false;
      if (usageFilter && item.usageState !== usageFilter) return false;
      if (needle) {
        const hay = [
          item.resourceId,
          item.label,
          item.typeLabel,
          item.accountId,
          accountNameFor(item.accountId),
          item.region,
          item.vpcId,
          item.state,
          item.usageLabel,
          item.recommendation
        ].join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, q, typeFilter, usageFilter, accountNameFor]);

  const severityClass = (severity) => {
    if (severity === 'high') return 'text-rose-700';
    if (severity === 'medium') return 'text-amber-700';
    return 'text-slate-700';
  };

  const openAccountGroup = useCallback((row) => {
    if (!row?.accountId) return;
    setSelected(null);
    setSelectedGroup({ kind: 'account', key: row.accountId, label: row.label || accountNameFor(row.accountId) });
  }, [accountNameFor]);

  const openTypeGroup = useCallback((row) => {
    if (!row?.resourceType) return;
    setSelected(null);
    setSelectedGroup({ kind: 'type', key: row.resourceType, label: row.typeLabel || row.resourceType });
  }, []);

  const handleSelectGroupItem = useCallback((item) => {
    setSelectedGroup(null);
    setSelected(item);
  }, []);

  const handleExportActionsXlsx = useCallback(() => {
    if (isExportingXlsx || filteredItems.length === 0) return;
    setIsExportingXlsx(true);
    try {
      const headers = [
        'Priorite',
        'Ressource',
        'ResourceId',
        'Type',
        'Compte',
        'AccountId',
        'Region',
        'VPC',
        'Etat AWS',
        'Signal',
        'Preuve',
        'Datapoints CloudWatch',
        'Dimensions CloudWatch',
        'Erreur metrique',
        'GB observes',
        'Cout/mois USD',
        'Fixe/mois USD',
        'Data processing/mois USD',
        'Economie potentielle USD',
        'Recommandation',
        'Debut periode',
        'Fin periode'
      ];
      const severityLabel = (severity) => severity === 'high' ? 'Haute' : severity === 'medium' ? 'Moyenne' : 'Info';
      const asNumber = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : '';
      };
      const rows = filteredItems.map(item => [
        severityLabel(item.severity),
        item.label || item.resourceId || '',
        item.resourceId || '',
        item.typeLabel || item.resourceType || '',
        accountNameFor(item.accountId),
        item.accountId || '',
        item.region || '',
        item.vpcId || '',
        item.state || '',
        item.usageLabel || item.usageState || '',
        item.usageEvidence || '',
        item.resourceType === 'public_ipv4' ? 'Non applicable' : asNumber(item.metricDatapoints),
        Array.isArray(item.metricDimensions) ? item.metricDimensions.map(dim => dim?.Name).filter(Boolean).join(', ') : '',
        item.metricError || '',
        asNumber(item.metricGb),
        asNumber(item.monthlyCost),
        asNumber(item.fixedMonthlyCost),
        asNumber(item.dataMonthlyCost),
        asNumber(item.potentialMonthlySavings),
        item.recommendation || '',
        state.data?.window?.start || start || '',
        state.data?.window?.end || end || ''
      ]);
      const blob = createXlsxBlob('Actions Network FinOps', [headers, ...rows]);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
      const accountSuffix = selectedAccount ? String(selectedAccount).replace(/[^a-z0-9_-]/gi, '_') : 'all-accounts';
      downloadBlob(blob, `network-finops-actions-${accountSuffix}-${ts}.xlsx`);
    } catch (err) {
      console.error('Network FinOps XLSX export failed', err);
      window.alert("L'export XLSX a échoué. Ouvrez la console pour plus de détails.");
    } finally {
      setIsExportingXlsx(false);
    }
  }, [accountNameFor, end, filteredItems, isExportingXlsx, selectedAccount, start, state.data?.window?.end, state.data?.window?.start]);

  return (
    <div className="grid grid-cols-1 gap-5">
      {state.loading && <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm muted">Chargement Network FinOps...</div>}
      {state.error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Erreur Network FinOps: {state.error.message || 'appel API impossible'}</div>}

      <div className="flex flex-wrap gap-2">
        <TrustBadge type="real">AWS live</TrustBadge>
        <TrustBadge type="estimate">Estimation locale</TrustBadge>
        <TrustBadge type="cache">CloudWatch si disponible</TrustBadge>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
        <InsightKpi label="Coût réseau" value={formatCurrency(summary.totalMonthlyCost || 0)} detail="Mensuel estimé" tone="blue" />
        <InsightKpi label="Économie potentielle" value={formatCurrency(summary.potentialMonthlySavings || 0)} detail="Trafic nul/faible à valider" tone={Number(summary.potentialMonthlySavings || 0) ? 'green' : 'slate'} />
        <InsightKpi label="Ressources" value={Number(summary.resources || 0).toLocaleString('fr-FR')} detail={regions.join(', ') || 'Régions'} tone="slate" />
        <InsightKpi label="Nul/quasi nul" value={Number(summary.idleResources || 0).toLocaleString('fr-FR')} detail="Datapoints présents, pas suppression auto" tone={Number(summary.idleResources || 0) ? 'amber' : 'green'} />
        <InsightKpi label="À qualifier" value={Number(summary.unknownUsage || 0).toLocaleString('fr-FR')} detail="Métriques absentes ou droits insuffisants" tone={Number(summary.unknownUsage || 0) ? 'amber' : 'slate'} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold text-slate-800">Coût par compte</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={accountChartData}
                layout="vertical"
                margin={{ left: 32 }}
                onClick={(chart) => openAccountGroup(chart?.activePayload?.[0]?.payload)}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(value) => `$${Number(value || 0).toFixed(0)}`} />
                <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => formatCurrency(value)} />
                <Bar dataKey="monthlyCost" name="Coût mensuel" fill="#0e7490" cursor="pointer" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold text-slate-800">Coût par type</div>
          <div className="overflow-auto">
            <table className="table w-full text-sm">
              <thead><tr><th>Type</th><th className="text-right">Ressources</th><th className="text-right">Coût/mois</th><th className="text-right">Économie</th></tr></thead>
              <tbody>
                {byType.map(row => (
                  <tr
                    key={row.resourceType}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => openTypeGroup(row)}
                    title="Afficher le détail de ce type"
                  >
                    <td className="font-medium text-slate-900">{row.typeLabel}</td>
                    <td className="text-right">{Number(row.resources || 0).toLocaleString('fr-FR')}</td>
                    <td className="text-right">{formatCurrency(row.monthlyCost || 0)}</td>
                    <td className="text-right">{formatCurrency(row.potentialMonthlySavings || 0)}</td>
                  </tr>
                ))}
                {!byType.length && <tr><td colSpan="4" className="py-4 text-center muted">Aucune ressource réseau.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Actions Network FinOps</div>
            <div className="text-sm muted">Ressources payantes classées par signal CloudWatch observé, à valider avant toute suppression</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-sm"
              type="button"
              disabled={isExportingXlsx || filteredItems.length === 0}
              onClick={handleExportActionsXlsx}
              title={filteredItems.length === 0 ? 'Aucune ligne à exporter' : 'Exporter les lignes filtrées en XLSX'}
            >
              {isExportingXlsx ? 'Export...' : `Export XLSX (${filteredItems.length})`}
            </button>
            <TrustBadge type="estimate">{filteredItems.length} ligne(s)</TrustBadge>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input flex-1 min-w-[220px]" placeholder="Recherche (compte, VPC, ressource...)" value={q} onChange={e => setQ(e.target.value)} />
          <select className="input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">Type</option>
            {typeOptions.map(type => <option key={type} value={type}>{items.find(item => item.resourceType === type)?.typeLabel || type}</option>)}
          </select>
          <select className="input" value={usageFilter} onChange={e => setUsageFilter(e.target.value)}>
            <option value="">Signal</option>
            <option value="idle">Nul/quasi nul / IP libre</option>
            <option value="low">Faible</option>
            <option value="unknown">À qualifier</option>
            <option value="active">Actif</option>
          </select>
        </div>
        <div className="overflow-auto">
          <table className="table w-full text-sm">
            <thead><tr><th>Priorité</th><th>Ressource</th><th>Compte</th><th>Région</th><th>Signal</th><th className="text-right">GB</th><th className="text-right">Coût/mois</th><th className="text-right">Économie</th></tr></thead>
            <tbody>
              {filteredItems.map(item => (
                <tr key={`${item.resourceType}-${item.accountId}-${item.region}-${item.resourceId}`} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelected(item)}>
                  <td className={severityClass(item.severity)}>{item.severity === 'high' ? 'Haute' : item.severity === 'medium' ? 'Moyenne' : 'Info'}</td>
                  <td>
                    <div className="font-medium text-slate-900">{item.label || item.resourceId}</div>
                    <div className="text-[11px] muted">{item.typeLabel} · {item.vpcId || 'sans VPC'}</div>
                    <div className="mt-1 max-w-xl text-xs text-slate-600">{item.recommendation}</div>
                  </td>
                  <td>{accountNameFor(item.accountId)}</td>
                  <td>{item.region || '—'}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <NetworkUsageBadge state={item.usageState} label={item.usageLabel} />
                      {item.usageEvidence && <span className="text-[11px] text-slate-500">{item.usageEvidence}</span>}
                    </div>
                  </td>
                  <td className="text-right">{item.metricGb == null ? '—' : Number(item.metricGb || 0).toLocaleString('fr-FR')}</td>
                  <td className="text-right font-semibold">{formatCurrency(item.monthlyCost || 0)}</td>
                  <td className="text-right text-emerald-700">{formatCurrency(item.potentialMonthlySavings || 0)}</td>
                </tr>
              ))}
              {!filteredItems.length && <tr><td colSpan="8" className="py-4 text-center muted">Aucune action Network FinOps sur les filtres.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <NetworkFinOpsGroupDrawer
        group={selectedGroup}
        items={items}
        accountMap={accountMap}
        onClose={() => setSelectedGroup(null)}
        onSelectItem={handleSelectGroupItem}
      />
      <NetworkFinOpsDrawer item={selected} accountMap={accountMap} onClose={() => setSelected(null)} />
    </div>
  );
}

function formatBytesDecimal(bytes, opts={}) {
  const abs = Math.abs(bytes||0);
  const units = ["B","KB","MB","GB","TB","PB"];
  const base = 1000;
  if (abs < 1) return { value: 0, unit: "B", text: "0 B" };
  let u = 0, v = abs;
  while (v >= base && u < units.length-1) { v = v / base; u++; }
  const dec = v >= 100 ? 0 : (v >= 10 ? 1 : 2);
  const fixed = (opts.decimals!=null ? opts.decimals : dec);
  const rounded = Number(v.toFixed(fixed));
  const text = `${rounded}${opts.spaced ? " " : ""}${units[u]}`;
  return { value: rounded, unit: units[u], text, raw: bytes };
}

const S3_FRIENDLY = {
  "StandardStorage": "Standard",
  "StandardIAStorage": "Standard IA",
  "StandardIAObjectOverhead": "Standard IA (overhead objets)",
  "StandardIASizeOverhead": "Standard IA (overhead taille)",
  "OneZoneIAStorage": "One Zone IA",
  "OneZoneIASizeOverhead": "One Zone IA (overhead taille)",
  "ReducedRedundancyStorage": "RRS (legacy)",
  "GlacierInstantRetrievalStorage": "Glacier Instant Retrieval",
  "GlacierIRSizeOverhead": "Glacier IR (overhead taille)",
  "GlacierStorage": "Glacier (Flexible Retrieval)",
  "GlacierStagingStorage": "Glacier (Staging)",
  "GlacierObjectOverhead": "Glacier (overhead objets)",
  "GlacierS3ObjectOverhead": "Glacier (overhead S3 objets)",
  "DeepArchiveStorage": "Glacier Deep Archive",
  "DeepArchiveStagingStorage": "Deep Archive (Staging)",
  "DeepArchiveObjectOverhead": "Deep Archive (overhead objets)",
  "GlacierDeepArchiveStorage": "Glacier Deep Archive",
  "DeepArchiveS3ObjectOverhead": "Deep Archive (overhead S3 objets)",
  "IntelligentTieringFAStorage": "Intelligent Tiering (Frequent)",
  "IntelligentTieringIAStorage": "Intelligent Tiering (Infrequent)",
  "IntelligentTieringAAStorage": "Intelligent Tiering (Archive)",
  "IntelligentTieringAIAStorage": "Intelligent Tiering (Archive IR)",
  "IntelligentTieringDAAStorage": "Intelligent Tiering (Deep Archive)",
  "ExpressOneZoneStorage": "S3 Express One Zone"
};

function TinyAreaChart({ data, height=120 }){
  if (!Array.isArray(data) || data.length===0) return <div className="muted text-sm">Aucune donnée</div>;
  const yFmt = (v)=> formatBytesDecimal(v,{spaced:true}).text;
  return (
    <div style={{ width:'100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data}>
          <XAxis dataKey="t" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v)=> formatBytesDecimal(v).text.split(' ')[0]} />
          <Tooltip formatter={(v)=> yFmt(v)} labelFormatter={(l)=> l}/>
          <Area type="monotone" dataKey="bytes" fillOpacity={0.15} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}


function BucketDetail({ bucket, region, totalBytes, cacheKey, tsCache, showOverhead }){
  const data = tsCache && tsCache.get ? tsCache.get(cacheKey) : null;
  const series = data && Array.isArray(data.series) ? data.series : [];
  const seriesByClass = (data && data.seriesByClass) ? data.seriesByClass : {};
  const classes = data && data.classes ? data.classes : {};
  const objects = data && data.objects ? data.objects : null;
  const rows = Object.entries(classes).filter(([k,v])=> (showOverhead || !/Overhead|Staging/i.test(k))).sort((a,b)=> b[1]-a[1]);

  // Pricing
  const pricing = usePricing(region);
  function computeCosts(){
    if (!pricing || !pricing.prices) return null;
    const days = (Array.isArray(series) ? series.length : 0);
    if (!days) return null;
    const denom = 30.44; // GB-month conversion from GB-days
    const out = [];
    let total = 0;
    for (const [k,arr] of Object.entries(seriesByClass||{})){
      if (!arr || !arr.length) continue;
      if (!showOverhead && /Overhead|Staging/i.test(k)) continue;
      const price = pricing.prices[k];
      if (!price) continue;
      // Σ bytes_j / 1e9 -> GB-days
      let gbDays = 0;
      for (const p of arr){
        gbDays += (p.bytes || 0) / 1e9;
      }
      const gbMonth = gbDays / denom;
      const cost = gbMonth * Number(price);
      total += cost;
      out.push({ k, gbMonth, price: Number(price), cost });
    }
    return { rows: out.sort((a,b)=>b.cost-a.cost), total, currency: pricing.currency||'USD' };
  }
  const cost = computeCosts();

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3">
      <div className="md:col-span-2">
        <div className="text-xs muted mb-1">Taille au fil du temps</div>
        <TinyAreaChart data={series} />
      </div>
      <div className="md:col-span-1 space-y-3">
        <div>
          <div className="text-xs muted mb-1">Détail par classe (point le plus récent)</div>
          <table className="table w-full text-xs">
            <thead>
              <tr><th>Classe</th><th className="text-right">Taille</th><th className="text-right">Objets*</th></tr>
            </thead>
            <tbody>
              {rows.map(([k,v])=>{
                const size = formatBytesDecimal(v,{spaced:true}).text;
                return <tr key={k}><td>{S3_FRIENDLY[k]||k}</td><td className="text-right tabular-nums">{size}</td><td className="text-right">—</td></tr>;
              })}
              {rows.length===0 && <tr><td colSpan="3" className="text-center muted py-2">—</td></tr>}
            </tbody>
          </table>
          <div className="text-[11px] muted mt-1">
            * CloudWatch ne fournit pas le nombre d’objets par classe. Total objets (bucket) : {objects!=null ? objects.toLocaleString('fr-FR') : '—'}.
          </div>
        </div>

        <div>
          <div className="text-xs muted mb-1">Coûts estimés (stockage seul)</div>
          {!pricing && <div className="text-xs muted">Chargement des prix…</div>}
          {pricing && (!pricing.prices || Object.keys(pricing.prices).length===0) && (
            <div className="text-xs muted">Tarifs introuvables pour cette région/classe (vérifie <code>pricing:GetProducts</code> et la région).</div>
          )}
          {pricing && cost && (
            <table className="table w-full text-xs">
              <thead><tr><th>Classe</th><th className="text-right">GB‑mois</th><th className="text-right">Prix</th><th className="text-right">Coût</th></tr></thead>
              <tbody>
                {cost.rows.map(r => (
                  <tr key={r.k}>
                    <td>{S3_FRIENDLY[r.k]||r.k}</td>
                    <td className="text-right">{r.gbMonth.toFixed(2)}</td>
                    <td className="text-right">{r.price.toFixed(4)} {cost.currency}/GB‑mo</td>
                    <td className="text-right">{r.cost.toFixed(2)} {cost.currency}</td>
                  </tr>
                ))}
                {cost.rows.length===0 && <tr><td colSpan="4" className="text-center muted py-2">—</td></tr>}
                {cost.rows.length>0 && (
                  <tr>
                    <td colSpan="3" className="text-right font-medium">Total</td>
                    <td className="text-right font-medium">{cost.total.toFixed(2)} {cost.currency}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <div className="text-[11px] muted mt-1">
            NB : estimation basée sur GB‑jours convertis en GB‑mois (÷30,44) × prix <em>$/GB‑mois</em>. N’inclut pas requêtes, retrievals ni early‑delete.
          </div>
        </div>
      </div>
    </div>
  );
}
function S3ClassBar({ classes, total, showOverhead=false }){
  const palette = [
    "#0ea5e9", "#22c55e", "#f59e0b", "#6366f1", "#ef4444", "#14b8a6",
    "#a855f7", "#06b6d4", "#84cc16", "#f97316", "#64748b"
  ];
  const entriesAll = Object.entries(classes || {}).filter(([k,v])=>v>0);
  const entries = entriesAll.filter(([k])=> showOverhead || (!/Overhead|Staging/i.test(k)));
  if (entries.length === 0) return <span className="muted text-xs">—</span>;
  const tot = total && total>0 ? total : entries.reduce((s, [,v])=>s+v,0);
  const sorted = entries.sort((a,b)=>b[1]-a[1]);
  const top = sorted.slice(0,6);
  const rest = sorted.slice(6);
  const restBytes = rest.reduce((s, [,v])=>s+v,0);
  const pct = v => (v>0 && tot>0) ? (v/tot*100) : 0;

  return (
    <div className="space-y-1">
      <div className="h-2.5 rounded bg-slate-100 overflow-hidden">
        {top.map(([k,v],i)=>(
          <div key={k}
               className="h-2.5 float-left"
               style={{ width: pct(v)+'%', backgroundColor: palette[i % palette.length] }}
               title={(S3_FRIENDLY[k]||k)+ " · " + formatBytesDecimal(v,{spaced:true}).text + " · " + pct(v).toFixed(1) + "%"} />
        ))}
        {restBytes>0 && (
          <div className="h-2.5 float-left"
               style={{ width: pct(restBytes)+'%', backgroundColor: "#cbd5e1" }}
               title={"Autres ("+rest.length+" classes) · "+formatBytesDecimal(restBytes,{spaced:true}).text+" · "+pct(restBytes).toFixed(1)+"%"} />
        )}
        <div className="clear-both"></div>
      </div>
      <div className="text-[11px] leading-4 text-slate-600 truncate">
        {top.map(([k,v],i)=> (i? " · ":"") + (S3_FRIENDLY[k]||k) + " " + pct(v).toFixed(0) + "%")}
        {restBytes>0 ? " · +" + rest.length + " autres" : ""}
      </div>
    </div>
  );
}

// Ancienne présentation en puces (conservée si besoin)
function S3ClassChips({ classes }){
  const entries = Object.entries(classes||{}).filter(([k,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,8);
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([k,v])=>{
        const { text } = formatBytesDecimal(v, { spaced:true });
        return <span key={k} className="inline-flex items-center text-xs px-2 py-1 rounded-full border border-slate-200">
          <span className="muted">{S3_FRIENDLY[k]||k}</span>
          <span className="mx-1">·</span>
          <span className="font-medium">{text}</span>
        </span>;
      })}
      {entries.length===0 && <span className="muted text-xs">—</span>}
    </div>
  );
}


function S3Tab({ accountMap, selectedRegionsCsv, regionsEffective, start, end }){
  const regions = React.useMemo(() => {
    const fromHeader = String(selectedRegionsCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (fromHeader.length) return fromHeader;
    return Array.isArray(regionsEffective) ? regionsEffective : [];
  }, [selectedRegionsCsv, regionsEffective]);
  const regionKey = useMemo(() => regions.join(','), [regions]);

  const [rows, setRows] = useState([]);
  const [rowsMeta, setRowsMeta] = useState(() => emptyS3ListMeta());
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [q, setQ] = useState('');
  const [minSize, setMinSize] = useState('');
  const [maxSize, setMaxSize] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [showOverhead, setShowOverhead] = useState(false);
  const [dense, setDense] = useState(false);
  const [expanded, setExpanded] = useState(()=> new Set());
  const [tsCache, setTsCache] = useState(()=> new Map());
  const [costCache, setCostCache] = useState(()=> new Map());
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const fetchBuckets = useCallback((options = {}) => {
    const { forceRefresh = false, forceLive = false } = options;
    if (!regions.length) {
      setRows([]);
      setRowsMeta(emptyS3ListMeta());
      setLoadingBuckets(false);
      return Promise.resolve(null);
    }
    const params = { regions: regionKey };
    if (forceRefresh) params.fresh = '1';
    if (forceLive) params.live = '1';
    setLoadingBuckets(true);
    return getJSON('/api/s3/buckets', params, {
      cacheTtlMs: forceRefresh ? 0 : S3_LIST_CACHE_TTL_MS,
      bypassCache: forceRefresh
    }).then(d => {
      const items = Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
      setRows(items);
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const fallbackAsOf = items.reduce((max, row) => {
          const day = row && row.snapshotDay ? String(row.snapshotDay) : null;
          if (!day) return max;
          return (!max || day > max) ? day : max;
        }, null);
        setRowsMeta({
          cached: !!d.cached,
          source: d.source || (d.cached ? 'db' : 'live'),
          asOf: d.asOf || fallbackAsOf || null,
          fetchedAt: d.fetchedAt || d.retrievedAt || null
        });
      } else {
        setRowsMeta({
          cached: false,
          source: Array.isArray(d) ? 'live' : null,
          asOf: null,
          fetchedAt: null
        });
      }
    }).catch(err => {
      console.error(err);
      setRows(prev => Array.isArray(prev) ? prev : []);
      setRowsMeta(prev => prev || emptyS3ListMeta());
    }).finally(() => {
      setLoadingBuckets(false);
    });
  }, [regionKey, regions]);

  const handleRefreshClick = useCallback(() => {
    fetchBuckets({ forceRefresh: true });
  }, [fetchBuckets]);

  const rowsMetaBadge = useMemo(() => {
    if (!rowsMeta) return '';
    const parts = [];
    if (rowsMeta.source === 'db') {
      parts.push('Instantané (base)');
      if (rowsMeta.asOf) parts.push(rowsMeta.asOf);
    } else if (rowsMeta.source === 'live') {
      parts.push('Données live AWS');
      if (rowsMeta.fetchedAt) {
        const dt = new Date(rowsMeta.fetchedAt);
        if (!Number.isNaN(dt.getTime())) parts.push(dt.toLocaleString());
      }
    }
    if (!parts.length) return rowsMeta.cached ? 'Cache' : '';
    if (rowsMeta.cached) parts.push('cache');
    return parts.join(' · ');
  }, [rowsMeta]);

  // Cache pricing tables per region for table-level cost estimates
  const [pricingMap, setPricingMap] = useState(()=> new Map());
  useEffect(()=>{
    const regs = Array.from(new Set((rows||[]).map(r => r && r.region).filter(Boolean)));
    const missing = regs.filter(reg => !pricingMap.has(reg));
    if (missing.length === 0) return;
    (async ()=>{
      const entries = await Promise.all(missing.map(async reg => {
        try { const tbl = await getJSON('/api/s3/pricing', { region: reg }); return [reg, tbl]; }
        catch { return [reg, null]; }
      }));
      setPricingMap(prev => {
        const m = new Map(prev);
        for (const [reg, tbl] of entries) { if (!m.has(reg)) m.set(reg, tbl); }
        return m;
      });
    })();
  }, [rows, pricingMap]);
 // any of keys
  // any of keys

  
  // Refresh opened rows when period changes
  useEffect(()=>{ // refresh expanded on period change
    if (!expanded || expanded.size===0) return;
    expanded.forEach(keyBR => {
      const [bucket, region] = keyBR.split("|");
      const fullKey = bucket+"|"+(region||"")+"|"+start+"|"+end;
      if (!tsCache.has(fullKey)){
        const url = '/api/s3/bucket-ts-cached';
        getJSON(url, { bucket, region, start, end, cached: 1 }).then(d=>{
          const normalized = normalizeBucketTimeseriesPayload(d);
          setTsCache(prev=>{ const m=new Map(prev); m.set(fullKey, normalized); return m; });
        }).catch(()=>{});
      }
    });
  }, [start, end, expanded]);
  useEffect(()=>{
    fetchBuckets();
  }, [fetchBuckets]);

  const filtered = useMemo(()=>{
    const needle = q.toLowerCase().trim();
    const min = Number(minSize) || 0;
    const max = Number(maxSize) || 0;
    return rows.filter(r=>{
      if (needle){
        const accName = (accountMap && accountMap.get(r.accountId)) || r.accountId || '';
        const tagStr = Object.entries(r.tags||{}).map(([k,v])=>`${k}=${v}`).join(' ');
        const s = [r.bucket, r.region, accName, tagStr].join(' ').toLowerCase();
        if (!s.includes(needle)) return false;
      }
      const szGB = (r.totalBytes || 0) / 1e9;
      if (min && szGB < min) return false;
      if (max && szGB > max) return false;
      if (classFilter){
        const v = r.classes ? Number(r.classes[classFilter] || 0) : 0;
        const total = Number(r.totalBytes || 0) || Object.values(r.classes||{}).reduce((s,x)=> s + Number(x||0), 0);
        const pct = total ? (v / total) * 100 : 0;
        if (pct < 1) return false; // require >=1% presence for the selected class
      }
      if (regions.length && r.region && !regions.includes(r.region)) return false;
      return true;
    });
  }, [rows, q, minSize, maxSize, classFilter, regions, accountMap]);

  const totalAll = useMemo(()=>{
    const bytes = filtered.reduce((s,r)=> s + (r.totalBytes||0), 0);
    const objs = filtered.reduce((s,r)=> s + (r.objects||0), 0);
    return { bytes, objs };
  }, [filtered]);

  const computeRowPriceUSD = useCallback((row) => {
    if (!pricingMap || typeof pricingMap.get !== 'function') return null;
    const prTbl = pricingMap.get ? pricingMap.get(row.region) : null;
    if (!prTbl || !prTbl.prices) return null;
    const BYTES_PER_TB_DEC = 1e12;
    let sum = 0;
    for (const [cls, bytes] of Object.entries(row.classes||{})){
      const per = Number(prTbl.prices[cls] || 0);
      const gb_bin = (Number(bytes||0) / BYTES_PER_TB_DEC) * 1024;
      sum += gb_bin * per;
    }
    return sum;
  }, [pricingMap]);

  const totalPriceUSD = useMemo(()=>{
    let sum = 0;
    for (const r of filtered){
      const price = computeRowPriceUSD(r);
      if (Number.isFinite(price)) sum += price;
    }
    return sum;
  }, [filtered, computeRowPriceUSD]);


  const classOptions = useMemo(()=>{
    const ks = new Set();
    for (const r of rows){ for (const k of Object.keys(r.classes||{})) ks.add(k); }
    return Array.from(ks).sort();
  }, [rows]);

  const handleSort = useCallback((key) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      const defaultDir = (key === 'objects' || key === 'size' || key === 'price') ? 'desc' : 'asc';
      setSortDir(defaultDir);
      return key;
    });
  }, []);

  const renderSortIndicator = useCallback((key) => {
    if (sortKey !== key) return <span className="ml-1 text-[10px] text-slate-400">↕</span>;
    return <span className="ml-1 text-[10px] text-slate-500">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }, [sortKey, sortDir]);

  const sortedRows = useMemo(() => {
    const arr = filtered.slice();
    if (!sortKey) return arr;
    const getValue = (row, key) => {
      switch (key) {
        case 'bucket':
          return row.bucket || '';
        case 'account':
          return (accountMap && accountMap.get(row.accountId)) || row.accountId || '';
        case 'region':
          return row.region || '';
        case 'objects':
          return Number(row.objects || 0);
        case 'size':
          return Number(row.totalBytes || 0);
        case 'price':
          return computeRowPriceUSD(row);
        default:
          return null;
      }
    };
    arr.sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return sortDir === 'asc' ? 1 : -1;
      if (bv == null) return sortDir === 'asc' ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [filtered, sortKey, sortDir, accountMap, computeRowPriceUSD]);

  
  
function toggleExpand(bucket, region){
  const rowKey = bucket+"|"+(region||"");
  setExpanded(prev => {
    const n = new Set(prev);
    if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey);
    return n;
  });
  const ckey = rowKey+"|"+(start||"")+"|"+(end||"");
  // Lazy load timeseries
  if (!tsCache.has(ckey)){
    getJSON('/api/s3/bucket-ts-cached', { bucket, region, start, end, cached: 1 }).then(d => {
      const normalized = normalizeBucketTimeseriesPayload(d);
      setTsCache(prev => { const m = new Map(prev); m.set(ckey, normalized); return m; });
    }).catch(()=>{});
  }
  // Lazy load cost
  setCostCache(prev => {
    if (prev.has(ckey)) return prev;
    getJSON('/api/s3/bucket-cost', { bucket, region, start, end }).then(d => {
      const mm = new Map(prev);
      mm.set(ckey, d || { totalUSD:0, byClass:{}, currency:'USD' });
      setCostCache(mm);
    }).catch(()=>{});
    return prev;
  });
}

return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex items-center gap-3 flex-wrap">
        <input className="input" placeholder="Rechercher (bucket, tags, compte…)" value={q} onChange={e=>setQ(e.target.value)} />
        <div className="flex items-center gap-1">
          <span className="muted text-sm">Taille min (GB)</span>
          <input className="input w-[110px]" type="number" min="0" value={minSize} onChange={e=>setMinSize(e.target.value)} />
        </div>
        <div className="flex items-center gap-1">
          <span className="muted text-sm">Taille max (GB)</span>
          <input className="input w-[110px]" type="number" min="0" value={maxSize} onChange={e=>setMaxSize(e.target.value)} />
        </div>
        <select className="select" value={classFilter} onChange={e=>setClassFilter(e.target.value)}>
          <option value="">Classe: toutes</option>
          {classOptions.map(k => <option key={k} value={k}>{S3_FRIENDLY[k]||k}</option>)}
        </select>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" className="checkbox" checked={showOverhead} onChange={e=>setShowOverhead(e.target.checked)} />
          Afficher overhead/staging
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" className="checkbox" checked={dense} onChange={e=>setDense(e.target.checked)} />
          Mode compact
        </label>

        <div className="muted text-sm">Régions: {regions.join(', ')||'—'}</div>
        <div className="flex items-center gap-2 text-xs">
          {rowsMetaBadge && (
            <span className="inline-flex items-center px-2 py-1 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">
              {rowsMetaBadge}
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleRefreshClick} disabled={loadingBuckets} title="Recharger l'instantané depuis la base">
            {loadingBuckets ? 'Chargement…' : 'Rafraîchir'}
          </button>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-base font-semibold">Buckets S3</div>
            <TrustBadge type="cache">Cache DB</TrustBadge>
            <TrustBadge type="estimate">Prix stockage estimé</TrustBadge>
          </div>
          <div className="muted text-sm">
            Total sélectionné: <b>{formatBytesDecimal(totalAll.bytes, { spaced:true }).text}</b> · Objets: <b>{totalAll.objs.toLocaleString('fr-FR')}</b> · Total PRIX : <b>{currency(totalPriceUSD)}</b>
          </div>
        </div>
        <div className="overflow-auto">
          <table className={`table w-full ${dense ? "dense" : ""} text-sm` }>
            <thead>
              <tr>
                <th className="cursor-pointer" onClick={()=>handleSort('bucket')}>Bucket {renderSortIndicator('bucket')}</th>
                <th className="cursor-pointer" onClick={()=>handleSort('account')}>Compte {renderSortIndicator('account')}</th>
                <th className="cursor-pointer" onClick={()=>handleSort('region')}>Région {renderSortIndicator('region')}</th>
                <th className="cursor-pointer text-right" onClick={()=>handleSort('objects')}>#Objets {renderSortIndicator('objects')}</th>
                <th className="cursor-pointer text-right" onClick={()=>handleSort('size')}>Taille {renderSortIndicator('size')}</th>
                <th>Détail par classe</th>
                <th className="cursor-pointer text-right" onClick={()=>handleSort('price')}>Prix (stockage) {renderSortIndicator('price')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r,i)=>{
                const accName = (accountMap && accountMap.get(r.accountId)) || r.accountId || '—';
                const size = formatBytesDecimal(r.totalBytes, { spaced:true });
                const priceUSD = computeRowPriceUSD(r);

                return (
                  <>
                    <tr key={r.bucket+'-'+i}>
                      <td className="font-medium">
                        <button
                          className="underline decoration-dotted"
                          onClick={()=>toggleExpand(r.bucket, r.region)}
                          title="Afficher l'évolution et le détail"
                        >
                          {r.bucket}
                        </button>
                      </td>
                      <td>{accName}</td>
                      <td>{r.region||'—'}</td>
                      <td className="text-right">{(r.objects||0).toLocaleString('fr-FR')}</td>
                      <td className="text-right tabular-nums">{size.text}</td>
                      <td title="Répartition par classe">
                        <S3ClassBar classes={r.classes||{}} total={r.totalBytes||0} showOverhead={showOverhead} />
                      </td>
                      <td
                        className="text-right tabular-nums"
                        title={priceUSD!=null ? ("Estimation stockage (USD/mo): "+currency(priceUSD)) : undefined}
                      >
                        {priceUSD!=null ? currency(priceUSD) : "—"}
                      </td>
                    </tr>
                    {expanded.has(r.bucket+'|'+(r.region||'')) && (
                      <tr className="bg-slate-50/60">
                        <td colSpan="7">
                          <BucketDetail
                            bucket={r.bucket}
                            region={r.region}
                            totalBytes={r.totalBytes||0}
                            cacheKey={r.bucket+'|'+(r.region||'')+'|'+(start||'')+'|'+(end||'')}
                            tsCache={tsCache}
                            costCache={costCache}
                            showOverhead={showOverhead}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
              {filtered.length===0 && <tr><td colSpan="7" className="text-center muted py-4">Aucun bucket trouvé.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );


}
export { InsightsTab, RiTab, SpTab, EC2Tab, CalculatorTab, VPCTab, NetworkFinOpsTab, S3Tab };

export default function App(){
  const { accounts, accountMap } = useAccounts();
  const [metric,setMetric]=useState(METRICS[0]);
  const [account,setAccount]=useState("");
  const [timeframe,setTimeframe]=useState("30j");
  const [mode,setMode]=useState("rel");
  const [absStart,setAbsStart]=useState(addDays(today(),-30));
  const [absEnd,setAbsEnd]=useState(today());
  const [tab,setTab]=useState('overview');
  const [riMode, setRiMode] = useState(true);

  const regionsEffective = useEffectiveRegions();
  const [regions, setRegions] = useState('');
  const [excludeTax, setExcludeTax] = useState(false);

  // Default region selection: prefer eu-west-3 when available
  useEffect(() => {
    if (!regions || String(regions).trim() === '') {
      if (Array.isArray(regionsEffective) && regionsEffective.includes('eu-west-3')) {
        setRegions('eu-west-3');
      }
    }
  }, [regionsEffective, regions]);

  const { start, end } = useMemo(()=>{
    if (mode==='abs') return { start: absStart, end: absEnd };
    const now = new Date();
    const endStr = toLocalDateString(now);
    if (timeframe==='7j'){
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate()-7);
      return { start: toLocalDateString(startDate), end: endStr };
    }
    if (timeframe==='30j'){
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate()-30);
      return { start: toLocalDateString(startDate), end: endStr };
    }
    if (timeframe==='90j'){
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate()-90);
      return { start: toLocalDateString(startDate), end: endStr };
    }
    if (timeframe==='mois_courant'){
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: toLocalDateString(startDate), end: endStr };
    }
    if (timeframe==='mois_préc'){
      const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: toLocalDateString(startDate), end: toLocalDateString(endDate) };
    }
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate()-30);
    return { start: toLocalDateString(startDate), end: endStr };
  },[timeframe, mode, absStart, absEnd]);

  return (
    <div className="w-full px-3 sm:px-4 lg:px-8 xl:px-12 py-6">
      <Header metric={metric} setMetric={setMetric} account={account} setAccount={setAccount} accounts={accounts}
        mode={mode} setMode={setMode} absStart={absStart} setAbsStart={setAbsStart} absEnd={absEnd} setAbsEnd={setAbsEnd} timeframe={timeframe} setTimeframe={setTimeframe}
        regions={regions} setRegions={setRegions} regionsEffective={regionsEffective}
        excludeTax={excludeTax} setExcludeTax={setExcludeTax} riMode={riMode} setRiMode={setRiMode} />
      <div className="flex items-center gap-2 mb-4">
        <button className={'btn '+(tab==='overview'?'btn-primary':'')} onClick={()=>setTab('overview')}>Vue d'ensemble</button>
        <button className={'btn '+(tab==='ri'?'btn-primary':'')} onClick={()=>setTab('ri')}>Réservations EC2</button>
        <button className={'btn '+(tab==='sp'?'btn-primary':'')} onClick={()=>setTab('sp')}>Saving Plan</button>
        <button className={'btn '+(tab==='ec2'?'btn-primary':'')} onClick={()=>setTab('ec2')}>EC2 & EBS</button>
        <button className={'btn '+(tab==='calculator'?'btn-primary':'')} onClick={()=>setTab('calculator')}>Calculateur</button>
        <button className={'btn '+(tab==='vpc'?'btn-primary':'')} onClick={()=>setTab('vpc')}>VPC / Réseau</button>
        <button className={'btn '+(tab==='s3'?'btn-primary':'')} onClick={()=>setTab('s3')}>S3</button>
      </div>
      {tab==='overview' && <Overview start={start} end={end} metric={metric} account={account} regions={regions} accountMap={accountMap} excludeTax={excludeTax} />}
      {tab==='ri' && <RiTab start={start} end={end} accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} />}
      {tab==='sp' && <SpTab start={start} end={end} selectedRegionsCsv={regions} accountMap={accountMap} />}
      {tab==='ec2' && <EC2Tab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} selectedAccount={account} />}
      {tab==='calculator' && (
        <CalculatorTab
          accountMap={accountMap}
          selectedRegionsCsv={regions}
          regionsEffective={regionsEffective}
          selectedAccount={account}
          riMode={riMode}
        />
      )}
      {tab==='vpc' && <VPCTab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} />}
      {tab==='s3' && <S3Tab accountMap={accountMap} selectedRegionsCsv={regions} regionsEffective={regionsEffective} start={start} end={end} />}
    </div>
  );
}
