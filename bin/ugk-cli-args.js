import { join } from "node:path";

export function buildUgkCliArgs(userArgs, packageRoot) {
	const extPath = join(packageRoot, "extensions", "index.ts");
	const themePath = join(packageRoot, "themes", "ugk-geek.json");
	const hasExplicitTheme = userArgs.includes("--theme") || userArgs.includes("--no-themes");

	return [
		...userArgs,
		...(hasExplicitTheme ? [] : ["--theme", themePath]),
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		extPath,
	];
}
