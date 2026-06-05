
import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeAddressesCommand,
  DescribeNetworkAclsCommand,
  DescribeInternetGatewaysCommand,
  DescribeFlowLogsCommand,
  DescribeTransitGatewaysCommand,
  DescribeTransitGatewayAttachmentsCommand,
  DescribeVpcPeeringConnectionsCommand,
} from "@aws-sdk/client-ec2";
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";

function makeCredentials(acct){
  if (acct && acct.accessKeyId && acct.secretAccessKey){
    return { accessKeyId: acct.accessKeyId, secretAccessKey: acct.secretAccessKey, sessionToken: acct.sessionToken || undefined };
  }
  return undefined; // fall back to default provider chain
}

function uniq(arr){ return Array.from(new Set(arr)); }
function safe(v){ return (v===undefined || v===null) ? '' : v; }

export async function listVpcs({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let ec2;
      try { ec2 = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await ec2.send(new DescribeVpcsCommand({ NextToken }));
          const vpcs = out.Vpcs || [];
          for (const v of vpcs){
            items.push({
              accountId: acct.accountId,
              region,
              vpcId: v.VpcId,
              cidr: (v.CidrBlockAssociationSet && v.CidrBlockAssociationSet.length ? v.CidrBlockAssociationSet[0].CidrBlock : v.CidrBlock) || "",
              isDefault: !!v.IsDefault,
              tags: (v.Tags||[]).reduce((m,t)=>{ if(t.Key) m[t.Key]=t.Value||''; return m; }, {}),
              subnetsCount: 0,
              natCount: 0,
              endpoints: { interface: 0, gateway: 0 },
              flowLogsEnabled: false,
              igwAttached: false,
              naclCount: 0,
              eipCount: 0
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch (e) {
        // ignore
      }
      // Post-process counts per VPC
      const byVpc = new Map(items.filter(x=>x.region===region && x.accountId===acct.accountId).map(x=>[x.vpcId,x]));
      // Subnets
      try {
        let NextToken2;
        do {
          const out2 = await ec2.send(new DescribeSubnetsCommand({ NextToken: NextToken2 }));
          for (const s of (out2.Subnets||[])){
            const row = byVpc.get(s.VpcId); if (row) row.subnetsCount += 1;
          }
          NextToken2 = out2.NextToken;
        } while (NextToken2);
      } catch {}
// Internet Gateways
try {
  let NextTokenIGW;
  do {
    const outIGW = await ec2.send(new DescribeInternetGatewaysCommand({ NextToken: NextTokenIGW }));
    for (const igw of (outIGW.InternetGateways||[])){
      for (const att of (igw.Attachments||[])){
        const row = byVpc.get(att.VpcId || '');
        if (row) row.igwAttached = true;
      }
    }
    NextTokenIGW = outIGW.NextToken;
  } while (NextTokenIGW);
} catch {}

      // NAT
      try {
        let NextToken3;
        do {
          const out3 = await ec2.send(new DescribeNatGatewaysCommand({ NextToken: NextToken3 }));
          for (const ngw of (out3.NatGateways||[])){
            const row = byVpc.get(ngw.VpcId || (ngw.SubnetId ? null : null));
            if (row && ngw.State !== 'deleted') {
              row.natCount += 1;
              const eips = (ngw.NatGatewayAddresses||[]).filter(a=>a.AllocationId||a.PublicIp);
              if (!row._eipSeenKeys) row._eipSeenKeys = new Set();
              for (const eip of eips){
                const key = eip.AllocationId || (eip.PublicIp ? `ip:${eip.PublicIp}` : null);
                if (!key || row._eipSeenKeys.has(key)) continue;
                row._eipSeenKeys.add(key);
                row.eipCount = (row.eipCount||0) + 1;
              }
            }
          }
          NextToken3 = out3.NextToken;
        } while (NextToken3);
      } catch {}
      // Elastic IPs -> count per VPC using ENI mapping
      try {
        let NextTokenAddr;
        const eniIds = new Set();
        const eniToEipKeys = new Map();
        do {
          const outA = await ec2.send(new DescribeAddressesCommand({ NextToken: NextTokenAddr }));
          for (const a of (outA.Addresses||[])){
            if (!a.NetworkInterfaceId) continue;
            eniIds.add(a.NetworkInterfaceId);
            const key = a.AllocationId || (a.PublicIp ? `ip:${a.PublicIp}` : (a.AssociationId ? `assoc:${a.AssociationId}` : null));
            if (!key) continue;
            if (!eniToEipKeys.has(a.NetworkInterfaceId)) eniToEipKeys.set(a.NetworkInterfaceId, new Set());
            eniToEipKeys.get(a.NetworkInterfaceId).add(key);
          }
          NextTokenAddr = outA.NextToken;
        } while (NextTokenAddr);
        const ids = Array.from(eniIds);
        for (let i = 0; i < ids.length; i += 100){
          const batch = ids.slice(i, i+100);
          try {
            const outEni = await ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: batch }));
            for (const ni of (outEni.NetworkInterfaces||[])){
              const row = byVpc.get(ni.VpcId || '');
              if (!row) continue;
              if (!row._eipSeenKeys) row._eipSeenKeys = new Set();
              const keys = eniToEipKeys.get(ni.NetworkInterfaceId) || new Set([`eni:${ni.NetworkInterfaceId}`]);
              for (const key of keys){
                if (row._eipSeenKeys.has(key)) continue;
                row._eipSeenKeys.add(key);
                row.eipCount = (row.eipCount||0) + 1;
              }
            }
          } catch {}
        }
      } catch {}

      // VPC endpoints
      try {
        let NextToken4;
        do {
          const out4 = await ec2.send(new DescribeVpcEndpointsCommand({ NextToken: NextToken4 }));
          for (const ep of (out4.VpcEndpoints||[])){
            const row = byVpc.get(ep.VpcId);
            if (row){
              if (String(ep.VpcEndpointType||'').toLowerCase()==='interface') row.endpoints.interface += 1;
              else if (String(ep.VpcEndpointType||'').toLowerCase()==='gateway') row.endpoints.gateway += 1;
            }
          }
          NextToken4 = out4.NextToken;
        } while (NextToken4);
      } catch {}
      // Flow logs
      try {
        let NextToken5;
        do {
          const out5 = await ec2.send(new DescribeFlowLogsCommand({ NextToken: NextToken5 }));
          for (const fl of (out5.FlowLogs||[])){
            const id = fl.ResourceId || '';
            const row = byVpc.get(id);
            if (row) row.flowLogsEnabled = true;
          }
          NextToken5 = out5.NextToken;
        } while (NextToken5);
      } catch {}
      // Network ACLs
      try {
        let NextTokenNA;
        do {
          const outNA = await ec2.send(new DescribeNetworkAclsCommand({ NextToken: NextTokenNA }));
          for (const acl of (outNA.NetworkAcls||[])){
            const row = byVpc.get(acl.VpcId || '');
            if (row) row.naclCount = (row.naclCount||0) + 1;
          }
          NextTokenNA = outNA.NextToken;
        } while (NextTokenNA);
      } catch {}

      for (const row of byVpc.values()){
        if (row && row._eipSeenKeys) delete row._eipSeenKeys;
      }

    }
  }
  return items;
}

export async function listLoadBalancers({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let elb;
      try { elb = new ElasticLoadBalancingV2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let Marker;
      try {
        do {
          const out = await elb.send(new DescribeLoadBalancersCommand({ Marker }));
          for (const lb of (out.LoadBalancers || [])){
            // Derive type from ARN prefix: app/..., net/..., gwlb/...
            let type = 'ALB';
            const arn = lb.LoadBalancerArn || '';
            if (arn.includes(':loadbalancer/')){
              const rest = arn.split(':loadbalancer/')[1] || '';
              if (rest.startsWith('net/')) type = 'NLB';
              else if (rest.startsWith('gwlb/')) type = 'GWLB';
              else if (rest.startsWith('app/')) type = 'ALB';
            }
            items.push({
              accountId: acct.accountId,
              region,
              name: lb.LoadBalancerName,
              arn,
              type,
              scheme: lb.Scheme || '',
              vpcId: lb.VpcId || '',
              azCount: Array.isArray(lb.AvailabilityZones) ? lb.AvailabilityZones.length : 0,
              state: lb.State?.Code || '',
              createdTime: lb.CreatedTime ? new Date(lb.CreatedTime).toISOString() : ''
            });
          }
          Marker = out.NextMarker;
        } while (Marker);
      } catch (e) {
        // ignore
      }
// Network ACLs
try {
  let NextTokenNA;
  do {
    const outNA = await ec2.send(new DescribeNetworkAclsCommand({ NextToken: NextTokenNA }));
    for (const acl of (outNA.NetworkAcls||[])){
      const row = byVpc.get(acl.VpcId || '');
      if (row) row.naclCount = (row.naclCount||0) + 1;
    }
    NextTokenNA = outNA.NextToken;
  } while (NextTokenNA);
} catch {}

    }
  }
  return items;
}

export async function listTransitGatewayAttachments({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let ec2;
      try { ec2 = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await ec2.send(new DescribeTransitGatewayAttachmentsCommand({ NextToken }));
          for (const a of (out.TransitGatewayAttachments||[])){
            items.push({
              accountId: acct.accountId,
              region,
              tgwId: a.TransitGatewayId || '',
              attachmentId: a.TransitGatewayAttachmentId || '',
              resourceType: a.ResourceType || '',
              resourceId: a.ResourceId || '',
              state: a.State || ''
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch {}
// Network ACLs
try {
  let NextTokenNA;
  do {
    const outNA = await ec2.send(new DescribeNetworkAclsCommand({ NextToken: NextTokenNA }));
    for (const acl of (outNA.NetworkAcls||[])){
      const row = byVpc.get(acl.VpcId || '');
      if (row) row.naclCount = (row.naclCount||0) + 1;
    }
    NextTokenNA = outNA.NextToken;
  } while (NextTokenNA);
} catch {}

    }
  }
  return items;
}

export async function listVpcPeeringConnections({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let ec2;
      try { ec2 = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await ec2.send(new DescribeVpcPeeringConnectionsCommand({ NextToken }));
          for (const p of (out.VpcPeeringConnections || [])){
            items.push({
              accountId: acct.accountId,
              region,
              peeringId: p.VpcPeeringConnectionId || '',
              status: p.Status?.Code || '',
              requesterVpcId: p.RequesterVpcInfo?.VpcId || '',
              accepterVpcId: p.AccepterVpcInfo?.VpcId || ''
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch {}
// Network ACLs
try {
  let NextTokenNA;
  do {
    const outNA = await ec2.send(new DescribeNetworkAclsCommand({ NextToken: NextTokenNA }));
    for (const acl of (outNA.NetworkAcls||[])){
      const row = byVpc.get(acl.VpcId || '');
      if (row) row.naclCount = (row.naclCount||0) + 1;
    }
    NextTokenNA = outNA.NextToken;
  } while (NextTokenNA);
} catch {}

    }
  }
  return items;
}

export async function listVpcEndpoints({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let ec2;
      try { ec2 = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await ec2.send(new DescribeVpcEndpointsCommand({ NextToken }));
          for (const ep of (out.VpcEndpoints || [])){
            items.push({
              accountId: acct.accountId,
              region,
              vpcId: ep.VpcId || '',
              endpointId: ep.VpcEndpointId || '',
              type: String(ep.VpcEndpointType||'').toLowerCase(),
              serviceName: ep.ServiceName || '',
              state: ep.State || ''
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch {}
// Network ACLs
try {
  let NextTokenNA;
  do {
    const outNA = await ec2.send(new DescribeNetworkAclsCommand({ NextToken: NextTokenNA }));
    for (const acl of (outNA.NetworkAcls||[])){
      const row = byVpc.get(acl.VpcId || '');
      if (row) row.naclCount = (row.naclCount||0) + 1;
    }
    NextTokenNA = outNA.NextToken;
  } while (NextTokenNA);
} catch {}

    }
  }
  return items;
}

export async function listNatGateways({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let ec2;
      try { ec2 = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await ec2.send(new DescribeNatGatewaysCommand({ NextToken }));
          for (const ngw of (out.NatGateways || [])){
            items.push({
              accountId: acct.accountId,
              region,
              natGatewayId: ngw.NatGatewayId || '',
              vpcId: ngw.VpcId || '',
              subnetId: ngw.SubnetId || '',
              state: ngw.State || ''
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch {}
// Network ACLs
try {
  let NextTokenNA;
  do {
    const outNA = await ec2.send(new DescribeNetworkAclsCommand({ NextToken: NextTokenNA }));
    for (const acl of (outNA.NetworkAcls||[])){
      const row = byVpc.get(acl.VpcId || '');
      if (row) row.naclCount = (row.naclCount||0) + 1;
    }
    NextTokenNA = outNA.NextToken;
  } while (NextTokenNA);
} catch {}

    }
  }
  return items;
}

export async function listNetworkInterfaces({ accounts = [], regions = [] }){
  const items = [];
  for (const acct of accounts){
    for (const region of regions){
      let ec2;
      try { ec2 = new EC2Client({ region, credentials: makeCredentials(acct) }); } catch { continue; }
      let NextToken;
      try {
        do {
          const out = await ec2.send(new DescribeNetworkInterfacesCommand({ NextToken }));
          for (const ni of (out.NetworkInterfaces || [])){
            const privateIps = Array.isArray(ni.PrivateIpAddresses)
              ? ni.PrivateIpAddresses.map(p => ({
                  address: p.PrivateIpAddress || '',
                  primary: !!p.Primary,
                  publicIp: p.Association?.PublicIp || '',
                  allocationId: p.Association?.AllocationId || ''
                }))
              : [];
            const securityGroups = Array.isArray(ni.Groups)
              ? ni.Groups.map(g => ({ id: g.GroupId || '', name: g.GroupName || '' }))
              : [];
            const attachment = ni.Attachment
              ? {
                  instanceId: ni.Attachment.InstanceId || '',
                  status: ni.Attachment.Status || '',
                  ownerId: ni.Attachment.InstanceOwnerId || '',
                  deviceIndex: ni.Attachment.DeviceIndex,
                  attachmentId: ni.Attachment.AttachmentId || ''
                }
              : null;
            items.push({
              accountId: acct.accountId,
              region,
              networkInterfaceId: ni.NetworkInterfaceId || '',
              vpcId: ni.VpcId || '',
              subnetId: ni.SubnetId || '',
              type: ni.InterfaceType || '',
              status: ni.Status || '',
              description: ni.Description || '',
              privateIps,
              ipv6Addresses: Array.isArray(ni.Ipv6Addresses)
                ? ni.Ipv6Addresses.map(ip => ip.Ipv6Address || '').filter(Boolean)
                : [],
              securityGroups,
              attachment
            });
          }
          NextToken = out.NextToken;
        } while (NextToken);
      } catch (e) {
        // ignore errors per account/region when listing interfaces
      }
    }
  }
  return items;
}

export function buildNetworkFindings({ vpcs = [], endpoints = [] }){
  const findings = [];
  for (const v of vpcs){
    if (!v.flowLogsEnabled){
      findings.push({
        severity: 'medium',
        kind: 'flow_logs_off',
        accountId: v.accountId,
        region: v.region,
        vpcId: v.vpcId,
        message: `Flow Logs désactivés sur ${v.vpcId}`
      });
    }
    // Check for S3/DynamoDB gateway endpoints absence
    const eps = endpoints.filter(ep => ep.accountId===v.accountId && ep.region===v.region && ep.vpcId===v.vpcId);
    const hasS3Gateway = eps.some(ep => ep.type==='gateway' && /(\.|:)?s3(\.|:)/i.test(ep.serviceName||''));
    const hasDdbGateway = eps.some(ep => ep.type==='gateway' && /dynamodb/i.test(ep.serviceName||''));
    if (!hasS3Gateway){
      findings.push({
        severity: 'low',
        kind: 'no_s3_gateway_endpoint',
        accountId: v.accountId, region: v.region, vpcId: v.vpcId,
        message: `Pas d'endpoint Gateway S3 sur ${v.vpcId}`
      });
    }
    if (!hasDdbGateway){
      findings.push({
        severity: 'low',
        kind: 'no_dynamodb_gateway_endpoint',
        accountId: v.accountId, region: v.region, vpcId: v.vpcId,
        message: `Pas d'endpoint Gateway DynamoDB sur ${v.vpcId}`
      });
    }
    if (v.natCount>0 && !hasS3Gateway){
      findings.push({
        severity: 'high',
        kind: 'nat_may_carry_s3',
        accountId: v.accountId, region: v.region, vpcId: v.vpcId,
        message: `NAT présent sans endpoint S3: risque de coûts NAT inutiles`
      });
    }
  }
  return findings;
}
