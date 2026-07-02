import { visibleWidth } from "@earendil-works/pi-tui";

export function padEndVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function tableRule(left: string, middle: string, right: string, widths: number[]): string {
	return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function tableRow(cells: readonly string[], widths: number[]): string {
	return `│ ${widths.map((width, index) => padEndVisible(cells[index] ?? "", width)).join(" │ ")} │`;
}

export function renderTerminalTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const normalizedRows = rows.map((row) => headers.map((_, index) => row[index] ?? ""));
	const widths = headers.map((heading, index) =>
		Math.max(visibleWidth(heading), ...normalizedRows.map((row) => visibleWidth(row[index] ?? ""))),
	);

	return [
		tableRule("┌", "┬", "┐", widths),
		tableRow(headers, widths),
		tableRule("├", "┼", "┤", widths),
		...normalizedRows.map((row) => tableRow(row, widths)),
		tableRule("└", "┴", "┘", widths),
	].join("\n");
}
