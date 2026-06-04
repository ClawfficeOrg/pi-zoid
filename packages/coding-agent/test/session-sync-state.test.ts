import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getStableSessionSyncDeviceId,
	loadSessionSyncState,
	saveSessionSyncState,
	withSessionSyncLock,
} from "../src/core/session-sync-state.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-sync-state-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("session sync state", () => {
	it("loads and saves sync state", async () => {
		const agentDir = createTempDir();
		await saveSessionSyncState({ refreshToken: "refresh-1", lastAttemptAt: "2026-01-01T00:00:00.000Z" }, agentDir);

		expect(await loadSessionSyncState(agentDir)).toEqual({
			refreshToken: "refresh-1",
			lastAttemptAt: "2026-01-01T00:00:00.000Z",
			lastSuccessAt: undefined,
		});
	});

	it("stores a stable device id in telemetry settings", () => {
		const settings = SettingsManager.inMemory();
		const first = getStableSessionSyncDeviceId(settings);
		const second = getStableSessionSyncDeviceId(settings);

		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(settings.getGlobalSettings().telemetry?.sessionSyncDeviceId).toBe(first);
	});

	it("returns already_running when the sync lock is held", async () => {
		const agentDir = createTempDir();
		const result = await withSessionSyncLock(
			async () => withSessionSyncLock(async () => "inner", agentDir),
			agentDir,
		);

		expect(result).toEqual({ status: "acquired", result: { status: "already_running" } });
	});
});
