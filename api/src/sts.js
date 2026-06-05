import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { EC2Client } from "@aws-sdk/client-ec2";
import fs from "fs/promises";

export async function getBaseAccountId(region){
  try {
    const sts = new STSClient({ region });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    return id?.Account;
  } catch { return undefined; }
}

export async function loadAccountsConfig(){
  try {
    const txt = await fs.readFile("/app/src/accounts-config.json", "utf8");
    const json = JSON.parse(txt); 
    return json || {};
  } catch { return {}; }
}

export async function ec2ClientFromStatic({ accessKeyId, secretAccessKey, sessionToken, region }){
  return new EC2Client({ 
    region, 
    credentials: { accessKeyId, secretAccessKey, sessionToken }
  });
}

export async function ec2ClientFromRole({ roleArn, externalId, region }){
  const sts = new STSClient({ region });
  const out = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn, RoleSessionName: "costwatch-session",
    ExternalId: externalId || undefined, DurationSeconds: 3600
  }));
  const creds = {
    accessKeyId: out.Credentials.AccessKeyId,
    secretAccessKey: out.Credentials.SecretAccessKey,
    sessionToken: out.Credentials.SessionToken
  };
  return new EC2Client({ region, credentials: creds });
}
