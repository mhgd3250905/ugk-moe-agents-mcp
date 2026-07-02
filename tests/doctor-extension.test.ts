import test from "node:test";
import assert from "node:assert/strict";
import { registerDoctor } from "../extensions/doctor/index.ts";

function makePi() {
	const commands = new Map<string, any>();
	return {
		commands,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		},
	};
}

function makeCtx() {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		},
	};
}

test("registerDoctor registers /doctor command", () => {
	const { pi, commands } = makePi();
	registerDoctor(pi as any);
	assert.ok(commands.has("doctor"));
	assert.match(commands.get("doctor").description, /environment/i);
});

test("/doctor shows the guided environment migration notice", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	registerDoctor(pi as any);

	await assert.doesNotReject(() => commands.get("doctor").handler("", ctx));

	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /UGK Environment Doctor/);
	assert.match(notifications[0], /ask the agent/i);
	assert.match(notifications[0], /bash unavailable/i);
	assert.match(notifications[0], /Chrome CDP/i);
});
