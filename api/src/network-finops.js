import {
  EC2Client,
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  DescribeTransitGatewayAttachmentsCommand,
  DescribeVpcEndpointsCommand
} from "@aws-sdk/client-ec2";
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const HOURS_PER_MONTH = 730;
const BYTES_PER_GB = 1024 ** 3;

const DEFAULT_RATES = {
  natHourly: 0.045,
  natGb: 0.045,
  interfaceEndpointHourly: 0.01,
  interfaceEndpointGb: 0.01,
  gatewayLoadBalancerEndpointHourly: 0.01,
  gatewayLoadBalancerEndpointGb: 0.0035,
  transitGatewayAttachmentHourly: 0.05,
  transitGatewayGb: 0.02,
  publicIpv4Hourly: 0.005,
  albHourly: 0.0225,
  nlbHourly: 0.0225,
  gwlbHourly: 0.0125
};

const REGION_RATES = {
  "eu-west-3": {
    natHourly: 0.052,
    natGb: 0.052,
    interfaceEndpointHourly: 0.0116,
    interfaceEndpointGb: 0.01,
    gatewayLoadBalancerEndpointHourly: 0.0116,
    gatewayLoadBalancerEndpointGb: 0.0035,
    transitGatewayAttachmentHourly: 0.058,
    transitGatewayGb: 0.02,
    publicIpv4Hourly: 0.005,
    albHourly: 0.0252,
    nlbHourly: 0.0252,
    gwlbHourly: 0.014
  },
  "us-east-1": DEFAULT_RATES
};

function makeCredentials(acc) {
  if (acc && acc.credentials) return acc.credentials;
  if (acc && acc.accessKeyId && acc.secretAccessKey) {
    return {
      accessKeyId: acc.accessKeyId,
      secretAccessKey: acc.secretAccessKey,
      sessionToken: acc.sessionToken || undefined
    };
  }
  return undefined;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function roundMetric(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function ratesForRegion(region) {
  return { ...DEFAULT_RATES, ...(REGION_RATES[region] || {}) };
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function analysisWindow({ start, end, days = 30 } = {}) {
  const endDate = parseDate(end) || new Date();
  const startDate = parseDate(start) || new Date(endDate.getTime() - Math.max(1, toNumber(days, 30)) * 86400 * 1000);
  return {
    start: startDate,
    end: endDate,
    days: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000))
  };
}

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function bytesToGb(bytes) {
  return roundMetric(toNumber(bytes, 0) / BYTES_PER_GB);
}

async function mapLimit(items, limit, fn) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (idx < arr.length) {
      const current = idx;
      idx += 1;
      out[current] = await fn(arr[current], current);
    }
  });
  await Promise.all(workers);
  return out;
}

async function collectNatGateways(ec2, accountId, region) {
  const items = [];
  let NextToken;
  do {
    const out = await ec2.send(new DescribeNatGatewaysCommand({ NextToken }));
    for (const nat of out.NatGateways || []) {
      const state = String(nat.State || "").toLowerCase();
      if (state === "deleted") continue;
      items.push({
        resourceType: "nat_gateway",
        resourceId: nat.NatGatewayId || "",
        label: nat.NatGatewayId || "NAT Gateway",
        accountId,
        region,
        vpcId: nat.VpcId || "",
        subnetId: nat.SubnetId || "",
        state: nat.State || "",
        createdAt: nat.CreateTime ? new Date(nat.CreateTime).toISOString() : null,
        eipCount: Array.isArray(nat.NatGatewayAddresses) ? nat.NatGatewayAddresses.filter(a => a.AllocationId || a.PublicIp).length : 0
      });
    }
    NextToken = out.NextToken;
  } while (NextToken);
  return items;
}

async function collectVpcEndpoints(ec2, accountId, region) {
  const items = [];
  let NextToken;
  do {
    const out = await ec2.send(new DescribeVpcEndpointsCommand({ NextToken }));
    for (const endpoint of out.VpcEndpoints || []) {
      const type = String(endpoint.VpcEndpointType || "").toLowerCase();
      if (!["interface", "gatewayloadbalancer"].includes(type)) continue;
      items.push({
        resourceType: type === "gatewayloadbalancer" ? "gwlb_endpoint" : "interface_endpoint",
        resourceId: endpoint.VpcEndpointId || "",
        label: endpoint.VpcEndpointId || endpoint.ServiceName || "VPC Endpoint",
        accountId,
        region,
        vpcId: endpoint.VpcId || "",
        state: endpoint.State || "",
        serviceName: endpoint.ServiceName || "",
        subnetCount: Array.isArray(endpoint.SubnetIds) ? endpoint.SubnetIds.length : 0,
        networkInterfaceCount: Array.isArray(endpoint.NetworkInterfaceIds) ? endpoint.NetworkInterfaceIds.length : 0
      });
    }
    NextToken = out.NextToken;
  } while (NextToken);
  return items;
}

async function collectTransitGatewayAttachments(ec2, accountId, region) {
  const items = [];
  let NextToken;
  do {
    const out = await ec2.send(new DescribeTransitGatewayAttachmentsCommand({ NextToken }));
    for (const att of out.TransitGatewayAttachments || []) {
      const state = String(att.State || "").toLowerCase();
      if (state === "deleted" || state === "deleting") continue;
      items.push({
        resourceType: "tgw_attachment",
        resourceId: att.TransitGatewayAttachmentId || "",
        label: att.TransitGatewayAttachmentId || att.ResourceId || "TGW attachment",
        accountId,
        region,
        vpcId: att.ResourceType === "vpc" ? att.ResourceId || "" : "",
        state: att.State || "",
        tgwId: att.TransitGatewayId || "",
        resourceIdAttached: att.ResourceId || "",
        resourceTypeAttached: att.ResourceType || ""
      });
    }
    NextToken = out.NextToken;
  } while (NextToken);
  return items;
}

async function collectPublicIps(ec2, accountId, region) {
  const items = [];
  let NextToken;
  do {
    const out = await ec2.send(new DescribeAddressesCommand({ NextToken }));
    for (const address of out.Addresses || []) {
      const associated = !!(address.AssociationId || address.InstanceId || address.NetworkInterfaceId);
      items.push({
        resourceType: "public_ipv4",
        resourceId: address.AllocationId || address.PublicIp || "",
        label: address.PublicIp || address.AllocationId || "Public IPv4",
        accountId,
        region,
        vpcId: "",
        state: associated ? "associated" : "unassociated",
        allocationId: address.AllocationId || "",
        associationId: address.AssociationId || "",
        publicIp: address.PublicIp || "",
        instanceId: address.InstanceId || "",
        networkInterfaceId: address.NetworkInterfaceId || ""
      });
    }
    NextToken = out.NextToken;
  } while (NextToken);
  return items;
}

function loadBalancerKind(arn = "") {
  const rest = String(arn).split(":loadbalancer/")[1] || "";
  if (rest.startsWith("net/")) return "network_load_balancer";
  if (rest.startsWith("gwlb/")) return "gateway_load_balancer";
  return "application_load_balancer";
}

function loadBalancerNamespace(kind) {
  if (kind === "network_load_balancer") return "AWS/NetworkELB";
  if (kind === "gateway_load_balancer") return "AWS/GatewayELB";
  return "AWS/ApplicationELB";
}

function loadBalancerDimensionValue(arn = "") {
  return String(arn).split(":loadbalancer/")[1] || "";
}

async function collectLoadBalancers(elb, accountId, region) {
  const items = [];
  let Marker;
  do {
    const out = await elb.send(new DescribeLoadBalancersCommand({ Marker }));
    for (const lb of out.LoadBalancers || []) {
      const kind = loadBalancerKind(lb.LoadBalancerArn || "");
      items.push({
        resourceType: kind,
        resourceId: lb.LoadBalancerArn || lb.LoadBalancerName || "",
        label: lb.LoadBalancerName || lb.LoadBalancerArn || "Load Balancer",
        accountId,
        region,
        vpcId: lb.VpcId || "",
        state: lb.State?.Code || "",
        scheme: lb.Scheme || "",
        azCount: Array.isArray(lb.AvailabilityZones) ? lb.AvailabilityZones.length : 0,
        createdAt: lb.CreatedTime ? new Date(lb.CreatedTime).toISOString() : null,
        cloudwatchDimension: loadBalancerDimensionValue(lb.LoadBalancerArn || "")
      });
    }
    Marker = out.NextMarker;
  } while (Marker);
  return items;
}

async function collectInventory({ accounts = [], regions = [] }) {
  const all = [];
  for (const account of accounts) {
    for (const region of regions) {
      const accountId = account.accountId || account.id || "";
      const credentials = makeCredentials(account);
      const ec2 = new EC2Client({ region, credentials });
      const elb = new ElasticLoadBalancingV2Client({ region, credentials });
      const results = await Promise.allSettled([
        collectNatGateways(ec2, accountId, region),
        collectVpcEndpoints(ec2, accountId, region),
        collectTransitGatewayAttachments(ec2, accountId, region),
        collectPublicIps(ec2, accountId, region),
        collectLoadBalancers(elb, accountId, region)
      ]);
      for (const result of results) {
        if (result.status === "fulfilled" && Array.isArray(result.value)) all.push(...result.value);
      }
    }
  }
  return all.filter(item => item.resourceId);
}

function metricQueriesForResource(resource) {
  switch (resource.resourceType) {
    case "nat_gateway":
      return {
        namespace: "AWS/NATGateway",
        dimensions: [{ Name: "NatGatewayId", Value: resource.resourceId }],
        metrics: ["BytesInFromDestination", "BytesInFromSource", "BytesOutToDestination", "BytesOutToSource"]
      };
    case "interface_endpoint":
    case "gwlb_endpoint":
      return {
        namespace: "AWS/PrivateLinkEndpoints",
        dimensions: [
          { Name: "Endpoint Type", Value: resource.resourceType === "gwlb_endpoint" ? "GatewayLoadBalancer" : "Interface" },
          { Name: "Service Name", Value: resource.serviceName },
          { Name: "VPC Endpoint Id", Value: resource.resourceId },
          { Name: "VPC Id", Value: resource.vpcId }
        ].filter(dim => dim.Value),
        metrics: ["BytesProcessed"]
      };
    case "tgw_attachment":
      return {
        namespace: "AWS/TransitGateway",
        dimensionSets: [
          [
            { Name: "TransitGateway", Value: resource.tgwId },
            { Name: "TransitGatewayAttachment", Value: resource.resourceId }
          ].filter(dim => dim.Value),
          [
            { Name: "TransitGatewayAttachment", Value: resource.resourceId }
          ].filter(dim => dim.Value)
        ],
        metrics: ["BytesIn", "BytesOut"]
      };
    case "application_load_balancer":
    case "network_load_balancer":
    case "gateway_load_balancer":
      if (!resource.cloudwatchDimension) return null;
      return {
        namespace: loadBalancerNamespace(resource.resourceType),
        dimensions: [{ Name: "LoadBalancer", Value: resource.cloudwatchDimension }],
        metrics: ["ProcessedBytes"]
      };
    default:
      return null;
  }
}

async function readMetrics(cw, resource, window) {
  const query = metricQueriesForResource(resource);
  if (!query || !query.metrics.length) return { bytes: null, series: [] };
  const period = 86400;
  const dimensionSets = Array.isArray(query.dimensionSets) && query.dimensionSets.length
    ? query.dimensionSets
    : [query.dimensions || []];
  let emptyResult = null;
  let errorResult = null;
  for (const dimensions of dimensionSets) {
    const MetricDataQueries = query.metrics.map((metricName, idx) => ({
      Id: `m${idx}`,
      MetricStat: {
        Metric: {
          Namespace: query.namespace,
          MetricName: metricName,
          Dimensions: dimensions
        },
        Period: period,
        Stat: "Sum"
      },
      ReturnData: true
    }));
    try {
      const out = await cw.send(new GetMetricDataCommand({
        StartTime: window.start,
        EndTime: window.end,
        MetricDataQueries
      }));
      let total = 0;
      let points = 0;
      const byDay = new Map();
      for (const result of out.MetricDataResults || []) {
        const timestamps = result.Timestamps || [];
        const values = result.Values || [];
        for (let i = 0; i < timestamps.length; i += 1) {
          const value = toNumber(values[i], 0);
          points += 1;
          total += value;
          const day = isoDay(timestamps[i]);
          if (day) byDay.set(day, (byDay.get(day) || 0) + value);
        }
      }
      if (points === 0) {
        emptyResult = { bytes: null, series: [], datapoints: 0, error: "no_datapoints", dimensions };
        continue;
      }
      const series = Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, bytes]) => ({ date, bytes, gb: bytesToGb(bytes) }));
      return { bytes: total, series, datapoints: points, dimensions };
    } catch (err) {
      errorResult = { bytes: null, series: [], error: err?.message || "cloudwatch_metric_failed", dimensions };
    }
  }
  return errorResult || emptyResult || { bytes: null, series: [], datapoints: 0, error: "no_datapoints" };
}

async function attachMetrics(resources, accounts = [], window, includeMetrics = true) {
  if (!includeMetrics) return resources.map(item => ({ ...item, metricBytes: null, metricSeries: [] }));
  const accountById = new Map(accounts.map(account => [account.accountId || account.id || "", account]));
  return mapLimit(resources, 8, async (resource) => {
    if (resource.resourceType === "public_ipv4") return { ...resource, metricBytes: null, metricSeries: [] };
    const account = accountById.get(resource.accountId) || {};
    const cw = new CloudWatchClient({ region: resource.region, credentials: makeCredentials(account) });
    const metrics = await readMetrics(cw, resource, window);
    return {
      ...resource,
      metricBytes: metrics.bytes,
      metricGb: metrics.bytes == null ? null : bytesToGb(metrics.bytes),
      metricSeries: metrics.series,
      metricDatapoints: metrics.datapoints || 0,
      metricDimensions: metrics.dimensions || [],
      metricError: metrics.error || null
    };
  });
}

function fixedCostMonthly(resource, rates) {
  switch (resource.resourceType) {
    case "nat_gateway":
      return rates.natHourly * HOURS_PER_MONTH;
    case "interface_endpoint":
      return rates.interfaceEndpointHourly * HOURS_PER_MONTH * Math.max(1, toNumber(resource.subnetCount || resource.networkInterfaceCount, 1));
    case "gwlb_endpoint":
      return rates.gatewayLoadBalancerEndpointHourly * HOURS_PER_MONTH * Math.max(1, toNumber(resource.subnetCount || resource.networkInterfaceCount, 1));
    case "tgw_attachment":
      return rates.transitGatewayAttachmentHourly * HOURS_PER_MONTH;
    case "public_ipv4":
      return rates.publicIpv4Hourly * HOURS_PER_MONTH;
    case "application_load_balancer":
      return rates.albHourly * HOURS_PER_MONTH;
    case "network_load_balancer":
      return rates.nlbHourly * HOURS_PER_MONTH;
    case "gateway_load_balancer":
      return rates.gwlbHourly * HOURS_PER_MONTH;
    default:
      return 0;
  }
}

function dataRate(resource, rates) {
  switch (resource.resourceType) {
    case "nat_gateway":
      return rates.natGb;
    case "interface_endpoint":
      return rates.interfaceEndpointGb;
    case "gwlb_endpoint":
      return rates.gatewayLoadBalancerEndpointGb;
    case "tgw_attachment":
      return rates.transitGatewayGb;
    default:
      return 0;
  }
}

function resourceLabel(type) {
  return {
    nat_gateway: "NAT Gateway",
    interface_endpoint: "Endpoint Interface",
    gwlb_endpoint: "Endpoint GWLB",
    tgw_attachment: "Transit Gateway",
    public_ipv4: "IPv4 publique / EIP",
    application_load_balancer: "ALB",
    network_load_balancer: "NLB",
    gateway_load_balancer: "GWLB"
  }[type] || type;
}

function usageState(resource, totalGb) {
  if (resource.resourceType === "public_ipv4") {
    return resource.state === "unassociated"
      ? { state: "idle", label: "IP non associée", severity: "high", evidence: "DescribeAddresses: aucune association" }
      : { state: "unknown", label: "Associée, trafic non mesuré ici", severity: "medium", evidence: "DescribeAddresses: IP associée" };
  }
  if (resource.metricBytes == null) {
    const noData = resource.metricError === "no_datapoints";
    return {
      state: "unknown",
      label: noData ? "Aucun datapoint CloudWatch" : resource.metricError ? "Métriques indisponibles" : "Usage non mesuré",
      severity: "medium",
      evidence: noData ? "CloudWatch ne renvoie aucun point sur la période" : "CloudWatch non exploitable sur la période"
    };
  }
  if (totalGb <= 0.01) return { state: "idle", label: "Trafic nul/quasi nul", severity: "high", evidence: "CloudWatch datapoints présents, somme <= 0,01 GB sur la période" };
  if (totalGb < 1) return { state: "low", label: "< 1 GB observé", severity: "medium", evidence: "CloudWatch datapoints présents, trafic faible" };
  return { state: "active", label: `${totalGb.toLocaleString("fr-FR")} GB observés`, severity: "low", evidence: "CloudWatch datapoints présents" };
}

function recommendation(resource, usage, monthlyCost) {
  const costLabel = `$${monthlyCost.toFixed(2)}/mois`;
  if (resource.resourceType === "public_ipv4" && usage.state === "idle") {
    return `Candidat à libérer si cette IPv4 n'est plus réservée volontairement (${costLabel}).`;
  }
  if (usage.state === "idle") {
    return `Candidat à vérifier: coût fixe avec trafic CloudWatch nul/quasi nul sur la période (${costLabel}).`;
  }
  if (usage.state === "low") {
    return `Trafic très faible: valider le besoin ou mutualiser/remplacer (${costLabel}).`;
  }
  if (usage.state === "unknown") {
    return `Qualifier l'usage: coût fixe estimé, métriques absentes ou non collectées (${costLabel}).`;
  }
  return `Ressource active: surveiller coût et trafic (${costLabel}).`;
}

function enrichResource(resource) {
  const rates = ratesForRegion(resource.region);
  const fixedMonthly = fixedCostMonthly(resource, rates);
  const totalGb = resource.metricGb == null ? null : toNumber(resource.metricGb, 0);
  const dataMonthly = totalGb == null ? 0 : totalGb * dataRate(resource, rates);
  const monthlyCost = roundMoney(fixedMonthly + dataMonthly);
  const usage = usageState(resource, totalGb ?? 0);
  const potentialMonthlySavings = ["idle", "low"].includes(usage.state) ? monthlyCost : 0;
  return {
    ...resource,
    typeLabel: resourceLabel(resource.resourceType),
    monthlyCost,
    fixedMonthlyCost: roundMoney(fixedMonthly),
    dataMonthlyCost: roundMoney(dataMonthly),
    potentialMonthlySavings: roundMoney(potentialMonthlySavings),
    usageState: usage.state,
    usageLabel: usage.label,
    usageEvidence: usage.evidence,
    severity: usage.severity,
    recommendation: recommendation(resource, usage, monthlyCost),
    metricGb: resource.metricGb == null ? null : roundMetric(resource.metricGb),
    metricSeries: Array.isArray(resource.metricSeries) ? resource.metricSeries : []
  };
}

function summarize(items) {
  const byType = new Map();
  const byAccount = new Map();
  let totalMonthlyCost = 0;
  let potentialMonthlySavings = 0;
  let idleResources = 0;
  let unknownUsage = 0;
  for (const item of items) {
    totalMonthlyCost += toNumber(item.monthlyCost, 0);
    potentialMonthlySavings += toNumber(item.potentialMonthlySavings, 0);
    if (item.usageState === "idle") idleResources += 1;
    if (item.usageState === "unknown") unknownUsage += 1;
    const typeKey = item.resourceType;
    const type = byType.get(typeKey) || { resourceType: typeKey, typeLabel: item.typeLabel, resources: 0, monthlyCost: 0, potentialMonthlySavings: 0 };
    type.resources += 1;
    type.monthlyCost += toNumber(item.monthlyCost, 0);
    type.potentialMonthlySavings += toNumber(item.potentialMonthlySavings, 0);
    byType.set(typeKey, type);

    const accountKey = item.accountId || "unknown";
    const account = byAccount.get(accountKey) || { accountId: accountKey, resources: 0, monthlyCost: 0, potentialMonthlySavings: 0 };
    account.resources += 1;
    account.monthlyCost += toNumber(item.monthlyCost, 0);
    account.potentialMonthlySavings += toNumber(item.potentialMonthlySavings, 0);
    byAccount.set(accountKey, account);
  }
  const normalize = row => ({
    ...row,
    monthlyCost: roundMoney(row.monthlyCost),
    potentialMonthlySavings: roundMoney(row.potentialMonthlySavings)
  });
  return {
    resources: items.length,
    totalMonthlyCost: roundMoney(totalMonthlyCost),
    potentialMonthlySavings: roundMoney(potentialMonthlySavings),
    idleResources,
    unknownUsage,
    byType: Array.from(byType.values()).map(normalize).sort((a, b) => b.monthlyCost - a.monthlyCost),
    byAccount: Array.from(byAccount.values()).map(normalize).sort((a, b) => b.monthlyCost - a.monthlyCost)
  };
}

export async function getNetworkFinOps({ accounts = [], regions = [], start, end, days = 30, includeMetrics = true } = {}) {
  const window = analysisWindow({ start, end, days });
  const inventory = await collectInventory({ accounts, regions });
  const withMetrics = await attachMetrics(inventory, accounts, window, includeMetrics);
  const items = withMetrics
    .map(enrichResource)
    .sort((a, b) => {
      const sev = { high: 3, medium: 2, low: 1 };
      const diff = (sev[b.severity] || 0) - (sev[a.severity] || 0);
      if (diff) return diff;
      return toNumber(b.monthlyCost, 0) - toNumber(a.monthlyCost, 0);
    });
  const summary = summarize(items);
  return {
    generatedAt: new Date().toISOString(),
    source: includeMetrics ? "aws-live-cloudwatch" : "aws-live-inventory",
    currency: "USD",
    window: {
      start: window.start.toISOString().slice(0, 10),
      end: window.end.toISOString().slice(0, 10),
      days: window.days
    },
    pricing: {
      source: "local-estimate",
      note: "Base mensuelle estimee: heures de ressources + data processing observe quand les metriques CloudWatch sont disponibles. Hors taxes et hors data transfer inter-AZ/Internet detaille."
    },
    summary,
    items
  };
}
