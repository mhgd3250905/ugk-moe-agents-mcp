import { Editor } from "@earendil-works/pi-tui";

const EDITOR_BORDER_PATCHED = Symbol.for("ugk.editorBorderGlyphPatch.installed");
const UGK_EDITOR_BORDER_GLYPH = "╌";

export function installUgkEditorBorderGlyphPatch(EditorClass = Editor) {
	const proto = EditorClass?.prototype;
	if (!proto || proto[EDITOR_BORDER_PATCHED] || typeof proto.render !== "function") {
		return;
	}

	const originalRender = proto.render;
	proto.render = function ugkEditorSoftBorderRender(...args) {
		const originalBorderColor = this.borderColor;
		if (typeof originalBorderColor !== "function") {
			return originalRender.apply(this, args);
		}

		this.borderColor = (text) => originalBorderColor(String(text).replaceAll("─", UGK_EDITOR_BORDER_GLYPH));
		try {
			return originalRender.apply(this, args);
		} finally {
			this.borderColor = originalBorderColor;
		}
	};

	Object.defineProperty(proto, EDITOR_BORDER_PATCHED, {
		configurable: false,
		value: true,
	});
}

export function applyUgkRuntimePolicy(env = process.env) {
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	installUgkEditorBorderGlyphPatch();
}
