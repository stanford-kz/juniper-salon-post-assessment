import { connect } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { Connection } from "@temporalio/client";

const compose = spawnSync("docker", ["compose", "up", "-d", "temporal"], {
  stdio: "inherit",
});
if (compose.status !== 0) {
  console.error("\nCould not start Temporal. Is Docker Desktop running?");
  process.exit(compose.status ?? 1);
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Temporal did not become ready on port ${port}.`);
}

await waitForPort(7233);
// A listening TCP socket does not guarantee Temporal is ready for requests.
const connection = await Connection.connect({ address: "127.0.0.1:7233" });
await connection.workflowService.getSystemInfo({});
await connection.close();
const children = [
  spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { stdio: "inherit" }),
  spawn(process.execPath, ["--import", "tsx", "src/api.ts"], { stdio: "inherit" }),
];
let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const stopped = children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  }));
  await Promise.race([
    Promise.all(stopped),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const child of children) {
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`A development process stopped (${signal ?? code}).`);
      shutdown(code ?? 1);
    }
  });
}
console.log("\nJuniper Salon is launching (local prototype):");
console.log("  App:         http://localhost:3000");
console.log("  Temporal UI: http://localhost:8233\n");
