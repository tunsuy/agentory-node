import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli.js";

test("version exits 0", async () => {
  const code = await runCli(["node", "cli.js", "version"]);
  assert.equal(code, 0);
});
