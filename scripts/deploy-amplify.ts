import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type StringMap = Record<string, string>;

type CliOptions = {
  envFile: string;
  appId?: string;
  branch?: string;
  region?: string;
  profile?: string;
  jobType: "RELEASE" | "RETRY";
  dryRun: boolean;
  wait: boolean;
};

function usage(): string {
  return [
    "Deploy a git branch to AWS Amplify and sync env vars from a local .env file.",
    "",
    "Usage:",
    "  npm run deploy -- <branch>",
    "  npm run deploy -- <branch> --dry-run",
    "  npm run deploy -- <branch> --env-file .env.deploy",
    "  npm run deploy -- <branch> --wait      # wait for Amplify job to finish",
    "",
    "Required config (via shell env or your .env):",
    "  AMPLIFY_APP_ID=<your Amplify App ID>",
    "",
    "Optional:",
    "  AMPLIFY_REGION=us-east-1",
    "  AWS_PROFILE=yourprofile",
  ].join("\n");
}

function fail(message: string, exitCode = 1): never {
  console.error(`\n[deploy] ${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    envFile: ".env",
    jobType: "RELEASE",
    dryRun: false,
    wait: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // First positional arg is the branch name: `npm run deploy -- main`
    if (!arg.startsWith("-")) {
      if (!opts.branch) {
        opts.branch = arg;
        continue;
      }
      fail(`Unexpected extra arg: ${arg}\n\n${usage()}`, 2);
    }

    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--env-file" || arg === "-e") {
      const v = argv[++i];
      if (!v) fail("Missing value for --env-file");
      opts.envFile = v;
      continue;
    }

    if (arg === "--app-id") {
      const v = argv[++i];
      if (!v) fail("Missing value for --app-id");
      opts.appId = v;
      continue;
    }

    if (arg === "--branch") {
      const v = argv[++i];
      if (!v) fail("Missing value for --branch");
      opts.branch = v;
      continue;
    }

    if (arg === "-b") {
      const v = argv[++i];
      if (!v) fail("Missing value for -b");
      opts.branch = v;
      continue;
    }

    if (arg === "--region") {
      const v = argv[++i];
      if (!v) fail("Missing value for --region");
      opts.region = v;
      continue;
    }

    if (arg === "--profile") {
      const v = argv[++i];
      if (!v) fail("Missing value for --profile");
      opts.profile = v;
      continue;
    }

    if (arg === "--job-type") {
      const v = argv[++i];
      if (v !== "RELEASE" && v !== "RETRY") fail(`Invalid --job-type ${JSON.stringify(v)}`);
      opts.jobType = v;
      continue;
    }

    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }

    if (arg === "--wait") {
      opts.wait = true;
      continue;
    }

    fail(`Unknown arg: ${arg}\n\n${usage()}`, 2);
  }

  return opts;
}

function parseDotenv(contents: string): StringMap {
  const out: StringMap = {};

  const lines = contents.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let value = m[2] ?? "";

    // quoted
    if (value.startsWith('"')) {
      let end = -1;
      let escaped = false;
      for (let i = 1; i < value.length; i++) {
        const ch = value[i];
        if (!escaped && ch === '"') {
          end = i;
          break;
        }
        escaped = !escaped && ch === "\\";
      }
      if (end >= 0) {
        const inner = value.slice(1, end);
        value = inner
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      } else {
        // Best-effort: strip surrounding quotes if present
        value = value.replace(/^"|"$/g, "");
      }
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      if (end >= 0) value = value.slice(1, end);
      else value = value.replace(/^'|'$/g, "");
    } else {
      // unquoted: strip trailing comment if it begins after whitespace
      const hash = value.indexOf("#");
      if (hash >= 0) {
        const before = value.slice(0, hash);
        if (/\s$/.test(before)) value = before.trimEnd();
      }
      value = value.trim();
    }

    out[key] = value;
  }

  return out;
}

function tryGetGitBranch(): string | undefined {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return undefined;

  const branch = (res.stdout || "").trim();
  if (!branch || branch === "HEAD") return undefined;
  return branch;
}

function awsCli(
  globalArgs: string[],
  amplifyArgs: string[],
  mode: "pipe" | "inherit" = "inherit",
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("aws", [...globalArgs, "amplify", ...amplifyArgs], {
    encoding: "utf8",
    stdio: mode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AWS_PAGER: "",
    },
  });

  if ((res as any).error?.code === "ENOENT") {
    fail('AWS CLI not found. Install it (or ensure `aws` is in PATH) and try again.');
  }

  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const envFilePath = resolve(process.cwd(), opts.envFile);
  let fileEnv: StringMap = {};
  try {
    const envContents = readFileSync(envFilePath, "utf8");
    fileEnv = parseDotenv(envContents);
  } catch (e: any) {
    fail(
      `Could not read ${opts.envFile} at ${envFilePath}.\n` +
        `Create it first (see README/deployment-plan) or pass --env-file <path>.`,
    );
  }

  const appId = opts.appId || process.env.AMPLIFY_APP_ID || fileEnv.AMPLIFY_APP_ID;
  if (!appId) {
    fail(
      "Missing AMPLIFY_APP_ID.\n" +
        "Set it in your shell (`export AMPLIFY_APP_ID=...`) or add it to your .env.",
    );
  }

  const branch = opts.branch;
  if (!branch) fail("Missing required arg: --branch <name>\n\n" + usage(), 2);

  const region =
    opts.region || process.env.AMPLIFY_REGION || fileEnv.AMPLIFY_REGION || process.env.AWS_REGION;
  const profile = opts.profile || process.env.AWS_PROFILE || fileEnv.AWS_PROFILE;

  const awsGlobalArgs: string[] = [];
  if (profile) awsGlobalArgs.push("--profile", profile);
  if (region) awsGlobalArgs.push("--region", region);
  awsGlobalArgs.push("--no-cli-pager");

  const reservedKeys = new Set([
    "AMPLIFY_APP_ID",
    "AMPLIFY_BRANCH",
    "AMPLIFY_REGION",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ]);

  const envToApply: StringMap = {};
  for (const [k, v] of Object.entries(fileEnv)) {
    if (reservedKeys.has(k)) continue;
    envToApply[k] = v;
  }

  const keys = Object.keys(envToApply).sort();
  if (keys.length === 0) {
    fail(
      `No env vars found to apply from ${opts.envFile}.\n` +
        "Add some vars (e.g. VITE_*) or remove reserved-only entries.",
    );
  }

  console.log(`[deploy] Amplify app: ${appId}`);
  console.log(`[deploy] Branch:     ${branch}`);
  if (region) console.log(`[deploy] Region:     ${region}`);
  if (profile) console.log(`[deploy] Profile:    ${profile}`);
  console.log(`[deploy] Env file:    ${envFilePath}`);
  console.log(`[deploy] Vars:        ${keys.length}`);

  if (opts.dryRun) {
    console.log("\n[deploy] --dry-run: would apply env vars:");
    for (const k of keys) console.log(`- ${k}`);
    return;
  }

  const update = awsCli(awsGlobalArgs, [
    "update-branch",
    "--app-id",
    appId,
    "--branch-name",
    branch,
    "--environment-variables",
    JSON.stringify(envToApply),
    "--output",
    "json",
  ]);
  if (update.status !== 0) {
    fail("Failed to update branch env vars (aws amplify update-branch).");
  }

  const start = awsCli(
    awsGlobalArgs,
    [
      "start-job",
      "--app-id",
      appId,
      "--branch-name",
      branch,
      "--job-type",
      opts.jobType,
      "--output",
      "json",
    ],
    "pipe",
  );
  if (start.status !== 0) {
    fail("Failed to start Amplify job (aws amplify start-job).");
  }

  let jobId: string | undefined;
  try {
    const payload = JSON.parse(start.stdout);
    jobId = payload?.jobSummary?.jobId || payload?.jobSummary?.jobId;
  } catch {
    // ignore
  }

  console.log(start.stdout.trim() ? `\n${start.stdout.trim()}\n` : "");

  if (!jobId) {
    console.log("[deploy] Started job (jobId not parsed).");
    console.log("[deploy] Tip: re-run with --wait to poll status.");
    return;
  }

  console.log(`[deploy] Started job: ${jobId}`);

  if (!opts.wait) {
    console.log("[deploy] Tip: re-run with --wait to poll status until completion.");
    return;
  }

  console.log("[deploy] Waiting for job to finish...");
  const pollEveryMs = 10_000;
  const maxMs = 30 * 60_000;
  const startAt = Date.now();

  while (true) {
    if (Date.now() - startAt > maxMs) {
      fail(`Timed out waiting for job ${jobId} after ${Math.round(maxMs / 60_000)} minutes.`);
    }

    const job = awsCli(
      awsGlobalArgs,
      [
        "get-job",
        "--app-id",
        appId,
        "--branch-name",
        branch,
        "--job-id",
        jobId,
        "--output",
        "json",
      ],
      "pipe",
    );
    if (job.status !== 0) {
      fail("Failed to poll job status (aws amplify get-job).");
    }

    let status = "UNKNOWN";
    try {
      const payload = JSON.parse(job.stdout);
      status = payload?.job?.summary?.status || payload?.jobSummary?.status || status;
    } catch {
      // ignore
    }

    console.log(`[deploy] Job status: ${status}`);
    if (status === "SUCCEED" || status === "SUCCEEDED") return;
    if (status === "FAILED" || status === "CANCELLED") process.exit(1);

    await sleep(pollEveryMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


