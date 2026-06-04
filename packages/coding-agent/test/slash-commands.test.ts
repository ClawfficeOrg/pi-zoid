import { describe, expect, it } from "vitest";
import { getVisibleBuiltinSlashCommands, isSessionSyncFeatureEnabled } from "../src/core/slash-commands.ts";

function visibleCommandNames(sessionSyncEnv?: string): string[] {
	return getVisibleBuiltinSlashCommands(sessionSyncEnv).map((command) => command.name);
}

describe("slash commands", () => {
	it("hides session sync unless the early access flag is set", () => {
		expect(isSessionSyncFeatureEnabled(undefined)).toBe(false);
		expect(isSessionSyncFeatureEnabled("true")).toBe(false);
		expect(isSessionSyncFeatureEnabled("1")).toBe(true);
		expect(visibleCommandNames("")).not.toContain("session-sync");
		expect(visibleCommandNames("1")).toContain("session-sync");
	});
});
