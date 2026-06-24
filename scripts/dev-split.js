const { spawn } = require("child_process");

const children = [];
let isShuttingDown = false;

function run(label, entry) {
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    shell: false
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (isShuttingDown) {
      return;
    }

    const detail = signal
      ? `signal ${signal}`
      : `code ${code ?? 0}`;
    console.error(`[dev-split] ${label} exited with ${detail}`);
    shutdown(code || 1);
  });
}

function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("collector", "collector.js");
run("api", "api.js");
