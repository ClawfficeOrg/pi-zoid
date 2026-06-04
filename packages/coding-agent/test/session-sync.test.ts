import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncSessionAnalytics } from "../src/core/session-sync.ts";
import { loadSessionSyncState, saveSessionSyncState } from "../src/core/session-sync-state.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-sync-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function writeSessionFile(sessionsRoot: string): void {
	const sessionDir = join(sessionsRoot, "default");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, "session-1.jsonl"),
		`${[
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			{
				type: "model_change",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				provider: "openai",
				modelId: "gpt-4.1",
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
}

describe("syncSessionAnalytics", () => {
	it("returns not_authenticated after recording lastAttemptAt", async () => {
		const agentDir = createTempDir();
		const result = await syncSessionAnalytics({
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(result).toEqual({ status: "not_authenticated" });
		expect(await loadSessionSyncState(agentDir)).toMatchObject({ lastAttemptAt: "2026-01-01T00:00:00.000Z" });
	});

	it("updates lastAttemptAt on no_changes", async () => {
		const agentDir = createTempDir();
		const sessionsRoot = createTempDir();
		await saveSessionSyncState({ refreshToken: "refresh-1" }, agentDir);
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.endsWith("/api/oauth/token")) {
				return jsonResponse({
					token_type: "Bearer",
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 86400,
					scope: "session_sync offline_access",
				});
			}
			return jsonResponse({ ok: true, watermark: null });
		};

		const result = await syncSessionAnalytics({
			agentDir,
			sessionsRoot,
			settingsManager: SettingsManager.inMemory(),
			fetch: fetchMock,
			now: new Date("2026-01-02T00:00:00.000Z"),
		});

		expect(result).toMatchObject({ status: "no_changes", filesScanned: 0 });
		expect(await loadSessionSyncState(agentDir)).toMatchObject({
			refreshToken: "refresh-2",
			lastAttemptAt: "2026-01-02T00:00:00.000Z",
		});
	});

	it("uploads with an idempotency key without persisting payload files", async () => {
		const agentDir = createTempDir();
		const sessionsRoot = createTempDir();
		writeSessionFile(sessionsRoot);
		await saveSessionSyncState({ refreshToken: "refresh-1" }, agentDir);
		const idempotencyKeys: string[] = [];
		const fetchMock: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.endsWith("/api/oauth/token")) {
				return jsonResponse({
					token_type: "Bearer",
					access_token: "access-1",
					refresh_token: "refresh-2",
					expires_in: 86400,
					scope: "session_sync offline_access",
				});
			}
			if (request.method === "GET") return jsonResponse({ ok: true, watermark: null });
			idempotencyKeys.push(request.headers.get("Idempotency-Key") ?? "");
			expect((await request.arrayBuffer()).byteLength).toBeGreaterThan(0);
			return jsonResponse({
				ok: true,
				records_received: 2,
				first_record_timestamp: "2026-01-01T00:00:00.000Z",
				last_record_timestamp: "2026-01-01T00:00:01.000Z",
				received_bytes: 21,
				watermark: "2026-01-02T00:00:00.000Z",
			});
		};

		const result = await syncSessionAnalytics({
			agentDir,
			sessionsRoot,
			settingsManager: SettingsManager.inMemory(),
			fetch: fetchMock,
			now: new Date("2026-01-03T00:00:00.000Z"),
		});

		expect(result).toMatchObject({
			status: "uploaded",
			recordsSent: 2,
			watermark: "2026-01-02T00:00:00.000Z",
		});
		expect(idempotencyKeys).toHaveLength(1);
		expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(existsSync(join(agentDir, "session-sync-payloads"))).toBe(false);
		expect(await loadSessionSyncState(agentDir)).toMatchObject({
			refreshToken: "refresh-2",
			lastSuccessAt: "2026-01-03T00:00:00.000Z",
		});
	});
});
