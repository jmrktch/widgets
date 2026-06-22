const { spawn } = require("child_process");

const children = [];

function run(label, entry) {
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    shell: false
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[dev-split] ${label} exited with code ${code}`);
    }
  });
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("collector", "collector.js");
run("api", "api.js");
