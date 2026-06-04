import type { Buffer } from "node:buffer";

export const SESSION_SYNC_CLIENT_ID = "pi-coding-agent";
export const SESSION_SYNC_SCOPE = "session_sync offline_access";
export const DEFAULT_PI_DEV_URL = "https://pi.dev";

export interface SessionSyncDeviceFlowResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface SessionSyncTokenResponse {
	token_type: "Bearer";
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
}

export interface SessionSyncWatermarkResponse {
	ok: true;
	watermark: string | null;
}

export interface SessionSyncUploadResponse {
	ok: true;
	records_received: number;
	first_record_timestamp: string;
	last_record_timestamp: string;
	received_bytes: number;
	watermark: string;
}

export type SessionSyncFetch = typeof fetch;

export interface SessionSyncApiOptions {
	baseUrl?: string;
	fetch?: SessionSyncFetch;
}

export interface UploadSessionAnalyticsOptions extends SessionSyncApiOptions {
	accessToken: string;
	deviceId: string;
	watermark: string;
	idempotencyKey: string;
	body: Buffer;
	contentEncoding: "zstd";
}

export class SessionSyncApiError extends Error {
	status: number;
	errorCode?: string;
	description?: string;

	constructor(status: number, errorCode: string | undefined, description: string | undefined) {
		super(description ? `${errorCode ?? "session_sync_error"}: ${description}` : (errorCode ?? `HTTP ${status}`));
		this.name = "SessionSyncApiError";
		this.status = status;
		this.errorCode = errorCode;
		this.description = description;
	}
}

function getBaseUrl(baseUrl: string | undefined): string {
	return (baseUrl ?? process.env.PI_DEV_URL ?? DEFAULT_PI_DEV_URL).replace(/\/$/, "");
}

function getFetch(fetchImpl: SessionSyncFetch | undefined): SessionSyncFetch {
	return fetchImpl ?? fetch;
}

function formBody(fields: Record<string, string>): URLSearchParams {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		body.set(key, value);
	}
	return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

async function throwIfNotOk(response: Response): Promise<void> {
	if (response.ok) return;
	const json = await readJson(response);
	const errorCode = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
	const description = isRecord(json) && typeof json.description === "string" ? json.description : undefined;
	throw new SessionSyncApiError(response.status, errorCode, description);
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Invalid session sync response: missing ${key}`);
	return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Invalid session sync response: missing ${key}`);
	}
	return value;
}

function parseDeviceFlowResponse(json: unknown): SessionSyncDeviceFlowResponse {
	if (!isRecord(json)) throw new Error("Invalid session sync device flow response");
	return {
		device_code: requireString(json, "device_code"),
		user_code: requireString(json, "user_code"),
		verification_uri: requireString(json, "verification_uri"),
		verification_uri_complete: requireString(json, "verification_uri_complete"),
		expires_in: requireNumber(json, "expires_in"),
		interval: requireNumber(json, "interval"),
	};
}

function parseTokenResponse(json: unknown): SessionSyncTokenResponse {
	if (!isRecord(json)) throw new Error("Invalid session sync token response");
	const tokenType = requireString(json, "token_type");
	if (tokenType !== "Bearer") throw new Error(`Invalid session sync token type: ${tokenType}`);
	return {
		token_type: "Bearer",
		access_token: requireString(json, "access_token"),
		refresh_token: requireString(json, "refresh_token"),
		expires_in: requireNumber(json, "expires_in"),
		scope: requireString(json, "scope"),
	};
}

function parseWatermarkResponse(json: unknown): SessionSyncWatermarkResponse {
	if (!isRecord(json) || json.ok !== true || (json.watermark !== null && typeof json.watermark !== "string")) {
		throw new Error("Invalid session sync watermark response");
	}
	return { ok: true, watermark: json.watermark };
}

function parseUploadResponse(json: unknown): SessionSyncUploadResponse {
	if (!isRecord(json) || json.ok !== true) throw new Error("Invalid session sync upload response");
	return {
		ok: true,
		records_received: requireNumber(json, "records_received"),
		first_record_timestamp: requireString(json, "first_record_timestamp"),
		last_record_timestamp: requireString(json, "last_record_timestamp"),
		received_bytes: requireNumber(json, "received_bytes"),
		watermark: requireString(json, "watermark"),
	};
}

export async function startSessionSyncDeviceFlow(
	deviceId: string,
	options: SessionSyncApiOptions = {},
): Promise<SessionSyncDeviceFlowResponse> {
	const response = await getFetch(options.fetch)(`${getBaseUrl(options.baseUrl)}/api/oauth/device`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: formBody({ client_id: SESSION_SYNC_CLIENT_ID, scope: SESSION_SYNC_SCOPE, device_id: deviceId }),
	});
	await throwIfNotOk(response);
	return parseDeviceFlowResponse(await readJson(response));
}

export async function pollSessionSyncDeviceToken(
	deviceCode: string,
	options: SessionSyncApiOptions = {},
): Promise<SessionSyncTokenResponse> {
	const response = await getFetch(options.fetch)(`${getBaseUrl(options.baseUrl)}/api/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: formBody({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: SESSION_SYNC_CLIENT_ID,
			device_code: deviceCode,
		}),
	});
	await throwIfNotOk(response);
	return parseTokenResponse(await readJson(response));
}

export async function refreshSessionSyncAccessToken(
	refreshToken: string,
	options: SessionSyncApiOptions = {},
): Promise<SessionSyncTokenResponse> {
	const response = await getFetch(options.fetch)(`${getBaseUrl(options.baseUrl)}/api/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: formBody({ grant_type: "refresh_token", client_id: SESSION_SYNC_CLIENT_ID, refresh_token: refreshToken }),
	});
	await throwIfNotOk(response);
	return parseTokenResponse(await readJson(response));
}

export async function getSessionSyncWatermark(
	accessToken: string,
	deviceId: string,
	options: SessionSyncApiOptions = {},
): Promise<SessionSyncWatermarkResponse> {
	const response = await getFetch(options.fetch)(`${getBaseUrl(options.baseUrl)}/analytics/sessions/${deviceId}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	await throwIfNotOk(response);
	return parseWatermarkResponse(await readJson(response));
}

export async function uploadSessionAnalytics(
	options: UploadSessionAnalyticsOptions,
): Promise<SessionSyncUploadResponse> {
	const response = await getFetch(options.fetch)(
		`${getBaseUrl(options.baseUrl)}/analytics/sessions/${options.deviceId}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type": "application/x-ndjson",
				"Content-Encoding": options.contentEncoding,
				"Pi-Sync-Watermark": options.watermark,
				"Idempotency-Key": options.idempotencyKey,
			},
			body: options.body,
		},
	);
	await throwIfNotOk(response);
	return parseUploadResponse(await readJson(response));
}
