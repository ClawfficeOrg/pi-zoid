import { randomUUID } from "node:crypto";
import { buildSessionAnalyticsUpload } from "./session-analytics-reader.ts";
import {
	getSessionSyncWatermark,
	refreshSessionSyncAccessToken,
	SessionSyncApiError,
	type SessionSyncFetch,
	uploadSessionAnalytics,
} from "./session-sync-api.ts";
import { buildSessionSyncPayloads, type SessionSyncPayload } from "./session-sync-payload.ts";
import {
	getStableSessionSyncDeviceId,
	loadSessionSyncState,
	type SessionSyncState,
	saveSessionSyncState,
	withSessionSyncLock,
} from "./session-sync-state.ts";
import { SettingsManager } from "./settings-manager.ts";

export type SessionSyncStatus = "uploaded" | "no_changes" | "not_authenticated" | "already_running" | "failed";

export interface SessionSyncResult {
	status: SessionSyncStatus;
	recordsSent?: number;
	compressedBytes?: number;
	decompressedBytes?: number;
	watermark?: string;
	filesScanned?: number;
	error?: string;
}

export interface SyncSessionAnalyticsOptions {
	agentDir?: string;
	sessionsRoot?: string;
	settingsManager?: SettingsManager;
	baseUrl?: string;
	fetch?: SessionSyncFetch;
	signal?: AbortSignal;
	now?: Date;
}

interface AccessTokenState {
	accessToken: string;
	refreshToken: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function refreshAccessToken(
	state: SessionSyncState,
	options: SyncSessionAnalyticsOptions,
): Promise<AccessTokenState | undefined> {
	if (!state.refreshToken) return undefined;
	const token = await refreshSessionSyncAccessToken(state.refreshToken, {
		baseUrl: options.baseUrl,
		fetch: options.fetch,
	});
	state.refreshToken = token.refresh_token;
	await saveSessionSyncState(state, options.agentDir);
	return { accessToken: token.access_token, refreshToken: token.refresh_token };
}

async function uploadWithRefreshRetry(
	state: SessionSyncState,
	access: AccessTokenState,
	payload: Pick<SessionSyncPayload, "watermark" | "contentEncoding" | "body">,
	metadata: { deviceId: string; idempotencyKey: string },
	options: SyncSessionAnalyticsOptions,
): Promise<{ watermark: string; access: AccessTokenState }> {
	try {
		const response = await uploadSessionAnalytics({
			baseUrl: options.baseUrl,
			fetch: options.fetch,
			accessToken: access.accessToken,
			deviceId: metadata.deviceId,
			watermark: payload.watermark,
			idempotencyKey: metadata.idempotencyKey,
			body: payload.body,
			contentEncoding: payload.contentEncoding,
		});
		return { watermark: response.watermark, access };
	} catch (error) {
		if (!(error instanceof SessionSyncApiError) || error.status !== 401) throw error;
		const refreshed = await refreshAccessToken(state, options);
		if (!refreshed) throw error;
		const response = await uploadSessionAnalytics({
			baseUrl: options.baseUrl,
			fetch: options.fetch,
			accessToken: refreshed.accessToken,
			deviceId: metadata.deviceId,
			watermark: payload.watermark,
			idempotencyKey: metadata.idempotencyKey,
			body: payload.body,
			contentEncoding: payload.contentEncoding,
		});
		return { watermark: response.watermark, access: refreshed };
	}
}

async function getWatermarkWithRefreshRetry(
	state: SessionSyncState,
	access: AccessTokenState,
	deviceId: string,
	options: SyncSessionAnalyticsOptions,
): Promise<{ watermark: string | null; access: AccessTokenState }> {
	try {
		const response = await getSessionSyncWatermark(access.accessToken, deviceId, {
			baseUrl: options.baseUrl,
			fetch: options.fetch,
		});
		return { watermark: response.watermark, access };
	} catch (error) {
		if (!(error instanceof SessionSyncApiError) || error.status !== 401) throw error;
		const refreshed = await refreshAccessToken(state, options);
		if (!refreshed) throw error;
		const response = await getSessionSyncWatermark(refreshed.accessToken, deviceId, {
			baseUrl: options.baseUrl,
			fetch: options.fetch,
		});
		return { watermark: response.watermark, access: refreshed };
	}
}

async function syncSessionAnalyticsUnlocked(options: SyncSessionAnalyticsOptions): Promise<SessionSyncResult> {
	const settingsManager = options.settingsManager ?? SettingsManager.create(process.cwd(), options.agentDir);
	const deviceId = getStableSessionSyncDeviceId(settingsManager);
	await settingsManager.flush();
	const state = await loadSessionSyncState(options.agentDir);
	state.lastAttemptAt = (options.now ?? new Date()).toISOString();
	await saveSessionSyncState(state, options.agentDir);

	let access = await refreshAccessToken(state, options);
	if (!access) return { status: "not_authenticated" };

	const watermarkResponse = await getWatermarkWithRefreshRetry(state, access, deviceId, options);
	access = watermarkResponse.access;
	// The server watermark means: the server has accepted everything this client had fully scanned/prepared through this local time.
	const upload = await buildSessionAnalyticsUpload({
		serverWatermark: watermarkResponse.watermark,
		sessionsRoot: options.sessionsRoot,
		signal: options.signal,
	});

	if (upload.records.length === 0) {
		await saveSessionSyncState(state, options.agentDir);
		return {
			status: "no_changes",
			filesScanned: upload.filesScanned,
			watermark: watermarkResponse.watermark ?? undefined,
		};
	}

	const payloads = await buildSessionSyncPayloads({
		records: upload.records,
		scanCutoff: upload.scanCutoff,
		serverWatermark: watermarkResponse.watermark,
	});
	let recordsSent = 0;
	let compressedBytes = 0;
	let decompressedBytes = 0;
	let watermark = watermarkResponse.watermark ?? undefined;

	for (const payload of payloads) {
		const uploaded = await uploadWithRefreshRetry(
			state,
			access,
			payload,
			{ deviceId, idempotencyKey: randomUUID() },
			options,
		);
		access = uploaded.access;
		watermark = uploaded.watermark;
		recordsSent += payload.recordCount;
		compressedBytes += payload.compressedBytes;
		decompressedBytes += payload.decompressedBytes;
		state.lastSuccessAt = (options.now ?? new Date()).toISOString();
		await saveSessionSyncState(state, options.agentDir);
	}

	return {
		status: "uploaded",
		recordsSent,
		compressedBytes,
		decompressedBytes,
		watermark,
		filesScanned: upload.filesScanned,
	};
}

export async function syncSessionAnalytics(options: SyncSessionAnalyticsOptions = {}): Promise<SessionSyncResult> {
	const locked = await withSessionSyncLock(async () => {
		try {
			return await syncSessionAnalyticsUnlocked(options);
		} catch (error) {
			return { status: "failed", error: errorMessage(error) } satisfies SessionSyncResult;
		}
	}, options.agentDir);
	if (locked.status === "already_running") return { status: "already_running" };
	return locked.result;
}
