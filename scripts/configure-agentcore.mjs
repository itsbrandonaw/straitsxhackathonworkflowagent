import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const agentcoreDirectory = resolve(repositoryRoot, "agentcore");
const deploymentProject = resolve(repositoryRoot, ".agentcore-project");

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith("replace-with")) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function accountId() {
  if (process.env.HAPPY_AWS_ACCOUNT_ID) return process.env.HAPPY_AWS_ACCOUNT_ID;
  try {
    return execFileSync(
      "aws",
      ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    ).trim();
  } catch {
    throw new Error("Set HAPPY_AWS_ACCOUNT_ID or configure AWS CLI credentials for aws sts get-caller-identity");
  }
}

const account = accountId();
if (!/^\d{12}$/.test(account)) throw new Error("HAPPY_AWS_ACCOUNT_ID must contain exactly 12 digits");

const region = process.env.HAPPY_AWS_REGION ?? process.env.AWS_REGION ?? "ap-southeast-1";
const executionRoleArn = required("AGENTCORE_RUNTIME_ROLE_ARN");
if (!/^arn:[^:]+:iam::\d{12}:role\/.+/.test(executionRoleArn)) {
  throw new Error("AGENTCORE_RUNTIME_ROLE_ARN must be an IAM role ARN");
}

const template = JSON.parse(await readFile(resolve(agentcoreDirectory, "agentcore.template.json"), "utf8"));
const runtime = template.runtimes[0];
runtime.executionRoleArn = executionRoleArn;
runtime.envVars = [
  { name: "AWS_REGION", value: region },
  { name: "BEDROCK_MODEL_ID", value: required("BEDROCK_MODEL_ID") },
  { name: "AGENTCORE_BROWSER_ID", value: process.env.AGENTCORE_BROWSER_ID ?? "aws.browser.v1" },
  { name: "SCOUTS_TABLE_NAME", value: required("SCOUTS_TABLE_NAME") },
  { name: "SCOUTS_SCREENSHOT_BUCKET", value: required("SCOUTS_SCREENSHOT_BUCKET") }
];
if (process.env.WEBSOCKET_MANAGEMENT_ENDPOINT) {
  runtime.envVars.push({
    name: "WEBSOCKET_MANAGEMENT_ENDPOINT",
    value: process.env.WEBSOCKET_MANAGEMENT_ENDPOINT
  });
}

const targets = [{
  name: "hackathon",
  description: "Happy Scouts hackathon deployment",
  account,
  region
}];

await rm(deploymentProject, { recursive: true, force: true });
await mkdir(resolve(deploymentProject, "agentcore"), { recursive: true });

for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "Dockerfile",
  ".dockerignore"
]) {
  await cp(resolve(repositoryRoot, file), resolve(deploymentProject, file));
}

const ignoredDirectoryNames = new Set(["node_modules", "dist", ".git", ".cli"]);
const copySourceDirectory = async (source) => cp(
  resolve(repositoryRoot, source),
  resolve(deploymentProject, source),
  {
    recursive: true,
    filter: (path) => !path.split("/").some((part) => ignoredDirectoryNames.has(part))
  }
);

await copySourceDirectory("apps/agentcore");
await copySourceDirectory("packages/aws");
await copySourceDirectory("packages/contracts");
await copySourceDirectory("packages/core");
await copySourceDirectory("packages/runtime");

await writeFile(resolve(deploymentProject, "agentcore/agentcore.json"), `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
await writeFile(resolve(deploymentProject, "agentcore/aws-targets.json"), `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o600 });

console.log(`AgentCore deployment configured for AWS account ${account} in ${region}.`);
console.log("Generated .agentcore-project/ is a gitignored deployment context with no Git history or .env files.");
