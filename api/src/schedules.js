import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { loadAccountsConfig } from "./config.js";

const DEFAULT_SHARED_ACCOUNT_ID = "";
const DEFAULT_SHARED_ACCOUNT_ALIAS = "";

const DEFAULT_TABLE_NAME = "";
const DEFAULT_REGION = process.env.INSTANCE_SCHEDULER_REGION
  || process.env.SCHEDULES_DYNAMODB_REGION
  || "eu-west-3";
const TABLE_NAME = process.env.INSTANCE_SCHEDULER_TABLE || DEFAULT_TABLE_NAME;
const CACHE_TTL_MS = Number.parseInt(process.env.INSTANCE_SCHEDULER_CACHE_MS || "300000", 10) || 5 * 60 * 1000;

function normalizeAccountId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return /^\d{12}$/.test(raw) ? raw : null;
}

function normalizeAccountName(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw || null;
}

function resolveSchedulerCredentialCandidates() {
  const candidates = [];

  const directAccessKeyId = process.env.INSTANCE_SCHEDULER_ACCESS_KEY_ID;
  const directSecretAccessKey = process.env.INSTANCE_SCHEDULER_SECRET_ACCESS_KEY;
  const directSessionToken = process.env.INSTANCE_SCHEDULER_SESSION_TOKEN;
  if (directAccessKeyId && directSecretAccessKey) {
    candidates.push({
      accessKeyId: directAccessKeyId,
      secretAccessKey: directSecretAccessKey,
      sessionToken: directSessionToken || undefined
    });
  }

  const idCandidates = new Set();
  const nameCandidates = new Set();

  const accountHints = [
    process.env.INSTANCE_SCHEDULER_ACCOUNT_ID,
    process.env.INSTANCE_SCHEDULER_ACCOUNT,
    process.env.INSTANCE_SCHEDULER_ACCOUNT_NAME,
    process.env.INSTANCE_SCHEDULER_ACCOUNT_ALIAS
  ];

  for (const hint of accountHints) {
    if (!hint) continue;
    const tokens = String(hint)
      .split(",")
      .map(part => part.trim())
      .filter(Boolean);
    for (const token of tokens) {
      const id = normalizeAccountId(token);
      if (id) {
        idCandidates.add(id);
        continue;
      }
      const name = normalizeAccountName(token);
      if (name) {
        nameCandidates.add(name);
      }
    }
  }

  const config = loadAccountsConfig();
  const staticAccounts = Array.isArray(config?.static) ? config.static : [];

  const fallbackId = normalizeAccountId(
    process.env.INSTANCE_SCHEDULER_SHARED_ACCOUNT_ID || DEFAULT_SHARED_ACCOUNT_ID
  );
  const fallbackAlias = normalizeAccountName(
    process.env.INSTANCE_SCHEDULER_SHARED_ACCOUNT_ALIAS || DEFAULT_SHARED_ACCOUNT_ALIAS
  );

  if (!staticAccounts.length && candidates.length === 0) {
    return [null];
  }

  const hadExplicitHints = idCandidates.size > 0 || nameCandidates.size > 0;

  if (!hadExplicitHints) {
    if (fallbackId) idCandidates.add(fallbackId);
    if (fallbackAlias) nameCandidates.add(fallbackAlias);
  }

  let fallbackAccount = null;

  for (const account of staticAccounts) {
    if (!account || typeof account !== "object") continue;
    const accountId = normalizeAccountId(account.accountId || account.id);
    const accountName = normalizeAccountName(
      account.accountName || account.alias || account.name
    );
    const hasKeys = account.accessKeyId && account.secretAccessKey;
    if (!hasKeys) continue;

    const matchesId = accountId && idCandidates.size ? idCandidates.has(accountId) : false;
    const matchesName = accountName && nameCandidates.size ? nameCandidates.has(accountName) : false;
    const isFallbackAccount =
      (fallbackId && accountId === fallbackId)
      || (fallbackAlias && accountName === fallbackAlias);

    if (matchesId || matchesName) {
      candidates.push({
        accessKeyId: account.accessKeyId,
        secretAccessKey: account.secretAccessKey,
        sessionToken: account.sessionToken || account.sessionTokenValue || undefined
      });
    }

    if (isFallbackAccount && !fallbackAccount) {
      fallbackAccount = account;
    }
  }

  if (fallbackAccount) {
    candidates.push({
      accessKeyId: fallbackAccount.accessKeyId,
      secretAccessKey: fallbackAccount.secretAccessKey,
      sessionToken: fallbackAccount.sessionToken || fallbackAccount.sessionTokenValue || undefined
    });
  }

  if (!candidates.length) {
    for (const account of staticAccounts) {
      if (!account || typeof account !== "object") continue;
      if (!account.accessKeyId || !account.secretAccessKey) continue;
      candidates.push({
        accessKeyId: account.accessKeyId,
        secretAccessKey: account.secretAccessKey,
        sessionToken: account.sessionToken || account.sessionTokenValue || undefined
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const cred of candidates) {
    const key = cred
      ? `${cred.accessKeyId || ""}|${cred.secretAccessKey || ""}|${cred.sessionToken || ""}`
      : "__default__";
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cred);
  }

  if (!seen.has("__default__")) {
    deduped.push(null);
  }

  return deduped;
}

const schedulerCredentialCandidates = resolveSchedulerCredentialCandidates();

const baseClientCache = new Map();
const documentClientCache = new Map();

function getBaseClient(credentials) {
  const cacheKey = credentials
    ? `${credentials.accessKeyId || ""}|${credentials.secretAccessKey || ""}|${credentials.sessionToken || ""}`
    : "__default__";
  if (!baseClientCache.has(cacheKey)) {
    const client = new DynamoDBClient({
      region: DEFAULT_REGION,
      credentials: credentials || undefined
    });
    baseClientCache.set(cacheKey, client);
  }
  return baseClientCache.get(cacheKey);
}

function getDocumentClient(credentials) {
  const cacheKey = credentials
    ? `${credentials.accessKeyId || ""}|${credentials.secretAccessKey || ""}|${credentials.sessionToken || ""}`
    : "__default__";
  if (!documentClientCache.has(cacheKey)) {
    const baseClient = getBaseClient(credentials);
    const docClient = DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: { removeUndefinedValues: true },
      unmarshallOptions: { wrapNumbers: false }
    });
    documentClientCache.set(cacheKey, docClient);
  }
  return documentClientCache.get(cacheKey);
}

const CACHE = new Map();

const DEFAULT_DEBUG_TABLE_LIMIT = Number.parseInt(
  process.env.INSTANCE_SCHEDULER_DEBUG_TABLE_LIMIT || "60",
  10
) || 60;
const DEFAULT_DEBUG_STAGE_LIMIT = Number.parseInt(
  process.env.INSTANCE_SCHEDULER_DEBUG_STAGE_LIMIT || "40",
  10
) || 40;

function toArray(value) {
  if (!value && value !== 0) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (value && typeof value === "object" && Array.isArray(value.values)) return value.values;
  return [];
}

function sanitizeError(err) {
  if (!err) return null;
  const name = err.name || err.code || "Error";
  const code = err.code || err.name || null;
  const message = err.message || String(err);
  const details = {};
  if (err.$metadata && typeof err.$metadata === "object") {
    const { requestId, httpStatusCode } = err.$metadata;
    if (requestId) details.requestId = requestId;
    if (httpStatusCode) details.httpStatusCode = httpStatusCode;
  }
  return {
    name,
    code: code || null,
    message,
    ...(Object.keys(details).length ? { details } : {})
  };
}

function sanitizeKey(key) {
  if (!key || typeof key !== "object") return null;
  const entries = Object.entries(key).map(([k, v]) => [k, v]);
  return Object.fromEntries(entries);
}

function summarizeItem(item, maxEntries = 20) {
  if (!item || typeof item !== "object") return item ?? null;
  const entries = Object.entries(item);
  const summary = {};
  for (let i = 0; i < entries.length && i < maxEntries; i += 1) {
    const [key, value] = entries[i];
    summary[key] = value;
  }
  if (entries.length > maxEntries) {
    summary.__truncatedKeys = entries.length - maxEntries;
  }
  return summary;
}

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_ALIASES = new Map([
  ["monday", "mon"],
  ["mon", "mon"],
  ["tuesday", "tue"],
  ["tues", "tue"],
  ["tue", "tue"],
  ["wednesday", "wed"],
  ["wed", "wed"],
  ["thursday", "thu"],
  ["thur", "thu"],
  ["thu", "thu"],
  ["friday", "fri"],
  ["fri", "fri"],
  ["saturday", "sat"],
  ["sat", "sat"],
  ["sunday", "sun"],
  ["sun", "sun"],
  ["weekdays", "weekdays"],
  ["weekends", "weekends"],
  ["daily", "all"],
  ["alldays", "all"],
  ["everyday", "all"],
  ["all", "all"]
]);

function normalizeToken(token = "") {
  const raw = String(token || "").replace(/[^a-zA-Z\-]/g, "").toLowerCase();
  return DAY_ALIASES.get(raw) || raw;
}

function expandWeekdayToken(token) {
  const normalized = normalizeToken(token);
  if (!normalized) return [];
  if (normalized === "weekdays") {
    return ["mon", "tue", "wed", "thu", "fri"];
  }
  if (normalized === "weekends") {
    return ["sat", "sun"];
  }
  if (normalized === "all") {
    return [...DAY_ORDER];
  }
  if (normalized.includes("-")) {
    const [startRaw, endRaw] = normalized.split("-", 2);
    const start = DAY_ORDER.indexOf(startRaw);
    const end = DAY_ORDER.indexOf(endRaw);
    if (start === -1 || end === -1) return [];
    const days = [];
    let idx = start;
    let guard = 0;
    while (guard < 7) {
      days.push(DAY_ORDER[idx]);
      if (idx === end) break;
      idx = (idx + 1) % DAY_ORDER.length;
      guard += 1;
    }
    return days;
  }
  if (DAY_ORDER.includes(normalized)) {
    return [normalized];
  }
  return [];
}

function parseTimeToMinutes(value) {
  if (!value && value !== 0) return null;
  const str = String(value);
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2] || "0", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 47) return null;
  if (minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function computeDurationMinutes(startMinutes, endMinutes) {
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return 0;
  if (endMinutes >= startMinutes) {
    return endMinutes - startMinutes;
  }
  // Overnight period: wrap around midnight
  const minutesPerDay = 24 * 60;
  return (minutesPerDay - startMinutes) + endMinutes;
}

function computeScheduleMetrics(periods = []) {
  const dailyMinutes = {
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
    sat: 0,
    sun: 0
  };

  for (const period of periods) {
    const durationMinutes = Number.isFinite(period.durationMinutes) ? period.durationMinutes : 0;
    if (durationMinutes <= 0) continue;
    const weekdays = Array.isArray(period.weekdaysExpanded) ? period.weekdaysExpanded : [];
    for (const day of weekdays) {
      if (day in dailyMinutes) {
        dailyMinutes[day] += durationMinutes;
      }
    }
  }

  const totalMinutesPerWeek = Object.values(dailyMinutes).reduce((sum, value) => sum + value, 0);
  const activeDays = Object.values(dailyMinutes).filter(value => value > 0);
  const averageDailyHours = activeDays.length
    ? activeDays.reduce((sum, value) => sum + value, 0) / activeDays.length / 60
    : 0;
  const averageDailyHoursAllDays = totalMinutesPerWeek / (7 * 60);

  const dailyHours = Object.fromEntries(
    Object.entries(dailyMinutes).map(([day, minutes]) => [day, minutes / 60])
  );

  return {
    totalMinutesPerWeek,
    averageDailyHours,
    averageDailyHoursAllDays,
    dailyMinutes,
    dailyHours
  };
}

function shouldTryNextCredential(err) {
  if (!err) return false;
  const code = err.name || err.code;
  if (!code) return false;
  const normalized = String(code).toLowerCase();
  const retryableTokens = [
    "accessdenied",
    "accessdeniedexception",
    "resourcenotfound",
    "resourcenotfoundexception",
    "unrecognizedclientexception",
    "invalidsignatureexception",
    "credentialserror"
  ];
  return retryableTokens.some(token => normalized.includes(token));
}

function looseNameScore(targetRaw, candidateRaw) {
  if (!targetRaw || !candidateRaw) return 0;
  const targetTrimmed = String(targetRaw).trim();
  const candidateTrimmed = String(candidateRaw).trim();
  if (!candidateTrimmed) return 0;

  if (candidateTrimmed === targetRaw) return 120;
  if (candidateTrimmed === targetTrimmed) return 110;

  const targetLower = targetTrimmed.toLowerCase();
  const candidateLower = candidateTrimmed.toLowerCase();
  if (!candidateLower) return 0;

  if (candidateLower === String(targetRaw).toLowerCase()) return 105;
  if (candidateLower === targetLower) return 100;

  const normalizeSeparators = value => value.replace(/[\s-]+/g, "_");
  const stripSeparators = value => value.replace(/[\s_\-]+/g, "");

  const targetNormalized = normalizeSeparators(targetLower);
  const candidateNormalized = normalizeSeparators(candidateLower);
  if (candidateNormalized === normalizeSeparators(String(targetRaw).toLowerCase())) return 95;
  if (candidateNormalized === targetNormalized) return 90;

  const targetCollapsed = stripSeparators(targetLower);
  const candidateCollapsed = stripSeparators(candidateLower);
  if (candidateCollapsed === targetCollapsed) return 85;

  if (candidateLower.includes(targetLower) && targetLower.length >= 3) return 70;
  if (targetLower.includes(candidateLower) && candidateLower.length >= 3) return 65;

  return 0;
}

function extractItemName(item) {
  if (!item || typeof item !== "object") return null;
  if (item.name) return item.name;
  if (item.Name) return item.Name;
  if (item.scheduleName) return item.scheduleName;
  return null;
}

async function attemptFetchWithClient({ client, tableName, type, name, logStage }) {
  if (!client || !tableName || !name) return null;
  const keyCandidates = buildKeyCandidates(type, name);
  let lastError = null;

  for (const key of keyCandidates) {
    const sanitizedKey = sanitizeKey(key);
    const command = new GetCommand({
      TableName: tableName,
      Key: key
    });

    try {
      const response = await client.send(command);
      if (logStage) {
        logStage({
          stage: "get",
          key: sanitizedKey,
          outcome: response?.Item ? "hit" : "miss"
        });
      }
      if (response?.Item) {
        return response.Item;
      }
    } catch (err) {
      lastError = err;
      if (logStage) {
        logStage({
          stage: "get",
          key: sanitizedKey,
          error: sanitizeError(err)
        });
      }
      if (isKeySchemaMismatchError(err)) {
        continue;
      }
      throw err;
    }
  }

  try {
    const looseItem = await findLooseMatch(client, tableName, type, name);
    if (logStage) {
      logStage({
        stage: "query",
        outcome: looseItem ? "hit" : "miss"
      });
    }
    if (looseItem) {
      return looseItem;
    }
  } catch (err) {
    lastError = err;
    if (logStage) {
      logStage({
        stage: "query",
        error: sanitizeError(err)
      });
    }
    if (!isKeySchemaMismatchError(err)) {
      throw err;
    }
  }

  try {
    const scannedItem = await scanForLooseMatch(client, tableName, type, name);
    if (logStage) {
      logStage({
        stage: "scan",
        outcome: scannedItem ? "hit" : "miss"
      });
    }
    if (scannedItem) {
      return scannedItem;
    }
  } catch (err) {
    lastError = err;
    if (logStage) {
      logStage({
        stage: "scan",
        error: sanitizeError(err)
      });
    }
    if (!isKeySchemaMismatchError(err)) {
      throw err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

async function listTablesForCredentials(credentials, maxTables = DEFAULT_DEBUG_TABLE_LIMIT) {
  const client = getBaseClient(credentials);
  const tableNames = [];
  if (!client) return tableNames;

  const effectiveLimit = Number.isFinite(maxTables) && maxTables > 0 ? maxTables : DEFAULT_DEBUG_TABLE_LIMIT;
  let exclusiveStartTableName = undefined;

  while (!effectiveLimit || tableNames.length < effectiveLimit) {
    const remaining = effectiveLimit ? effectiveLimit - tableNames.length : undefined;
    const limitParam = remaining ? Math.min(Math.max(1, remaining), 100) : undefined;
    const command = new ListTablesCommand({
      ExclusiveStartTableName: exclusiveStartTableName,
      ...(limitParam ? { Limit: limitParam } : {})
    });
    const response = await client.send(command);
    const names = Array.isArray(response?.TableNames) ? response.TableNames : [];
    for (const name of names) {
      if (typeof name !== "string" || !name) continue;
      tableNames.push(name);
      if (effectiveLimit && tableNames.length >= effectiveLimit) {
        break;
      }
    }
    if (!response?.LastEvaluatedTableName) {
      break;
    }
    exclusiveStartTableName = response.LastEvaluatedTableName;
  }

  return tableNames;
}

const LOOSE_LOOKUP_PAGE_SIZE = 25;
const LOOSE_LOOKUP_MAX_PAGES = 10;

async function findLooseMatch(client, tableName, type, targetName) {
  if (!client || !type || !targetName) return null;
  const trimmed = String(targetName).trim();
  if (!trimmed) return null;

  let bestItem = null;
  let bestScore = 0;
  let bestCount = 0;
  let page = 0;
  let exclusiveStartKey = undefined;

  while (page < LOOSE_LOOKUP_MAX_PAGES) {
    const command = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "#type = :type",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: { ":type": type },
      Limit: LOOSE_LOOKUP_PAGE_SIZE,
      ExclusiveStartKey: exclusiveStartKey
    });

    const response = await client.send(command);
    const items = Array.isArray(response?.Items) ? response.Items : [];
    for (const item of items) {
      const candidateName = extractItemName(item);
      const score = looseNameScore(trimmed, candidateName);
      if (score > bestScore) {
        bestItem = item;
        bestScore = score;
        bestCount = 1;
      } else if (score > 0 && score === bestScore) {
        bestCount += 1;
      }

      if (bestScore >= 110) {
        return bestItem;
      }
    }

    if (!response?.LastEvaluatedKey) {
      break;
    }

    exclusiveStartKey = response.LastEvaluatedKey;
    page += 1;
  }

  if (bestScore > 0 && bestCount === 1) {
    return bestItem;
  }

  return null;
}

const SCAN_FALLBACK_PAGE_SIZE = 100;
const SCAN_FALLBACK_MAX_PAGES = 20;

async function scanForLooseMatch(client, tableName, type, targetName) {
  if (!client || !targetName) return null;
  const trimmed = String(targetName).trim();
  if (!trimmed) return null;

  let bestItem = null;
  let bestScore = 0;
  let bestCount = 0;
  let page = 0;
  let exclusiveStartKey = undefined;

  const expressionAttributeNames = type ? { "#type": "type" } : undefined;
  const expressionAttributeValues = type ? { ":type": type } : undefined;

  while (page < SCAN_FALLBACK_MAX_PAGES) {
    const command = new ScanCommand({
      TableName: tableName,
      Limit: SCAN_FALLBACK_PAGE_SIZE,
      ExclusiveStartKey: exclusiveStartKey,
      FilterExpression: type ? "#type = :type" : undefined,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    });

    const response = await client.send(command);
    const items = Array.isArray(response?.Items) ? response.Items : [];

    for (const item of items) {
      const candidateName = extractItemName(item);
      const score = looseNameScore(trimmed, candidateName);
      if (score > bestScore) {
        bestItem = item;
        bestScore = score;
        bestCount = 1;
      } else if (score > 0 && score === bestScore) {
        bestCount += 1;
      }

      if (bestScore >= 110) {
        return bestItem;
      }
    }

    if (!response?.LastEvaluatedKey) {
      break;
    }

    exclusiveStartKey = response.LastEvaluatedKey;
    page += 1;
  }

  if (bestScore > 0 && bestCount === 1) {
    return bestItem;
  }

  return null;
}

export async function debugInstanceScheduleSearch(name, options = {}) {
  const normalizedName = String(name || "").trim();
  const includeRawItems = options.includeRawItems === true;
  const maxTablesOpt = Number.isFinite(options.maxTables) && options.maxTables > 0
    ? Math.min(options.maxTables, 500)
    : DEFAULT_DEBUG_TABLE_LIMIT;
  const maxTables = Math.max(1, maxTablesOpt);

  const result = {
    scheduleName: normalizedName,
    region: DEFAULT_REGION,
    primaryTable: TABLE_NAME,
    discoveredTables: [],
    tablesChecked: [],
    matches: [],
    limitReached: false
  };

  if (!normalizedName) {
    result.error = { code: "empty_schedule_name", message: "Schedule name is empty" };
    return result;
  }

  const discoveredTables = new Set([TABLE_NAME]);
  const discoveryLogs = [];

  for (let idx = 0; idx < schedulerCredentialCandidates.length; idx += 1) {
    if (discoveredTables.size >= maxTables) {
      break;
    }
    const credentials = schedulerCredentialCandidates[idx];
    const logEntry = { credentialsIndex: idx, tables: [] };
    try {
      const remaining = maxTables - discoveredTables.size;
      const tables = await listTablesForCredentials(credentials, Math.max(remaining, 1));
      logEntry.tables = tables;
      logEntry.tableCount = tables.length;
      for (const tableName of tables) {
        if (!tableName || typeof tableName !== "string") continue;
        discoveredTables.add(tableName);
        if (discoveredTables.size >= maxTables) break;
      }
    } catch (err) {
      logEntry.error = sanitizeError(err);
    }
    discoveryLogs.push(logEntry);
  }

  result.discoveredTables = discoveryLogs;
  result.limitReached = discoveredTables.size >= maxTables;

  const tablesToCheck = Array.from(discoveredTables).slice(0, maxTables);

  for (const tableName of tablesToCheck) {
    const attemptSummaries = [];
    let matchItem = null;
    let fetchError = null;

    try {
      matchItem = await fetchItem("schedule", normalizedName, {
        tableName,
        debugRecorder: (info) => {
          attemptSummaries.push({
            tableName,
            credentialsIndex: info.credentialsIndex,
            matched: !!info.matched,
            attempts: Array.isArray(info.attempts) ? info.attempts : [],
            truncated: !!info.truncated,
            error: info.error || null
          });
        }
      });
    } catch (err) {
      fetchError = sanitizeError(err);
    }

    if (fetchError) {
      attemptSummaries.push({
        tableName,
        credentialsIndex: null,
        matched: false,
        attempts: [],
        truncated: false,
        error: fetchError
      });
    }

    result.tablesChecked.push({
      tableName,
      matched: !!matchItem,
      attempts: attemptSummaries
    });

    if (matchItem) {
      const matchEntry = {
        tableName,
        itemSummary: summarizeItem(matchItem)
      };
      if (includeRawItems) {
        matchEntry.item = matchItem;
      }
      result.matches.push(matchEntry);
    }
  }

  result.totalTablesChecked = result.tablesChecked.length;
  result.totalMatches = result.matches.length;

  return result;
}

function buildKeyCandidates(type, name) {
  const candidates = [];
  const trimmedName = String(name ?? "").trim();
  const normalizedType = type ? String(type).trim() : null;

  if (normalizedType && trimmedName) {
    candidates.push({ type: normalizedType, name: trimmedName });
  }

  if (trimmedName) {
    candidates.push({ name: trimmedName });
  }

  const seen = new Set();
  return candidates.filter(candidate => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isKeySchemaMismatchError(err) {
  if (!err) return false;
  const code = String(err.name || err.code || "").toLowerCase();
  if (code !== "validationexception") return false;
  const message = String(err.message || "").toLowerCase();
  if (!message) return true;
  const tokens = [
    "does not match the schema",
    "missing the key schema element",
    "invalid keyconditionexpression",
    "invalid key condition expression",
    "query key condition not supported",
    "type mismatch for key",
    "provided key element does not match",
    "invalid filterexpression",
    "invalid filter expression"
  ];
  return tokens.some(token => message.includes(token));
}

async function fetchItem(type, name, options = {}) {
  if (!type || !name) return null;
  const tableName = options.tableName || TABLE_NAME;
  const debugRecorder = typeof options.debugRecorder === "function" ? options.debugRecorder : null;
  let lastError = null;

  for (let idx = 0; idx < schedulerCredentialCandidates.length; idx += 1) {
    const credentials = schedulerCredentialCandidates[idx];
    const attemptLogs = [];
    let truncated = false;
    const logStage = debugRecorder
      ? (entry) => {
          if (attemptLogs.length >= DEFAULT_DEBUG_STAGE_LIMIT) {
            truncated = true;
            return;
          }
          const sanitized = { stage: entry?.stage || "unknown" };
          if (entry?.key) sanitized.key = entry.key;
          if (entry?.outcome) sanitized.outcome = entry.outcome;
          if (entry?.error) sanitized.error = entry.error;
          if (entry?.details) sanitized.details = entry.details;
          attemptLogs.push(sanitized);
        }
      : null;

    try {
      const client = getDocumentClient(credentials);
      const item = await attemptFetchWithClient({
        client,
        tableName,
        type,
        name,
        logStage
      });

      if (debugRecorder) {
        debugRecorder({
          tableName,
          credentialsIndex: idx,
          attempts: attemptLogs,
          matched: !!item,
          truncated
        });
      }

      if (item) {
        return item;
      }
    } catch (err) {
      lastError = err;
      if (debugRecorder) {
        debugRecorder({
          tableName,
          credentialsIndex: idx,
          attempts: attemptLogs,
          matched: false,
          error: sanitizeError(err),
          truncated
        });
      }
      if (shouldTryNextCredential(err)) {
        continue;
      }
      throw err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function normalizeSchedule(scheduleItem, periodItems) {
  if (!scheduleItem) return null;
  const periods = [];
  const requestedPeriods = toArray(scheduleItem.periods);

  for (const periodName of requestedPeriods) {
    const periodRaw = periodItems.get(periodName);
    if (!periodRaw) continue;
    const beginMinutes = parseTimeToMinutes(periodRaw.begintime ?? periodRaw.beginTime ?? periodRaw.starttime);
    const endMinutes = parseTimeToMinutes(periodRaw.endtime ?? periodRaw.endTime ?? periodRaw.stoptime);
    const durationMinutes = computeDurationMinutes(beginMinutes, endMinutes);
    const weekdaysRaw = toArray(periodRaw.weekdays);
    const weekdaysExpanded = Array.from(new Set(
      weekdaysRaw.flatMap(token => expandWeekdayToken(token))
    ));
    periods.push({
      name: periodRaw.name || periodName,
      begintime: periodRaw.begintime ?? periodRaw.beginTime ?? null,
      endtime: periodRaw.endtime ?? periodRaw.endTime ?? null,
      durationMinutes,
      durationHours: durationMinutes / 60,
      weekdays: weekdaysRaw,
      weekdaysExpanded
    });
  }

  const metrics = computeScheduleMetrics(periods);

  return {
    name: scheduleItem.name,
    description: scheduleItem.description || null,
    timezone: scheduleItem.timezone || scheduleItem.timezoneName || null,
    periods,
    metrics
  };
}

export async function getInstanceSchedule(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;
  const cacheEntry = CACHE.get(normalizedName);
  const now = Date.now();
  if (cacheEntry && now - cacheEntry.timestamp < CACHE_TTL_MS) {
    return cacheEntry.value;
  }

  const scheduleItem = await fetchItem("schedule", normalizedName).catch(() => null);
  if (!scheduleItem) {
    CACHE.set(normalizedName, { timestamp: now, value: null });
    return null;
  }

  const periodNames = toArray(scheduleItem.periods);

  const periodItems = new Map();
  await Promise.all(periodNames.map(async periodName => {
    const period = await fetchItem("period", periodName).catch(() => null);
    if (period) {
      periodItems.set(periodName, period);
    }
  }));

  const schedule = normalizeSchedule(scheduleItem, periodItems);
  CACHE.set(normalizedName, { timestamp: now, value: schedule });
  return schedule;
}

export function clearScheduleCache() {
  CACHE.clear();
}
