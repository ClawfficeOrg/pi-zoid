import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface SessionSyncState {
	refreshToken?: string;
	lastAttemptAt?: string;
	lastSuccessAt?: string;
}

export type SessionSyncLockResult<T> = { status: "acquired"; result: T } | { status: "already_running" };

export interface SessionSyncStatePaths {
	agentDir: string;
	statePath: string;
	lockPath: string;
}

export function getSessionSyncStatePaths(agentDir: string = getAgentDir()): SessionSyncStatePaths {
	const resolvedAgentDir = normalizePath(agentDir);
	return {
		agentDir: resolvedAgentDir,
		statePath: join(resolvedAgentDir, "session-sync.json"),
		lockPath: join(resolvedAgentDir, "session-sync.lock"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseSessionSyncState(value: unknown): SessionSyncState {
	if (!isRecord(value)) return {};
	return {
		refreshToken: isString(value.refreshToken) ? value.refreshToken : undefined,
		lastAttemptAt: isString(value.lastAttemptAt) ? value.lastAttemptAt : undefined,
		lastSuccessAt: isString(value.lastSuccessAt) ? value.lastSuccessAt : undefined,
	};
}

export async function loadSessionSyncState(agentDir?: string): Promise<SessionSyncState> {
	const { statePath } = getSessionSyncStatePaths(agentDir);
	try {
		return parseSessionSyncState(JSON.parse(await readFile(statePath, "utf8")));
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
		if (code === "ENOENT") return {};
		throw error;
	}
}

export async function saveSessionSyncState(state: SessionSyncState, agentDir?: string): Promise<void> {
	const { statePath } = getSessionSyncStatePaths(agentDir);
	await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
	await writeFile(statePath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function updateSessionSyncState(
	updater: (state: SessionSyncState) => SessionSyncState,
	agentDir?: string,
): Promise<SessionSyncState> {
	const next = updater(await loadSessionSyncState(agentDir));
	await saveSessionSyncState(next, agentDir);
	return next;
}

function isLockError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && String(error.code) === "ELOCKED";
}

export async function withSessionSyncLock<T>(
	fn: () => Promise<T>,
	agentDir?: string,
): Promise<SessionSyncLockResult<T>> {
	const { lockPath } = getSessionSyncStatePaths(agentDir);
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	if (!existsSync(lockPath)) await writeFile(lockPath, "", { mode: 0o600 });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(lockPath, {
			stale: 10 * 60 * 1000,
			update: 30 * 1000,
			retries: 0,
			realpath: false,
		});
	} catch (error) {
		if (isLockError(error)) return { status: "already_running" };
		throw error;
	}

	try {
		return { status: "acquired", result: await fn() };
	} finally {
		if (release) await release();
	}
}

export function getStableSessionSyncDeviceId(settingsManager: SettingsManager): string {
	const existing = settingsManager.getSessionSyncDeviceId();
	if (existing) return existing;
	const deviceId = randomUUID();
	settingsManager.setSessionSyncDeviceId(deviceId);
	return deviceId;
}
