import { execSync } from "node:child_process";

export interface DeviceEnvDeps {
	exec?: (command: string) => string;
}

function getExec(deps?: DeviceEnvDeps): (command: string) => string {
	return deps?.exec ?? ((command) => execSync(command, { encoding: "utf8", stdio: "ignore", timeout: 8000 }) as string);
}

/**
 * Resolve the ugk/pi command used to spawn child agent processes.
 * Prefer ugk when installed globally; fall back to pi for older dev environments.
 */
export function getUgkBin(deps?: DeviceEnvDeps): string {
	const exec = getExec(deps);
	try {
		exec("ugk --version");
		return "ugk";
	} catch {
		return "pi";
	}
}
