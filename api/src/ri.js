import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeReservedInstancesCommand
} from "@aws-sdk/client-ec2";

function toNumber(value, fallback = 0){
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeRecurringCharges(list = []){
  if (!Array.isArray(list)) return [];
  return list
    .map(item => ({
      amount: toNumber(item?.Amount ?? item?.amount),
      frequency: String(item?.Frequency ?? item?.frequency ?? "").trim()
    }))
    .filter(rc => Number.isFinite(rc.amount) && (rc.amount !== 0 || rc.frequency));
}

function computeRecurringHourly(recurringCharges = []){
  if (!Array.isArray(recurringCharges)) return 0;
  return recurringCharges.reduce((sum, rc) => sum + toHourlyCharge(rc.amount, rc.frequency), 0);
}

function toHourlyCharge(amount, frequency){
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const normalized = String(frequency || "").trim().toLowerCase();
  switch (normalized) {
    case "hourly":
      return amount;
    case "daily":
      return amount / 24;
    case "weekly":
      return amount / (24 * 7);
    case "monthly":
      return amount / (24 * 30);
    case "annually":
    case "annual":
    case "yearly":
      return amount / (24 * 365);
    default:
      return 0;
  }
}

function parseRegions(){
  const s = process.env.EC2_REGIONS || process.env.AWS_REGION || "us-east-1";
  return String(s).split(",").map(t => t.trim()).filter(Boolean);
}

function makeCredentials(acc){
  if (acc && acc.credentials) return acc.credentials;
  if (acc && acc.accessKeyId && acc.secretAccessKey){
    return { accessKeyId: acc.accessKeyId, secretAccessKey: acc.secretAccessKey, sessionToken: acc.sessionToken || undefined };
  }
  return undefined;
}

function getInstanceTagValue(inst = {}, key){
  if (!inst || !key) return undefined;
  const { tagMap } = inst;
  if (tagMap && Object.prototype.hasOwnProperty.call(tagMap, key)){
    return tagMap[key];
  }
  const lowerKey = String(key).toLowerCase();
  if (tagMap && Object.prototype.hasOwnProperty.call(tagMap, lowerKey)){
    return tagMap[lowerKey];
  }
  if (Array.isArray(inst.tags)){
    const found = inst.tags.find(tag => {
      const tagKey = String(tag?.key ?? tag?.Key ?? "");
      if (!tagKey) return false;
      if (tagKey === key) return true;
      return tagKey.toLowerCase() === lowerKey;
    });
    if (found){
      return found.value ?? found.Value;
    }
  }
  return undefined;
}

function instanceHasScheduledTag(inst = {}){
  const value = getInstanceTagValue(inst, "Scheduled_vle");
  if (value !== undefined && value !== null) return true;
  const alt = getInstanceTagValue(inst, "Scheduled_VLE");
  return alt !== undefined && alt !== null;
}

function normalizeAwsTags(tags = []){
  if (!Array.isArray(tags)) return { tags: [], tagMap: {} };
  const normalized = tags
    .map(tag => {
      const rawValue = tag?.Value ?? tag?.value ?? "";
      return {
        key: String(tag?.Key ?? tag?.key ?? ""),
        value: rawValue === undefined || rawValue === null ? "" : String(rawValue)
      };
    })
    .filter(tag => tag.key);
  const tagMap = {};
  for (const tag of normalized){
    tagMap[tag.key] = tag.value;
    const lowerKey = tag.key.toLowerCase();
    if (!(lowerKey in tagMap)){
      tagMap[lowerKey] = tag.value;
    }
  }
  return { tags: normalized, tagMap };
}

export async function listInstances({ accounts = [], regions = parseRegions() }){
  const all = [];
  for (const acct of accounts){
    for (const region of regions){
      let client;
      try {
        client = new EC2Client({ region, credentials: makeCredentials(acct) });
      } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await client.send(new DescribeInstancesCommand({ NextToken }));
          for (const r of (out.Reservations || [])){
            for (const i of (r.Instances || [])){
              const tags = Array.isArray(i.Tags)
                ? i.Tags
                    .map(tag => ({
                      key: String(tag?.Key ?? ""),
                      value: tag?.Value === undefined || tag?.Value === null ? "" : String(tag.Value)
                    }))
                    .filter(tag => tag.key)
                : [];
              const tagMap = {};
              for (const tag of tags){
                tagMap[tag.key] = tag.value;
                const lowerKey = tag.key.toLowerCase();
                if (!(lowerKey in tagMap)){
                  tagMap[lowerKey] = tag.value;
                }
              }
              const name = tags.find(t => t.key === "Name")?.value || "";
              all.push({
                accountId: acct.accountId,
                instanceId: i.InstanceId,
                name,
                type: i.InstanceType,
                instanceType: i.InstanceType,
                platform: i.PlatformDetails || i.Platform || "Linux/UNIX",
                az: i.Placement?.AvailabilityZone || "",
                tenancy: i.Placement?.Tenancy || "",
                privateIp: i.PrivateIpAddress || "",
                publicIp: i.PublicIpAddress || "",
                launchTime: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : "",
                state: i.State?.Name || "",
                vpcId: i.VpcId || "",
                subnetId: i.SubnetId || "",
                securityGroups: Array.isArray(i.SecurityGroups)
                  ? i.SecurityGroups.map(g => ({
                      id: g.GroupId || "",
                      name: g.GroupName || ""
                    })).filter(g => g.id || g.name)
                  : [],
                region,
                tags,
                tagMap
              });
            }
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch (e) {
        // swallow per account/region; can log if needed
      }
    }
  }
  return all;
}

export async function listVolumes({ accounts = [], regions = parseRegions() }){
  const all = [];
  for (const acct of accounts){
    for (const region of regions){
      let client;
      try { client = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await client.send(new DescribeVolumesCommand({ NextToken }));
          for (const v of (out.Volumes || [])){
            const { tags, tagMap } = normalizeAwsTags(v.Tags);
            all.push({ accountId: acct.accountId, volumeId: v.VolumeId, attachments: (v.Attachments||[]).map(a=>({ instanceId: a.InstanceId, device: a.Device, state: a.State })),
              sizeGiB: v.Size,
              type: v.VolumeType,
              volumeType: v.VolumeType,
              state: v.State,
              az: v.AvailabilityZone,
              availabilityZone: v.AvailabilityZone,
              iops: v.Iops,
              throughput: v.Throughput,
              encrypted: v.Encrypted,
              multiAttachEnabled: v.MultiAttachEnabled,
              name: tagMap.Name || tagMap.name || "",
              tags,
              tagMap,
              createTime: v.CreateTime ? new Date(v.CreateTime).toISOString() : "",
              region
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch (e) {}
    }
  }
  return all;
}

export async function listReservedInstances({ accounts = [], regions = parseRegions() }){
  const rows = [];
  for (const acct of accounts){
    for (const region of regions){
      let client;
      try { client = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await client.send(new DescribeReservedInstancesCommand({ NextToken }));
          for (const ri of (out.ReservedInstances || [])){
            const state = String(ri.State || "").trim().toLowerCase();
            if (state && state !== "active") continue;
            const instanceCount = toNumber(ri.InstanceCount ?? ri.instanceCount, 0);
            const fixedPrice = toNumber(ri.FixedPrice ?? ri.fixedPrice);
            const usagePrice = toNumber(ri.UsagePrice ?? ri.usagePrice);
            const duration = toNumber(ri.Duration ?? ri.duration, 0);
            const currencyCode = String(ri.CurrencyCode ?? ri.currencyCode ?? "").trim().toUpperCase() || "USD";
            const offeringType = ri.OfferingType ?? ri.offeringType ?? "";
            const recurringCharges = normalizeRecurringCharges(ri.RecurringCharges ?? ri.recurringCharges);
            const recurringHourly = computeRecurringHourly(recurringCharges);
            const durationHours = duration > 0 ? duration / 3600 : 0;
            const baseFactor = getNormalizationFactor(ri.InstanceType || ri.instanceType || "");
            const normalizedTotalUnits = baseFactor > 0 ? baseFactor * Math.max(1, instanceCount || 0) : Math.max(1, instanceCount || 0);
            const totalFixedPrice = fixedPrice * Math.max(1, instanceCount || 0);
            const totalUsageHourly = usagePrice * Math.max(1, instanceCount || 0);
            const totalRecurringHourly = recurringHourly * Math.max(1, instanceCount || 0);
            const effectiveHourlyRate = usagePrice + recurringHourly + (durationHours > 0 ? fixedPrice / durationHours : 0);
            const effectiveHourlyRateTotal = totalUsageHourly + totalRecurringHourly + (durationHours > 0 ? totalFixedPrice / durationHours : 0);
            const effectiveHourlyRatePerNormalizedUnit = normalizedTotalUnits > 0 ? effectiveHourlyRateTotal / normalizedTotalUnits : 0;
            rows.push({
              accountId: acct.accountId,
              reservedInstancesId: ri.ReservedInstancesId,
              instanceType: ri.InstanceType,
              scope: ri.Scope || "",
              availabilityZone: ri.AvailabilityZone || "",
              productDescription: ri.ProductDescription || "",
              instanceCount,
              instanceTenancy: ri.InstanceTenancy || "",
              start: ri.Start ? new Date(ri.Start).toISOString() : "",
              end: ri.End ? new Date(ri.End).toISOString() : "",
              state: ri.State || "",
              offeringClass: ri.OfferingClass || "",
              offeringType,
              duration,
              durationHours,
              fixedPrice,
              usagePrice,
              currencyCode,
              recurringCharges,
              recurringHourly,
              totalRecurringHourly,
              effectiveHourlyRate,
              effectiveHourlyRateTotal,
              effectiveHourlyRatePerNormalizedUnit,
              region
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch (e) {}
    }
  }
  return rows;
}

const NORMALIZATION_FACTORS = {
  "nano": 0.25,
  "micro": 0.5,
  "small": 1,
  "medium": 2,
  "large": 4,
  "xlarge": 8,
  "2xlarge": 16,
  "3xlarge": 24,
  "4xlarge": 32,
  "6xlarge": 48,
  "8xlarge": 64,
  "9xlarge": 72,
  "10xlarge": 80,
  "12xlarge": 96,
  "16xlarge": 128,
  "18xlarge": 144,
  "24xlarge": 192,
  "32xlarge": 256,
  "metal": 128
};

function getInstanceSize(instanceType = ""){
  const parts = String(instanceType || "").split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function getInstanceFamily(instanceType = ""){
  const parts = String(instanceType || "").split(".");
  return parts.length ? parts[0] : "";
}

function getNormalizationFactor(instanceType = ""){
  const size = getInstanceSize(instanceType);
  if (!size) return 0;
  return NORMALIZATION_FACTORS[size] || 0;
}

function normalizePlatform(value){
  const v = String(value || "").toLowerCase();
  if (!v) return "";
  if (v.includes("windows")) return "windows";
  if (v.includes("suse")) return "suse";
  if (v.includes("red hat") || v.includes("rhel")) return "rhel";
  if (v.includes("linux") || v.includes("unix")) return "linux";
  return v;
}

function parseBoolean(value, fallback){
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

const SHARE_RI_ACROSS_ACCOUNTS = parseBoolean(process.env.RI_SHARE_ACROSS_ACCOUNTS, true);

function getReservationInstanceType(reservation = {}){
  return reservation.instanceType || reservation.InstanceType || "";
}

function getInstanceType(inst = {}){
  return inst.instanceType || inst.type || "";
}

function analyzeSizeFlexibility(reservation = {}){
  const scopeRaw = String(reservation.scope || reservation.Scope || "").toLowerCase();
  const scopeOk = scopeRaw === "region";

  const platformRaw = reservation.productDescription || reservation.ProductDescription;
  const normalizedPlatform = normalizePlatform(platformRaw);
  const platformOk = !normalizedPlatform || normalizedPlatform === "linux";

  const tenancyRaw = String(reservation.instanceTenancy || reservation.InstanceTenancy || "").toLowerCase();
  const tenancyOk = !tenancyRaw || tenancyRaw === "default";

  const instanceType = getReservationInstanceType(reservation);
  const normalizationFactor = getNormalizationFactor(instanceType);
  const normalizationOk = normalizationFactor > 0;

  const flexible = scopeOk && platformOk && tenancyOk && normalizationOk;
  const reasons = [];
  if (!scopeOk) reasons.push("scope");
  if (!platformOk) reasons.push("platform");
  if (!tenancyOk) reasons.push("tenancy");
  if (!normalizationOk) reasons.push("instanceType");

  return {
    flexible,
    reasons,
    detail: {
      scope: scopeOk,
      platform: platformOk,
      tenancy: tenancyOk,
      normalization: normalizationOk,
      normalizationFactor,
      normalizedPlatform,
      scopeRaw,
      tenancyRaw
    }
  };
}

function basicReservationMatch(instance, reservation){
  if (!reservation || !instance) return false;
  const sameAccount = String(instance.accountId || "") === String(reservation.accountId || "");
  if (!sameAccount && !SHARE_RI_ACROSS_ACCOUNTS) return false;

  const scope = String(reservation.scope || reservation.Scope || "").toLowerCase();
  if (scope === "availability zone"){
    const riAz = reservation.availabilityZone || reservation.AvailabilityZone || "";
    if (!riAz) return false;
    const instAz = instance.az || instance.availabilityZone || instance.AvailabilityZone || "";
    if (String(instAz || "") !== String(riAz || "")) return false;
  } else {
    const instRegion = instance.region || instance.Region || "";
    const riRegion = reservation.region || reservation.Region || "";
    if (instRegion && riRegion && String(instRegion || "") !== String(riRegion || "")) return false;
  }

  const instPlat = normalizePlatform(instance.platform || instance.Platform || instance.platformDetails || instance.PlatformDetails);
  const riPlat = normalizePlatform(reservation.productDescription || reservation.ProductDescription);
  if (instPlat && riPlat && instPlat !== riPlat){
    return false;
  }
  return true;
}

function instanceMatchesReservation(instance, reservation){
  if (!basicReservationMatch(instance, reservation)) return false;
  const instType = getInstanceType(instance);
  const riType = getReservationInstanceType(reservation);
  if (!instType || !riType) return false;
  return instType === riType;
}

function summarizeInstance(inst = {}){
  return {
    accountId: inst.accountId || "",
    instanceId: inst.instanceId || inst.id || "",
    name: inst.name || "",
    instanceType: inst.instanceType || inst.type || "",
    platform: inst.platform || "",
    az: inst.az || inst.availabilityZone || "",
    region: inst.region || "",
    state: inst.state || inst.State || ""
  };
}

export function matchInstancesAndReservations(instances = [], reservations = []){
  const instList = Array.isArray(instances) ? instances.map(inst => ({ ...inst })) : [];
  const resPool = Array.isArray(reservations)
    ? reservations.map(ri => {
        const instanceType = getReservationInstanceType(ri);
        const instanceCount = Number(ri.instanceCount ?? ri.InstanceCount ?? 0);
        const baseFactor = getNormalizationFactor(instanceType);
        const normalizedTotal = baseFactor > 0 ? baseFactor * instanceCount : instanceCount;
        const sizeFlexAnalysis = analyzeSizeFlexibility(ri);
        const sizeFlexible = !!(sizeFlexAnalysis && sizeFlexAnalysis.flexible && baseFactor > 0);
        const fixedPrice = toNumber(ri.fixedPrice ?? ri.FixedPrice);
        const usagePrice = toNumber(ri.usagePrice ?? ri.UsagePrice);
        const durationSeconds = toNumber(ri.duration ?? ri.Duration, 0);
        const durationHours = durationSeconds > 0 ? durationSeconds / 3600 : 0;
        const currencyCode = String(ri.currencyCode ?? ri.CurrencyCode ?? "").trim().toUpperCase() || "USD";
        const offeringType = ri.offeringType ?? ri.OfferingType ?? "";
        const recurringCharges = normalizeRecurringCharges(ri.recurringCharges ?? ri.RecurringCharges);
        const recurringHourly = computeRecurringHourly(recurringCharges);
        const totalInstanceCount = Math.max(1, instanceCount || 0);
        const normalizedCapacity = normalizedTotal > 0 ? normalizedTotal : totalInstanceCount * (baseFactor > 0 ? baseFactor : 1);
        const totalFixedPrice = fixedPrice * totalInstanceCount;
        const totalUsageHourly = usagePrice * totalInstanceCount;
        const totalRecurringHourly = recurringHourly * totalInstanceCount;
        const effectiveHourlyRate = usagePrice + recurringHourly + (durationHours > 0 ? fixedPrice / durationHours : 0);
        const effectiveHourlyRateTotal = totalUsageHourly + totalRecurringHourly + (durationHours > 0 ? totalFixedPrice / durationHours : 0);
        const effectiveHourlyRatePerNormalizedUnit = normalizedCapacity > 0 ? effectiveHourlyRateTotal / normalizedCapacity : 0;
        return {
          ...ri,
          instanceType,
          instanceCount,
          remaining: instanceCount,
          matchedInstances: [],
          fixedPrice,
          usagePrice,
          duration: durationSeconds,
          durationHours,
          currencyCode,
          offeringType,
          recurringCharges,
          recurringHourly,
          totalRecurringHourly,
          effectiveHourlyRate,
          effectiveHourlyRateTotal,
          effectiveHourlyRatePerNormalizedUnit,
          __baseFactor: baseFactor,
          __sizeFlexible: sizeFlexible,
          __sizeFlexAnalysis: sizeFlexAnalysis,
          __normalizedTotal: normalizedTotal,
          __normalizedRemaining: normalizedTotal,
          __normalizedUsed: 0,
          __normalizedCapacity: normalizedCapacity,
          __totalFixedPrice: totalFixedPrice,
          __totalUsageHourly: totalUsageHourly,
          __recurringHourly: recurringHourly,
          __totalRecurringHourly: totalRecurringHourly
        };
      })
    : [];

  function isInstanceRunning(inst){
    const rawState = inst?.state ?? inst?.State ?? inst?.instanceState;
    if (rawState === undefined || rawState === null) return true;
    const normalized = String(rawState).trim().toLowerCase();
    if (!normalized) return true;
    return normalized === "running";
  }

  const instancesWithCoverage = instList.map(inst => {
    if (instanceHasScheduledTag(inst)){
      return { ...inst, riCovered: false, riCoverage: null };
    }
    if (!isInstanceRunning(inst)){
      return { ...inst, riCovered: false, riCoverage: null };
    }
    const match = resPool.find(ri => {
      if (ri.__sizeFlexible){
        if (!basicReservationMatch(inst, ri)) return false;
        const instType = getInstanceType(inst);
        const instFamily = getInstanceFamily(instType);
        const riFamily = getInstanceFamily(ri.instanceType || "");
        if (!instFamily || !riFamily || instFamily !== riFamily) return false;
        const instFactor = getNormalizationFactor(instType);
        const factorToUse = instFactor > 0 ? instFactor : ri.__baseFactor;
        if (!(factorToUse > 0)) return false;
        return (ri.__normalizedRemaining ?? 0) >= (factorToUse - 1e-9);
      }
      if (!ri.remaining || ri.remaining <= 0) return false;
      return instanceMatchesReservation(inst, ri);
    });
    if (match){
      const summary = summarizeInstance(inst);
      match.matchedInstances.push(summary);
      let normalizedUnitsUsed = 0;
      if (match.__sizeFlexible){
        const instType = getInstanceType(inst);
        const instFactor = getNormalizationFactor(instType);
        const factorToUse = instFactor > 0 ? instFactor : match.__baseFactor;
        if (factorToUse > 0){
          normalizedUnitsUsed = factorToUse;
          match.__normalizedRemaining = Math.max(0, (match.__normalizedRemaining ?? 0) - factorToUse);
          match.__normalizedUsed = (match.__normalizedTotal ?? 0) - (match.__normalizedRemaining ?? 0);
          if (match.__baseFactor > 0){
            match.remaining = Math.max(0, match.__normalizedRemaining / match.__baseFactor);
          }
        } else {
          normalizedUnitsUsed = 1;
          match.remaining = Math.max(0, (match.remaining || 0) - 1);
        }
      } else {
        match.remaining = Math.max(0, (match.remaining || 0) - 1);
        const decrement = match.__baseFactor > 0 ? match.__baseFactor : 1;
        normalizedUnitsUsed = decrement;
        match.__normalizedRemaining = Math.max(0, (match.__normalizedRemaining ?? 0) - decrement);
        match.__normalizedUsed = (match.__normalizedTotal ?? 0) - (match.__normalizedRemaining ?? 0);
      }
      if (!(normalizedUnitsUsed > 0)){
        const fallbackUnits = match.__baseFactor > 0 ? match.__baseFactor : 1;
        normalizedUnitsUsed = fallbackUnits;
      }
      const normalizedTotalUnits = match.__normalizedCapacity ?? match.__normalizedTotal ?? 0;
      const totalFixedPrice = match.__totalFixedPrice ?? (match.fixedPrice * Math.max(1, match.instanceCount || 0));
      const totalUsageHourly = match.__totalUsageHourly ?? (match.usagePrice * Math.max(1, match.instanceCount || 0));
      const recurringHourly = match.__recurringHourly ?? match.recurringHourly ?? computeRecurringHourly(match.recurringCharges);
      const totalRecurringHourly = match.__totalRecurringHourly ?? (recurringHourly * Math.max(1, match.instanceCount || 0));
      const durationHours = match.durationHours ?? (match.duration > 0 ? match.duration / 3600 : 0);
      const baseFactor = match.__baseFactor > 0 ? match.__baseFactor : 1;
      const usageRatePerNormalizedUnit = baseFactor > 0 ? (match.usagePrice / baseFactor) : match.usagePrice;
      const recurringRatePerNormalizedUnit = baseFactor > 0 ? (recurringHourly / baseFactor) : recurringHourly;
      const effectiveUsagePortion = usageRatePerNormalizedUnit * normalizedUnitsUsed;
      const effectiveRecurringPortion = recurringRatePerNormalizedUnit * normalizedUnitsUsed;
      const normalizedShare = normalizedTotalUnits > 0 ? (normalizedUnitsUsed / normalizedTotalUnits) : 0;
      const effectiveFixedPortion = durationHours > 0 ? (totalFixedPrice * normalizedShare) / durationHours : 0;
      const effectiveHourlyRate = effectiveUsagePortion + effectiveRecurringPortion + effectiveFixedPortion;
      return {
        ...inst,
        riCovered: true,
        riCoverage: {
          reservedInstancesId: match.reservedInstancesId,
          scope: match.scope,
          availabilityZone: match.availabilityZone,
          end: match.end,
          productDescription: match.productDescription,
          offeringClass: match.offeringClass,
          offeringType: match.offeringType,
          fixedPrice: match.fixedPrice,
          usagePrice: match.usagePrice,
          currencyCode: match.currencyCode,
          duration: match.duration,
          durationHours,
          recurringCharges: match.recurringCharges,
          recurringHourly,
          totalRecurringHourly,
          effectiveHourlyRate,
          effectiveHourlyRateUsagePortion: effectiveUsagePortion,
          effectiveHourlyRateRecurringPortion: effectiveRecurringPortion,
          effectiveHourlyRateFixedPortion: effectiveFixedPortion,
          normalizedUnitsUsed,
          normalizedTotalUnits
        }
      };
    }
    return { ...inst, riCovered: false, riCoverage: null };
  });

  const reservationsWithMatches = resPool.map(ri => {
    const {
      remaining,
      matchedInstances,
      __normalizedTotal,
      __normalizedRemaining,
      __normalizedUsed,
      __normalizedCapacity,
      __totalFixedPrice,
      __totalUsageHourly,
      __recurringHourly,
      __totalRecurringHourly,
      __baseFactor,
      __sizeFlexible,
      __sizeFlexAnalysis,
      ...rest
    } = ri;
    const matchedList = Array.isArray(matchedInstances) ? matchedInstances : [];
    const baseFactor = __baseFactor || getNormalizationFactor(rest.instanceType || rest.InstanceType || "");
    const normalizedTotal = Number.isFinite(__normalizedTotal) ? __normalizedTotal : baseFactor * Number(rest.instanceCount || rest.InstanceCount || 0);
    const normalizedUsed = Number.isFinite(__normalizedUsed) ? __normalizedUsed : matchedList.length * (baseFactor > 0 ? baseFactor : 1);
    const normalizedRemaining = Number.isFinite(__normalizedRemaining) ? Math.max(0, __normalizedRemaining) : Math.max(0, normalizedTotal - normalizedUsed);
    const effectiveTotalCount = baseFactor > 0 ? normalizedTotal / baseFactor : Number(rest.instanceCount || rest.InstanceCount || 0);
    const effectiveUsedCount = baseFactor > 0 ? normalizedUsed / baseFactor : matchedList.length;
    const effectiveUnusedCount = baseFactor > 0 ? normalizedRemaining / baseFactor : Math.max(0, effectiveTotalCount - effectiveUsedCount);
    const sizeFlexAnalysis = __sizeFlexAnalysis || analyzeSizeFlexibility(rest);
    const durationSeconds = toNumber(rest.duration ?? rest.Duration, 0);
    const durationHours = durationSeconds > 0 ? durationSeconds / 3600 : 0;
    const fixedPrice = toNumber(rest.fixedPrice ?? rest.FixedPrice);
    const usagePrice = toNumber(rest.usagePrice ?? rest.UsagePrice);
    const instanceCount = Number(rest.instanceCount ?? rest.InstanceCount ?? 0);
    const totalInstanceCount = Math.max(1, instanceCount || 0);
    const totalFixedPrice = __totalFixedPrice ?? (fixedPrice * totalInstanceCount);
    const totalUsageHourly = __totalUsageHourly ?? (usagePrice * totalInstanceCount);
    const recurringChargesRaw = rest.recurringCharges ?? rest.RecurringCharges ?? [];
    const recurringCharges = Array.isArray(rest.recurringCharges)
      ? rest.recurringCharges
      : normalizeRecurringCharges(recurringChargesRaw);
    const recurringHourly = Number.isFinite(__recurringHourly) ? __recurringHourly : computeRecurringHourly(recurringCharges);
    const totalRecurringHourly = Number.isFinite(__totalRecurringHourly)
      ? __totalRecurringHourly
      : (recurringHourly * totalInstanceCount);
    const effectiveHourlyRate = usagePrice + recurringHourly + (durationHours > 0 ? fixedPrice / durationHours : 0);
    const effectiveHourlyRateTotal = totalUsageHourly + totalRecurringHourly + (durationHours > 0 ? totalFixedPrice / durationHours : 0);
    const normalizedCapacity = __normalizedCapacity ?? (normalizedTotal > 0 ? normalizedTotal : totalInstanceCount * (baseFactor > 0 ? baseFactor : 1));
    const effectiveHourlyRatePerNormalizedUnit = normalizedCapacity > 0 ? effectiveHourlyRateTotal / normalizedCapacity : 0;
    return {
      ...rest,
      matchedInstances: matchedList,
      usedCount: effectiveUsedCount,
      unusedCount: effectiveUnusedCount,
      effectiveTotalCount,
      effectiveUsedCount,
      effectiveUnusedCount,
      normalizedTotalUnits: normalizedTotal,
      normalizedUsedUnits: normalizedUsed,
      normalizedUnusedUnits: normalizedRemaining,
      instanceNormalizationFactor: baseFactor,
      sizeFlexible: !!(__sizeFlexible || (sizeFlexAnalysis && sizeFlexAnalysis.flexible)),
      sizeFlexibility: sizeFlexAnalysis,
      duration: durationSeconds,
      durationHours,
      fixedPrice,
      usagePrice,
      currencyCode: String(rest.currencyCode ?? rest.CurrencyCode ?? "").trim().toUpperCase() || "USD",
      offeringType: rest.offeringType || rest.OfferingType || "",
      recurringCharges,
      recurringHourly,
      totalRecurringHourly,
      effectiveHourlyRate,
      effectiveHourlyRateTotal,
      effectiveHourlyRatePerNormalizedUnit
    };
  });

  const uncoveredInstances = instancesWithCoverage
    .filter(inst => !inst.riCovered)
    .map(inst => summarizeInstance(inst));

  return { instancesWithCoverage, reservationsWithMatches, uncoveredInstances };
}

export function attachRiCoverageToInstances(instances = [], reservations = []){
  if (!Array.isArray(instances)) return [];
  const { instancesWithCoverage } = matchInstancesAndReservations(instances, Array.isArray(reservations) ? reservations : []);
  return instancesWithCoverage;
}
