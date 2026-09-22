#!/usr/bin/env node
import { runEntrypoint } from "./run-entrypoint.js";

const relayMode = process.argv[2] === "relay";
await runEntrypoint(
  relayMode ? "../src/relay-cli.ts" : "../src/cli.ts",
  relayMode ? "../dist/relay-cli.js" : "../dist/cli.js",
);
