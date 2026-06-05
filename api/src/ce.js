
// Facade that chooses between AWS Cost Explorer API and local Postgres, based on DATA_FROM.
const DATA_FROM = String(process.env.DATA_FROM || process.env.data_from || "LOCAL_DB").toUpperCase();
const USE_DB = DATA_FROM === "LOCAL_DB";

import * as aws from "./ce-aws.js";
import * as db from "./ce-db.js";
import * as spCache from "./sp-cache.js";

export const source = USE_DB ? "LOCAL_DB" : "AWS_API";
const AWS_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.AWS_LIVE_ENABLED || process.env.ALLOW_AWS_LIVE || "").toLowerCase());
const SP_CACHE_ENABLED = AWS_LIVE_ENABLED && String(process.env.SP_CACHE_ENABLED || (USE_DB ? "true" : "false")).toLowerCase() !== "false";

// Ingestion ONLY (always AWS):
export const getDailyCosts = aws.getDailyCosts;

// Accounts
export const listAccountsCE = (...args) => (USE_DB ? db.listAccountsCE(...args) : aws.listAccountsCE(...args));

// Costs
export const getCostsByService = (...args) => (USE_DB ? db.getCostsByService(...args) : aws.getCostsByService(...args));
export const getDailyTotalCosts = (...args) => (USE_DB ? db.getDailyTotalCosts(...args) : aws.getDailyTotalCosts(...args));
export const getTopCombos = (...args) => (USE_DB ? db.getTopCombos(...args) : aws.getTopCombos(...args));
export const getTopCombosEx = (...args) => (USE_DB ? db.getTopCombosEx(...args) : aws.getTopCombosEx(...args));

// RI (DB totals only; 'by' breakdowns require API ingestion)
export const getRiCoverage = (...args) => (USE_DB ? db.getRiCoverage(...args) : aws.getRiCoverage(...args));
export const getRiUtilization = (...args) => (USE_DB ? db.getRiUtilization(...args) : aws.getRiUtilization(...args));

// Savings Plans can be expensive/noisy to refresh. In LOCAL_DB mode we never miss-through to AWS.
export const getSpCoverage = (params = {}) => {
  if (USE_DB && !AWS_LIVE_ENABLED) return db.getSpCoverage(params);
  return SP_CACHE_ENABLED ? spCache.getCachedSpCoverage(params) : aws.getSpCoverage(params);
};
export const getSpUtilization = (params = {}) => {
  if (USE_DB && !AWS_LIVE_ENABLED) return db.getSpUtilization(params);
  return SP_CACHE_ENABLED ? spCache.getCachedSpUtilization(params) : aws.getSpUtilization(params);
};
export const listSavingsPlans = (params = {}) => {
  if (USE_DB && !AWS_LIVE_ENABLED) return [];
  return SP_CACHE_ENABLED ? spCache.getCachedSavingsPlansInventory(params) : aws.listSavingsPlans(params);
};
