import { spawnSync } from "node:child_process";

type CliOptions = {
  branch?: string;
  region?: string;
  profile?: string;
  jobType: "RELEASE" | "RETRY";
  dryRun: boolean;
  wait: boolean;
};

const AMPLIFY_APP_ID = "d1oxj81ums9kuf";

function usage(): string {
  return [
    "Trigger a build/deploy for a git branch in AWS Amplify.",
    "",
    "Usage:",
    "  npm run deploy -- <branch>",
    "  npm run deploy -- <branch> --dry-run",
    "  npm run deploy -- <branch> --wait      # wait for Amplify job to finish",
    "",
    "Optional:",
    "  AWS_PROFILE=yourprofile",
    "  AMPLIFY_REGION=us-east-1",
  ].join("\n");
}

function fail(message: string, exitCode = 1): never {
  console.error(`\n[deploy] ${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
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

  const branch = opts.branch;
  if (!branch) fail("Missing required arg: --branch <name>\n\n" + usage(), 2);

  const region =
    opts.region || process.env.AMPLIFY_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const profile = opts.profile || process.env.AWS_PROFILE;

  const awsGlobalArgs: string[] = [];
  if (profile) awsGlobalArgs.push("--profile", profile);
  if (region) awsGlobalArgs.push("--region", region);
  awsGlobalArgs.push("--no-cli-pager");

  console.log(`[deploy] Amplify app: ${AMPLIFY_APP_ID}`);
  console.log(`[deploy] Branch:     ${branch}`);
  if (region) console.log(`[deploy] Region:     ${region}`);
  if (profile) console.log(`[deploy] Profile:    ${profile}`);

  if (opts.dryRun) {
    console.log("\n[deploy] --dry-run: would start Amplify job.");
    return;
  }

  const start = awsCli(
    awsGlobalArgs,
    [
      "start-job",
      "--app-id",
      AMPLIFY_APP_ID,
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
    jobId = payload?.jobSummary?.jobId;
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
        AMPLIFY_APP_ID,
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


