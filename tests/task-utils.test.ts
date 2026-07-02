import test from "node:test";
import assert from "node:assert/strict";
import { isPlanningAllowedCommand, isSafeCommand } from "../extensions/task/task-utils.ts";

test("isPlanningAllowedCommand allows exploratory commands under C-3", () => {
	assert.equal(isPlanningAllowedCommand("node build.js"), true);
	assert.equal(isPlanningAllowedCommand("npm test"), true);
	assert.equal(isPlanningAllowedCommand("npm run lint"), true);
	assert.equal(isPlanningAllowedCommand("python parse.py"), true);
	assert.equal(isPlanningAllowedCommand("cat data.json | node -e \"\""), true);
	assert.equal(isPlanningAllowedCommand("grep foo README.md"), true);
	assert.equal(isPlanningAllowedCommand("git status"), true);
});

test("isPlanningAllowedCommand blocks side-effecting commands under C-3", () => {
	assert.equal(isPlanningAllowedCommand("npm install"), false);
	assert.equal(isPlanningAllowedCommand("git commit -m x"), false);
	assert.equal(isPlanningAllowedCommand("echo x > out.txt"), false);
	assert.equal(isPlanningAllowedCommand("rm file.txt"), false);
	assert.equal(isPlanningAllowedCommand("mkdir foo"), false);
	assert.equal(isPlanningAllowedCommand("wget https://x.com/a"), false);
	assert.equal(isPlanningAllowedCommand("node build.js > out.log"), false);
});

test("isSafeCommand keeps original C-1 read-only semantics", () => {
	assert.equal(isSafeCommand("node build.js"), false);
	assert.equal(isSafeCommand("git status"), true);
});
