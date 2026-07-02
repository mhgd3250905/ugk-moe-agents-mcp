import test from "node:test";
import assert from "node:assert/strict";
import { installUgkExtensionOverlayPatch } from "../bin/ugk-extension-overlay-patch.js";

test("extension overlay patch hides working spinner while overlay promise is open", async () => {
	let resolveInput: (value: string) => void = () => {};
	class FakeInteractiveMode {
		workingVisible = true;
		calls: boolean[] = [];

		setWorkingVisible(value: boolean) {
			this.workingVisible = value;
			this.calls.push(value);
		}

		showExtensionInput() {
			return new Promise<string>((resolve) => {
				resolveInput = resolve;
			});
		}
	}

	assert.equal(installUgkExtensionOverlayPatch({ InteractiveMode: FakeInteractiveMode }), true);
	const mode = new FakeInteractiveMode();
	const promise = mode.showExtensionInput();
	assert.deepEqual(mode.calls, [false]);

	resolveInput("ok");
	assert.equal(await promise, "ok");
	assert.deepEqual(mode.calls, [false, true]);
});

test("extension overlay patch is idempotent and leaves hidden spinner hidden", async () => {
	class FakeInteractiveMode {
		workingVisible = false;
		calls: boolean[] = [];

		setWorkingVisible(value: boolean) {
			this.calls.push(value);
		}

		showExtensionSelector() {
			return Promise.resolve("selected");
		}
	}

	assert.equal(installUgkExtensionOverlayPatch({ InteractiveMode: FakeInteractiveMode }), true);
	assert.equal(installUgkExtensionOverlayPatch({ InteractiveMode: FakeInteractiveMode }), false);
	const mode = new FakeInteractiveMode();
	assert.equal(await mode.showExtensionSelector(), "selected");
	assert.deepEqual(mode.calls, []);
});
