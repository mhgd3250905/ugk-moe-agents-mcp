import test from "node:test";
import assert from "node:assert/strict";
import { progressTextFromToolEvent } from "../extensions/subagent.ts";

test("extracts streaming tool progress text from child events", () => {
	assert.equal(
		progressTextFromToolEvent({
			type: "tool_execution_update",
			partialResult: {
				content: [{ type: "text", text: "[download]  18.4% of 394.1MiB at 5.2MiB/s ETA 01:02" }],
			},
		}),
		"[download]  18.4% of 394.1MiB at 5.2MiB/s ETA 01:02",
	);
});

test("ignores non-progress child events", () => {
	assert.equal(
		progressTextFromToolEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		}),
		undefined,
	);
});
