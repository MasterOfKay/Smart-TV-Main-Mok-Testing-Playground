// Client for the Moonbase plugin retro-games (EmulatorJS) endpoints under /Moonfin/Games.
// JSON calls route through platformFetch (the webOS Let's-Encrypt TLS proxy) so metadata and
// the settings blob work on old webOS. ROM/BIOS and the binary save state use native fetch and
// a Blob URL (the proxy is text-only), so they inherit the same old-webOS+LE limitation as
// video playback; cores are loaded from the trusted-cert CDN and work everywhere.

import {getServerUrl, getAuthHeader, getApiKey, getTokenParam} from './jellyfinApi';
import {platformFetch} from './secureFetch';
import serverLogger from './serverLogger';
import {fetchWithTimeout} from '../utils/fetchTimeout';

const logGames = (message, context) =>
	serverLogger.debug(serverLogger.LOG_CATEGORIES.APP, `[Games] ${message}`, context);

// A stable per-user id for the global settings blob (settings are not per game).
export const SETTINGS_ID = 'moonfin-global';

const base = () => (getServerUrl() || '').replace(/\/+$/, '');
const authHeaders = () => {
	const h = getAuthHeader();
	return {Authorization: h, 'X-Emby-Authorization': h};
};
const enc = encodeURIComponent;

const jsonRequest = async (path, {method = 'GET', timeout = 20000} = {}) => {
	const res = await platformFetch(`${base()}/Moonfin/Games/${path}`, {
		method,
		headers: {...authHeaders(), Accept: 'application/json'}
	}, timeout);
	if (!res.ok) {
		const err = new Error(`Games API error: ${res.status}`);
		err.status = res.status;
		throw err;
	}
	if (res.status === 204) return null;
	const text = await res.text();
	return text ? JSON.parse(text) : null;
};

export const getLibraries = () => jsonRequest('Libraries');
export const getSystems = (libraryId) => jsonRequest(`${enc(libraryId)}/Systems`);
export const getGames = (libraryId, system) =>
	jsonRequest(`${enc(libraryId)}/Games${system ? `?system=${enc(system)}` : ''}`);
export const getGame = (libraryId, gameId) =>
	jsonRequest(`${enc(libraryId)}/Games/${enc(gameId)}`);

// Image tags can't send auth headers, so the token rides in the query.
// kind defaults to boxart but also accepts snap or title.
export const gameThumbUrl = (libraryId, gameId, kind = 'boxart') => {
	if (!libraryId || !gameId) return null;
	const token = getApiKey();
	const auth = token ? `&${getTokenParam()}=${enc(token)}` : '';
	return `${base()}/Moonfin/Games/${enc(libraryId)}/Thumb/${enc(gameId)}?type=${enc(kind)}${auth}`;
};

// ROM / BIOS as a same-origin Blob URL (avoids CORS; EmulatorJS fetches the blob directly).
const blobUrl = async (path) => {
	const res = await fetchWithTimeout(`${base()}/Moonfin/Games/${path}`, {
		headers: authHeaders()
	}, 60000);
	if (!res.ok) {
		const err = new Error(`ROM fetch error: ${res.status}`);
		err.status = res.status;
		throw err;
	}
	// Buffering full N64 games crashes the TV. For NES games this works, but anything bigger then roghly 6mb will fail or crash.
	const expected = Number(res.headers.get('content-length')) || null;
	try {
		const blob = await res.blob();
		return URL.createObjectURL(blob);
	} catch (e) {
		logGames('buffering the file failed', {path, expectedBytes: expected, message: e.message || String(e)});
		throw e;
	}
};

export const getRomBlobUrl = (libraryId, gameId) =>
	blobUrl(`${enc(libraryId)}/Rom/${enc(gameId)}`);
export const getBiosBlobUrl = (libraryId, biosId) =>
	blobUrl(`${enc(libraryId)}/Bios/${enc(biosId)}`);

// Returns the direct URL for a ROM, if available.
const romDirectUrl = (libraryId, gameId) => {
	const token = getApiKey();
	if (!token) return null;
	return `${base()}/Moonfin/Games/${enc(libraryId)}/Rom/${enc(gameId)}?${getTokenParam()}=${enc(token)}`;
};

// Probes a ROM URL to determine its size and availability.
const probeRom = async (url) => {
	try {
		const res = await fetchWithTimeout(url, {headers: {Range: 'bytes=0-0'}}, 15000);
		if (res.status !== 206 && !res.ok) return {ok: false, totalBytes: null};
		const range = res.headers.get('content-range');
		const total = range && range.split('/')[1];
		return {ok: true, totalBytes: Number(total) || Number(res.headers.get('content-length')) || null};
	} catch (e) {
		return {ok: false, totalBytes: null};
	}
};

// Maximum allowed size for a ROM file (48 MB). This is just a guess number from some testing. Needs better testing. anything more crashes TV
const MAX_ROM_BYTES = 48 * 1024 * 1024;

// Returns {url, isBlob} for the ROM.
export const getRomUrl = async (libraryId, gameId) => {
	const direct = romDirectUrl(libraryId, gameId);
	const probe = direct ? await probeRom(direct) : {ok: false, totalBytes: null};
	if (probe.totalBytes && probe.totalBytes > MAX_ROM_BYTES) {
		logGames('rom refused as too large', {gameId, totalBytes: probe.totalBytes, limit: MAX_ROM_BYTES});
		const err = new Error('rom-too-large');
		err.romTooLarge = true;
		throw err;
	}
	if (probe.ok) {
		logGames('serving rom by url', {gameId, totalBytes: probe.totalBytes});
		return {url: direct, isBlob: false};
	}
	logGames('serving rom as blob', {gameId, reason: direct ? 'query auth refused' : 'no token'});
	return {url: await getRomBlobUrl(libraryId, gameId), isBlob: true};
};

// Save state (binary) keyed per game. Returns null when none exists (404).
export const getStateBytes = async (gameId) => {
	try {
		const res = await fetchWithTimeout(
			`${base()}/Moonfin/Games/Saves/${enc(gameId)}?kind=state`,
			{headers: authHeaders()},
			30000
		);
		if (res.status === 404) return null;
		if (!res.ok) return null;
		const buf = await res.arrayBuffer();
		return buf && buf.byteLength ? new Uint8Array(buf) : null;
	} catch (e) {
		return null;
	}
};

export const putStateBytes = async (gameId, bytes) => {
	await fetchWithTimeout(`${base()}/Moonfin/Games/Saves/${enc(gameId)}?kind=state`, {
		method: 'PUT',
		headers: {...authHeaders(), 'Content-Type': 'application/octet-stream'},
		body: bytes
	}, 30000);
};

// Settings blob (the EmulatorJS `ejs-settings` JSON, text) synced per user via the proxy.
export const getSettingsBlob = async () => {
	try {
		const res = await platformFetch(
			`${base()}/Moonfin/Games/Saves/${enc(SETTINGS_ID)}?kind=settings`,
			{headers: authHeaders()},
			20000
		);
		if (!res.ok) return null;
		const text = await res.text();
		return text || null;
	} catch (e) {
		return null;
	}
};

export const putSettingsBlob = async (json) => {
	try {
		// Settings are text, so route through the proxy (works on old webOS+LE), matching getSettingsBlob.
		await platformFetch(`${base()}/Moonfin/Games/Saves/${enc(SETTINGS_ID)}?kind=settings`, {
			method: 'PUT',
			headers: {...authHeaders(), 'Content-Type': 'application/octet-stream'},
			body: json
		}, 20000);
	} catch (e) {
		// best-effort
	}
};
