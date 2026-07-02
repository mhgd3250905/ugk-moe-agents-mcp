import test from "node:test";
import assert from "node:assert/strict";
import registerStatusLine from "../extensions/ui-statusline.ts";

test("status line decorates the idle ready state", async () => {
	const handlers = new Map<string, Function>();
	registerStatusLine({
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	} as any);

	const calls: Array<[string, string]> = [];
	await handlers.get("session_start")!({}, {
		ui: {
			theme: {
				fg: (_tone: string, text: string) => text,
			},
			setStatus: (slot: string, text: string) => calls.push([slot, text]),
		},
	});

	assert.deepEqual(calls, [["turn-progress", "✅ 就绪"]]);
});
