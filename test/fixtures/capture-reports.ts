import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startTestHttpServer } from "../integration/http-server.js";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const fixtureDirectory = fileURLToPath(
  new URL("./workspace/example/", import.meta.url),
);
const reportsDirectory = fileURLToPath(new URL("./reports/", import.meta.url));
const projectDirectory = resolve(fixtureDirectory, "../../../..");
const bruEntryPoint = join(
  projectDirectory,
  "node_modules",
  "@usebruno",
  "cli",
  "bin",
  "bru.js",
);

function runBru(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [bruEntryPoint, ...args], {
      cwd: fixtureDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ exitCode: code ?? 255, stdout, stderr });
    });
  });
}

function canonicalizeFixturePaths(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFixturePaths);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "suitename" && typeof child === "string") {
        const relativeName = child
          .slice(fixtureDirectory.length)
          .replaceAll("\\", "/");
        return [key, `<fixture>/${relativeName}`];
      }
      return [key, canonicalizeFixturePaths(child)];
    }),
  );
}

async function captureReport(
  requestPath: string,
  outputName: string,
  expectedExitCode: number,
  temporaryDirectory: string,
): Promise<void> {
  const temporaryReport = join(temporaryDirectory, outputName);
  const result = await runBru([
    "run",
    requestPath,
    "--env",
    "Local",
    "--reporter-json",
    temporaryReport,
  ]);

  if (result.exitCode !== expectedExitCode) {
    throw new Error(
      `${requestPath} exited ${result.exitCode}, expected ${expectedExitCode}.\n${result.stderr}`,
    );
  }

  const report = JSON.parse(await readFile(temporaryReport, "utf8")) as unknown;
  const canonicalReport = canonicalizeFixturePaths(report);
  await writeFile(
    join(reportsDirectory, outputName),
    `${JSON.stringify(canonicalReport, null, 2)}\n`,
    "utf8",
  );
}

async function captureUnavailableReport(temporaryDirectory: string): Promise<void> {
  const temporaryReport = join(temporaryDirectory, "reporter-unavailable.json");
  const result = await runBru([
    "run",
    "Health.yml",
    "--env",
    "DoesNotExist",
    "--reporter-json",
    temporaryReport,
  ]);

  if (result.exitCode !== 6) {
    throw new Error(
      `Missing environment exited ${result.exitCode}, expected 6.\n${result.stderr}`,
    );
  }

  let reportAvailable = true;
  try {
    await readFile(temporaryReport, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      reportAvailable = false;
    } else {
      throw error;
    }
  }

  const capture = {
    scenario: "missing environment",
    cliVersion: "4.0.0",
    exitCode: result.exitCode,
    reportAvailable,
    stderr: result.stderr.trim(),
  };
  await writeFile(
    join(reportsDirectory, "reporter-unavailable.json"),
    `${JSON.stringify(capture, null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  await mkdir(reportsDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "bruno-captures-"));
  const server = await startTestHttpServer({ port: 4015 });

  try {
    await captureReport("Health.yml", "success.json", 0, temporaryDirectory);
    await captureReport(
      "Failure.yml",
      "failed-assertion.json",
      1,
      temporaryDirectory,
    );
    await captureUnavailableReport(temporaryDirectory);
  } finally {
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
