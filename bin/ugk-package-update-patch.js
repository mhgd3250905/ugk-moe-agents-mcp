const PATCHED = Symbol.for("ugk.packageUpdatePatch.installed");

export function installUgkPackageUpdatePatch({ InteractiveMode } = {}) {
	const proto = InteractiveMode?.prototype;
	if (!proto || proto[PATCHED]) {
		return false;
	}

	if (typeof proto.showPackageUpdateNotification !== "function") {
		console.error("ugk: pi package update notification patch skipped; showPackageUpdateNotification is unavailable.");
		return false;
	}

	proto.showPackageUpdateNotification = function showUgkSuppressedPackageUpdateNotification() {};

	Object.defineProperty(proto, PATCHED, {
		configurable: false,
		value: true,
	});
	return true;
}
