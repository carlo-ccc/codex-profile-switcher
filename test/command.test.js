import test from "node:test";
import assert from "node:assert/strict";
import { nonInteractiveProcessOptions } from "../src/core/command.js";

test("non-interactive background commands always hide Windows console windows", () => {
  assert.deepEqual(nonInteractiveProcessOptions(), { windowsHide: true });
  assert.deepEqual(nonInteractiveProcessOptions({ encoding: "utf8" }), {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(nonInteractiveProcessOptions({ windowsHide: false }).windowsHide, true);
});
