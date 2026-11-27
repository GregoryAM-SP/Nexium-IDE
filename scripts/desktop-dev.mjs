#!/usr/bin/env node
// `npm run desktop`: runs the desktop app against the Vite dev server on a
// port the operating system picks at random, so a second dev window, another
// project on 5173, or anything else listening locally can never collide with it.
//
// The installed app is not affected: release builds load their pages through
// Tauri's own tauri:// scheme and open no port at all.
//
// The chosen port is handed to Tauri as a config override (dev URL, the dev
// server command and the dev Content Security Policy), so tauri.conf.json stays
// untouched. Extra arguments are passed on: `npm run desktop -- --release`.
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const HOST = "127.0.0.1";

/** Asks the OS for a free port by binding to port 0, then releases it. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const port = await freePort();
const origin = `http://${HOST}:${port}`;

const override = {
  build: {
    devUrl: origin,
    beforeDevCommand: `npm run dev:desktop -- --port ${port}`,
  },
  app: {
    security: {
      devCsp: {
        "connect-src": `'self' ipc: http://ipc.localhost ws://${HOST}:${port} ${origin}`,
      },
    },
  },
};

const configPath = join(tmpdir(), `nexium-dev-${process.pid}.json`);
writeFileSync(configPath, JSON.stringify(override));
const cleanUp = () => rmSync(configPath, { force: true });

console.log(`Nexium Studio dev server on ${origin}`);

const tauri = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(
  process.execPath,
  [tauri, "dev", "--config", configPath, ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  cleanUp();
  process.exit(signal ? 1 : (code ?? 0));
});

child.on("error", (error) => {
  cleanUp();
  console.error(`Could not start the Tauri CLI: ${error.message}`);
  process.exit(1);
});
