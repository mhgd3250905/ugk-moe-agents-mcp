const PATCHED = Symbol.for("ugk.extensionOverlayPatch.installed");

function wrapOverlayMethod(proto, name) {
	const original = proto[name];
	if (typeof original !== "function") {
		return false;
	}
	proto[name] = function ugkExtensionOverlayWithoutWorkingSpinner(...args) {
		const wasWorkingVisible = this.workingVisible === true && typeof this.setWorkingVisible === "function";
		if (wasWorkingVisible) this.setWorkingVisible(false);
		try {
			return Promise.resolve(original.apply(this, args)).finally(() => {
				if (wasWorkingVisible) this.setWorkingVisible(true);
			});
		} catch (error) {
			if (wasWorkingVisible) this.setWorkingVisible(true);
			throw error;
		}
	};
	return true;
}

export function installUgkExtensionOverlayPatch({ InteractiveMode } = {}) {
	const proto = InteractiveMode?.prototype;
	if (!proto || proto[PATCHED]) {
		return false;
	}

	const patched = [
		wrapOverlayMethod(proto, "showExtensionSelector"),
		wrapOverlayMethod(proto, "showExtensionInput"),
		wrapOverlayMethod(proto, "showExtensionEditor"),
	];
	if (!patched.some(Boolean)) {
		return false;
	}

	Object.defineProperty(proto, PATCHED, {
		configurable: false,
		value: true,
	});
	return true;
}
