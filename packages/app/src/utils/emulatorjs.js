// EmulatorJS control glue. Ports the Moonbase plugin player.html script so the enact app
// drives EmulatorJS directly (no iframe / postMessage). Loader + WASM cores come from the
// trusted-cert CDN and work on old webOS. The ROM is either a direct server URL EmulatorJS
// streams itself or a Blob URL the app already fetched, and the BIOS is always a Blob URL.
// Threads are off (no cross-origin isolation on app:// / file://), so single-threaded cores only.

import $L from '@enact/i18n/$L';

import serverLogger from '../services/serverLogger';
import {isWebOS, isTizen} from '../platform';

const logGames = (message, context) =>
	serverLogger.debug(serverLogger.LOG_CATEGORIES.APP, `[Games] ${message}`, context);
const logGamesError = (message, context) =>
	serverLogger.error(serverLogger.LOG_CATEGORIES.APP, `[Games] ${message}`, context, false);

const CDN = 'https://cdn.emulatorjs.org/stable/data/';

let loaderScript = null;
// The config loader.js built and the class it constructed. Both outlive a teardown, so a later
// launch can build an emulator straight away instead of downloading the bundle again.
let loadedConfig = null;
let EmulatorCtor = null;

// EmulatorJS cores are WebAssembly, which needs Chromium 57+. Older WebViews (webOS 4 and
// below at Chrome 53, Tizen 4 and below at Chrome 56) lack it entirely, so games can't run
// there. The supported floor is webOS 5 (Chrome 68) and Tizen 5.0 (Chrome 63).
export const isSupported = () =>
	typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';

// Maps a Chrome major version to the webOS marketing version it shipped with.
const CHROME_TO_WEBOS = [[120, 25], [108, 24], [94, 23], [87, 22], [79, 6], [68, 5], [53, 4], [38, 3], [34, 2], [26, 1]];

// Platform and detected OS version for the "not supported" dialog. The version is best-effort
// from the UA. Tizen states it directly and webOS is derived from the Chrome major.
export const supportInfo = () => {
	const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
	let platform = null;
	let version = null;
	if (isTizen()) {
		platform = 'tizen';
		const m = ua.match(/Tizen\s([0-9]+(?:\.[0-9]+)?)/i);
		if (m) version = m[1];
	} else if (isWebOS()) {
		platform = 'webos';
		const m = ua.match(/Chrome\/(\d+)/);
		if (m) {
			const chrome = parseInt(m[1], 10);
			const hit = CHROME_TO_WEBOS.find(([c]) => chrome >= c);
			if (hit) version = String(hit[1]);
		}
	}
	return {supported: isSupported(), platform, version};
};

// Localized "why games can't run here" message, specific to the detected platform.
export const unsupportedMessage = () => {
	const {platform, version} = supportInfo();
	if (platform === 'webos') {
		return version
			? $L('This TV runs webOS {version}. Games require webOS 5 or newer.').replace('{version}', version)
			: $L('Games require webOS 5 or newer.');
	}
	if (platform === 'tizen') {
		return version
			? $L('This TV runs Tizen {version}. Games require Tizen 5 or newer.').replace('{version}', version)
			: $L('Games require Tizen 5 or newer.');
	}
	return $L('Games require webOS 5 or Tizen 5 and newer.');
};

// The core needs a modern WebView. Older ones fail to parse it and EJS_ready never fires,
// so reject after this timeout and let the caller show an error instead of hanging.
const READY_TIMEOUT = 40000;

// EmulatorJS writes what it is doing into its own status element, which is the only clue to
// where a boot stalled once it stops making progress.
const emulatorStatusText = () => {
	const emu = window.EJS_emulator;
	return (emu && emu.textElem && emu.textElem.innerText) || null;
};

// Starts EmulatorJS in the element matching `selector` and resolves once the core is ready.
export const startEmulator = ({selector, core, gameUrl, biosUrl, gameName, settingsJson}) =>
	new Promise((resolve, reject) => {
		if (settingsJson) {
			try { window.localStorage.setItem('ejs-settings', settingsJson); } catch (e) { /* ignore */ }
		}

		const startedAt = Date.now();
		// EmulatorJS reports a failed boot by never firing ready, so the reason only shows up as
		// an uncaught error. Watch the window for as long as the boot runs to keep it.
		const onWindowError = (ev) => logGamesError('window error during emulator boot', {
			core,
			message: ev.message || String(ev.error || ''),
			source: ev.filename ? `${ev.filename}:${ev.lineno}` : null
		});
		const onRejection = (ev) => logGamesError('unhandled rejection during emulator boot', {
			core,
			reason: String((ev.reason && (ev.reason.message || ev.reason)) || '')
		});
		window.addEventListener('error', onWindowError);
		window.addEventListener('unhandledrejection', onRejection);
		const stopWatching = () => {
			window.removeEventListener('error', onWindowError);
			window.removeEventListener('unhandledrejection', onRejection);
		};

		// A TV that runs out of memory mid-boot takes the app with it and never reaches the
		// timeout below, so this line is the last thing a report will show.
		logGames('starting emulator', {
			core,
			gameName,
			bios: Boolean(biosUrl),
			blobRom: String(gameUrl || '').startsWith('blob:')
		});
		window.EJS_player = selector;
		window.EJS_core = core;
		window.EJS_gameUrl = gameUrl;
		if (biosUrl) window.EJS_biosUrl = biosUrl;
		if (gameName) window.EJS_gameName = gameName;
		window.EJS_pathtodata = CDN;
		window.EJS_language = 'en-US';
		window.EJS_startOnLoaded = true;
		window.EJS_threads = false;
		// No touch screen on TV; keep the on-screen pad off.
		window.EJS_defaultOptions = Object.assign({}, window.EJS_defaultOptions, {'virtual-gamepad': 'disabled'});

		let reused = false;
		const timer = setTimeout(() => {
			stopWatching();
			// Whatever was cached built an emulator that never started, so drop it and let the
			// next launch go back through the loader rather than repeat the same dead boot.
			loadedConfig = null;
			EmulatorCtor = null;
			logGamesError('emulator never became ready', {reused, emulatorStatus: emulatorStatusText()});
			reject(new Error('emulator-load-timeout'));
		}, READY_TIMEOUT);
		window.EJS_ready = () => {
			clearTimeout(timer);
			stopWatching();
			loadedConfig = (window.EJS_emulator && window.EJS_emulator.config) || loadedConfig;
			EmulatorCtor = (window.EJS_emulator && window.EJS_emulator.constructor) || EmulatorCtor;
			logGames('emulator ready', {core, ms: Date.now() - startedAt, reused});
			resolve();
		};

		// Once the bundle is parsed a later launch can build the emulator from the cached class
		// instead of downloading the loader again. loader.js hooks the ready callback up itself
		// with emulator.on('ready', ...) rather than passing it in the config, so this path has
		// to do the same or the promise above could only ever settle by timing out.
		if (loadedConfig && EmulatorCtor && typeof EmulatorCtor.prototype?.on === 'function') {
			try {
				const config = Object.assign({}, loadedConfig, {
					gameUrl,
					system: core,
					biosUrl: biosUrl || '',
					gameName: gameName || '',
					dataPath: CDN,
					startOnLoad: true,
					threads: false,
					defaultOptions: window.EJS_defaultOptions
				});
				const emulator = new EmulatorCtor(selector, config);
				window.EJS_emulator = emulator;
				window.EJS_adBlocked = (url, del) => emulator.adBlocked(url, del);
				emulator.on('ready', window.EJS_ready);
				reused = true;
				return;
			} catch (e) {
				// Once the cached pair has thrown it is not worth trusting again this session.
				loadedConfig = null;
				EmulatorCtor = null;
				logGamesError('could not build the emulator from the cached class', {message: e.message || String(e)});
			}
		}

		loaderScript = document.createElement('script');
		loaderScript.src = CDN + 'loader.js';
		// Without this the promise sits on the full timeout when the CDN is simply unreachable.
		loaderScript.onerror = () => {
			clearTimeout(timer);
			stopWatching();
			reject(new Error('emulator-loader-unreachable'));
		};
		document.body.appendChild(loaderScript);
	});

const gm = () => window.EJS_emulator && window.EJS_emulator.gameManager;

export const restart = () => { const g = gm(); if (g && g.restart) g.restart(); };
export const toggleFastForward = (on) => { const g = gm(); if (g && g.toggleFastForward) g.toggleFastForward(on ? 1 : 0); };
export const setPaused = (paused) => { const g = gm(); if (g && g.toggleMainLoop) g.toggleMainLoop(paused ? 0 : 1); };

export const getState = () => { const g = gm(); return g && g.getState ? g.getState() : null; };
export const loadState = (bytes) => { const g = gm(); if (g && g.loadState && bytes) g.loadState(bytes); };

export const getSettingsJson = () => {
	try { return window.localStorage.getItem('ejs-settings'); } catch (e) { return null; }
};

export const setOption = (id, value) => {
	const emu = window.EJS_emulator;
	if (emu && emu.changeSettingOption) emu.changeSettingOption(id, value);
};

// Curated general settings shown only when the core/build registered them.
const GENERAL = [
	{id: 'shader', label: 'Shader', choices: ['disabled', '2xScaleHQ', '4xScaleHQ', 'crt-aperture', 'crt-easymode', 'crt-geom', 'crt-mattias', 'sabr', 'bicubic']},
	{id: 'fps', label: 'FPS counter', choices: ['show', 'hide']},
	{id: 'vsync', label: 'VSync', choices: ['enabled', 'disabled']},
	{id: 'ff-ratio', label: 'Fast-forward ratio', choices: ['1.5', '2.0', '2.5', '3.0', '4.0', '5.0', '6.0', '8.0', 'unlimited']},
	{id: 'sm-ratio', label: 'Slow-motion ratio', choices: ['1.5', '2.0', '2.5', '3.0', '4.0', '5.0']},
	{id: 'save-state-slot', label: 'Save state slot', choices: ['1', '2', '3', '4', '5', '6', '7', '8', '9']}
];

// Returns [{id, label, choices:[{value,label}], current}] for the native settings screen.
export const getOptions = () => {
	const out = [];
	const emu = window.EJS_emulator;
	const g = gm();
	try {
		const raw = g && g.getCoreOptions ? g.getCoreOptions() : null;
		if (raw) {
			raw.split('\n').forEach((line) => {
				if (!line) return;
				const parts = line.split('; ');
				if (parts.length < 2) return;
				const id = parts[0].split('|')[0];
				const choices = parts[1].split('|');
				if (choices.length <= 1) return;
				out.push({
					id,
					label: id.replace(/_/g, ' ').replace(/.+-(.+)/, '$1'),
					choices: choices.map((c) => ({value: c, label: c.replace('(Default) ', '')})),
					current: emu && emu.getSettingValue ? emu.getSettingValue(id) : null
				});
			});
		}
		GENERAL.forEach((opt) => {
			const cur = emu && emu.getSettingValue ? emu.getSettingValue(opt.id) : null;
			if (cur == null) return;
			out.push({
				id: opt.id,
				label: opt.label,
				choices: opt.choices.map((c) => ({value: c, label: c})),
				current: cur
			});
		});
	} catch (e) {
		// return whatever we have
	}
	return out;
};

// Tears the emulator down: stops the loop, clears the container, drops EJS globals + loader.
export const destroyEmulator = () => {
	try { setPaused(true); } catch (e) { /* ignore */ }
	try {
		const el = document.querySelector(window.EJS_player || '#game');
		if (el) el.innerHTML = '';
	} catch (e) { /* ignore */ }
	if (loaderScript && loaderScript.parentNode) {
		loaderScript.parentNode.removeChild(loaderScript);
	}
	loaderScript = null;
	['EJS_emulator', 'EJS_player', 'EJS_core', 'EJS_gameUrl', 'EJS_biosUrl', 'EJS_gameName',
		'EJS_pathtodata', 'EJS_startOnLoaded', 'EJS_threads', 'EJS_ready', 'EJS_defaultOptions',
		'EJS_adBlocked']
		.forEach((k) => { try { delete window[k]; } catch (e) { /* ignore */ } });
};
