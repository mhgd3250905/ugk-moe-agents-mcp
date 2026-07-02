import type { ChromeCdpStatus, ChromeTab } from "./client.ts";
import { renderTerminalTable } from "../terminal-table.ts";
import { uiText } from "../shared/ui-language.ts";

export function formatChromeTabs(tabs: ChromeTab[]): string {
	const rows = tabs.length
		? tabs.map((tab, index) => [`${index + 1}`, tab.id, tab.title || uiText("(无标题)", "(untitled)"), tab.url || "about:blank"])
		: [["📭", "-", uiText("未找到 Chrome 页面标签页。", "No Chrome page tabs found."), "-"]];
	return [uiText("🌐 Chrome 标签页", "🌐 Chrome Tabs"), "", renderTerminalTable(uiText(["#", "ID", "标题", "URL"], ["#", "ID", "Title", "URL"]), rows)].join("\n");
}

export function formatChromeCdpStatus(status: ChromeCdpStatus): string {
	if (!status.online) {
		const rows = [["⚠️", `127.0.0.1:${status.port}`, uiText("无法连接", "Not reachable"), "0"]];
		rows.push(["↳", uiText("错误", "Error"), status.error || uiText("连接失败", "Connection failed"), ""]);
		return ["🌐 Chrome CDP", "", renderTerminalTable(uiText(["状态", "地址", "连接", "页面"], ["Status", "Address", "Connection", "Pages"]), rows)].join("\n");
	}
	return [
		"🌐 Chrome CDP",
		"",
		renderTerminalTable(uiText(["状态", "地址", "连接", "页面"], ["Status", "Address", "Connection", "Pages"]), [["✅", `127.0.0.1:${status.port}`, uiText("在线", "Online"), `${status.tabs?.length ?? 0}`]]),
	].join("\n");
}
