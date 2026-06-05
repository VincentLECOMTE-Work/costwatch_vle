function normalizeFamily(type = "") {
  return String(type || "").split(".")[0].trim().toLowerCase();
}

function normalizeRegion(region = "") {
  const value = String(region || "").trim().toLowerCase();
  if (!value || value === "any" || value === "global") return "any";
  return value;
}

function normalizePlanType(value = "") {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hourlyNeed(item) {
  const onDemandHourly = Number(item?.onDemandHourly || 0);
  if (!(onDemandHourly > 0)) return 0;
  const hoursPerDay = Number(item?.hoursPerDay || 24);
  const ratio = Math.min(1, Math.max(0, Number.isFinite(hoursPerDay) ? hoursPerDay / 24 : 1));
  return onDemandHourly * ratio;
}

function usageUnits(item) {
  const hoursPerDay = Number(item?.hoursPerDay || 24);
  return Math.min(1, Math.max(0, Number.isFinite(hoursPerDay) ? hoursPerDay / 24 : 1));
}

function itemMatchesPlan(item, planScope) {
  if (!item || !planScope) return false;
  if (item.riCovered) return false;
  const region = normalizeRegion(item.region);
  if (planScope.region !== "any" && region !== planScope.region) return false;
  if (planScope.isEc2InstancePlan && planScope.family && normalizeFamily(item.instanceType) !== planScope.family) {
    return false;
  }
  return true;
}

function planScope(plan = {}) {
  const type = normalizePlanType(plan.type || plan.savingsPlanType || plan.SavingsPlanType || "");
  const region = normalizeRegion(plan.region || plan.Region || "any");
  const family = normalizeFamily(
    plan.instanceFamily || plan.ec2InstanceFamily || plan.EC2InstanceFamily || ""
  );
  return {
    type,
    region,
    family,
    isEc2InstancePlan: type.includes("EC2INSTANCE")
  };
}

function planSpecificityScore(scope) {
  if (!scope) return 0;
  let score = 0;
  if (scope.isEc2InstancePlan) score += 100;
  if (scope.region && scope.region !== "any") score += 20;
  if (scope.family) score += 10;
  return score;
}

export function applySavingsPlansCoverage(items = [], savingsPlans = [], options = {}) {
  const EPS = 1e-9;
  const list = Array.isArray(items) ? items : [];
  const resolvePlanHourlyRate = typeof options?.resolvePlanHourlyRate === "function"
    ? options.resolvePlanHourlyRate
    : null;
  const activePlans = (Array.isArray(savingsPlans) ? savingsPlans : [])
    .filter(plan => String(plan.state || plan.State || "").toLowerCase() === "active")
    .map(plan => {
      const commitment = Number(plan.commitment ?? plan.Commitment ?? 0);
      return {
        plan,
        scope: planScope(plan),
        commitment: Number.isFinite(commitment) ? Math.max(0, commitment) : 0
      };
    })
    .filter(entry => entry.commitment > 0)
    .sort((a, b) => {
      const bySpecificity = planSpecificityScore(b.scope) - planSpecificityScore(a.scope);
      if (bySpecificity !== 0) return bySpecificity;
      return b.commitment - a.commitment;
    });

  const trackedItems = list.map(item => {
    const need = hourlyNeed(item);
    const units = usageUnits(item);
    item.spCoveragePct = 0;
    item.spCoveredHourly = 0;
    item.spEligibleHourly = need;
    return {
      item,
      totalUnits: units,
      remainingUnits: units
    };
  });

  let totalCommitment = 0;
  let usedCommitment = 0;
  const planAllocations = [];
  for (const entry of activePlans) {
    totalCommitment += entry.commitment;
    let remainingCommitment = entry.commitment;
    if (!(remainingCommitment > 0)) continue;

    const eligible = trackedItems
      .filter(({ item, remainingUnits }) => remainingUnits > 0 && itemMatchesPlan(item, entry.scope))
      .map(tracked => {
        const fallbackRate = Number(tracked?.item?.onDemandHourly || 0);
        const resolvedRate = resolvePlanHourlyRate ? Number(resolvePlanHourlyRate(entry.plan, tracked.item)) : NaN;
        const planRate = Number.isFinite(resolvedRate) && resolvedRate > 0 ? resolvedRate : fallbackRate;
        const remainingNeed = planRate > 0 ? planRate * tracked.remainingUnits : 0;
        return {
          tracked,
          planRate,
          remainingNeed
        };
      })
      .filter(candidate => candidate.planRate > 0 && candidate.remainingNeed > 0)
      .sort((a, b) => b.remainingNeed - a.remainingNeed);
    const eligibleHourly = eligible.reduce((sum, it) => sum + (it.remainingNeed || 0), 0);
    const coveredInstances = [];

    for (const target of eligible) {
      if (!(remainingCommitment > 0)) break;
      const allocation = Math.min(remainingCommitment, target.remainingNeed);
      if (!(allocation > EPS)) continue;
      const coveredUnits = target.planRate > 0 ? allocation / target.planRate : 0;
      target.tracked.remainingUnits = Math.max(0, target.tracked.remainingUnits - coveredUnits);
      target.tracked.item.spCoveredHourly = Number(target.tracked.item.spCoveredHourly || 0) + allocation;
      remainingCommitment = Math.max(0, remainingCommitment - allocation);
      usedCommitment += allocation;
      const denom = target.planRate * target.tracked.totalUnits;
      coveredInstances.push({
        ...target.tracked.item,
        planHourlyRate: target.planRate,
        allocatedHourly: allocation,
        eligibleHourly: denom,
        allocatedCoveragePct: denom > 0 ? Math.min(100, (allocation / denom) * 100) : 0
      });
    }

    const usedForPlan = Math.max(0, entry.commitment - remainingCommitment);
    planAllocations.push({
      plan: entry.plan,
      type: entry.scope.type,
      region: entry.scope.region,
      family: entry.scope.family,
      commitment: entry.commitment,
      usedCommitment: usedForPlan,
      unusedCommitment: Math.max(0, remainingCommitment),
      eligibleHourly,
      coveragePct: eligibleHourly > 0 ? Math.min(100, (usedForPlan / eligibleHourly) * 100) : 0,
      eligibleInstancesCount: eligible.length,
      coveredInstancesCount: coveredInstances.length,
      matchedInstances: coveredInstances
    });
  }

  let appliedInstances = 0;
  for (const tracked of trackedItems) {
    const units = tracked.totalUnits || 0;
    if (!(units > 0)) continue;
    const coveredUnits = Math.max(0, units - tracked.remainingUnits);
    const pct = Math.min(100, (coveredUnits / units) * 100);
    tracked.item.spCoveragePct = pct;
    if (pct > 0) appliedInstances += 1;
  }

  return {
    plans: activePlans.length,
    totalCommitment,
    usedCommitment,
    unusedCommitment: Math.max(0, totalCommitment - usedCommitment),
    appliedInstances,
    mode: "commitment_aware_hourly",
    planAllocations
  };
}
