import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const themePath = new URL("../themes/ugk-geek.json", import.meta.url);
const darkThemePath = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url);

test("ugk geek theme is a complete pi theme with subdued neon green identity", () => {
	const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
	const darkTheme = JSON.parse(fs.readFileSync(darkThemePath, "utf8"));

	assert.equal(theme.name, "ugk-geek");
	assert.equal(theme.vars.green, "#9be564");
	assert.equal(theme.vars.bgToolSuccess, "#2f5f2a");
	assert.equal(theme.colors.accent, "green");
	assert.notEqual(theme.colors.accent, "#6f5cff");
	assert.notEqual(theme.colors.accent, "#7e57c2");

	for (const key of Object.keys(darkTheme.colors)) {
		assert.ok(key in theme.colors, `missing theme color: ${key}`);
	}
});
