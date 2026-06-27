import { spawn } from "child_process";
import path from "path";

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;

const playwrightCli = path.join(
  process.cwd(),
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
