import test from "node:test";
import assert from "node:assert/strict";
import { installUgkPackageUpdatePatch } from "../bin/ugk-package-update-patch.js";

test("package update patch suppresses package update notification only", () => {
	class FakeInteractiveMode {
		constructor() {
			this.calls = [];
		}

		showPackageUpdateNotification(updates) {
			this.calls.push(["package", updates]);
		}

		showNewVersionNotification(version) {
			this.calls.push(["version", version]);
			return "new-version";
		}
	}

	assert.equal(installUgkPackageUpdatePatch({ InteractiveMode: FakeInteractiveMode }), true);

	const mode = new FakeInteractiveMode();
	assert.equal(mode.showPackageUpdateNotification(["github.com/example/package"]), undefined);
	assert.deepEqual(mode.calls, []);
	assert.equal(mode.showNewVersionNotification("1.2.3"), "new-version");
	assert.deepEqual(mode.calls, [["version", "1.2.3"]]);
});

test("package update patch is idempotent", () => {
	class FakeInteractiveMode {
		showPackageUpdateNotification() {
			return "package-update";
		}
	}

	assert.equal(installUgkPackageUpdatePatch({ InteractiveMode: FakeInteractiveMode }), true);
	const patched = FakeInteractiveMode.prototype.showPackageUpdateNotification;
	assert.equal(installUgkPackageUpdatePatch({ InteractiveMode: FakeInteractiveMode }), false);
	assert.equal(FakeInteractiveMode.prototype.showPackageUpdateNotification, patched);
});

test("package update patch fails safe when pi method is missing", () => {
	class FakeInteractiveMode {}
	const originalWrite = process.stderr.write;
	const chunks = [];
	process.stderr.write = (chunk, ...args) => {
		chunks.push(String(chunk));
		const callback = args.find((arg) => typeof arg === "function");
		callback?.();
		return true;
	};
	try {
		assert.equal(installUgkPackageUpdatePatch({ InteractiveMode: FakeInteractiveMode }), false);
	} finally {
		process.stderr.write = originalWrite;
	}
	assert.match(chunks.join(""), /showPackageUpdateNotification/);
});
