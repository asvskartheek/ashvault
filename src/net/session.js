// One session object over three transports: 'patch' (Patch rooms), 'local' (?room=local-XYZ, BroadcastChannel for multi-tab dev), 'solo'.
// Events: 'msg' (type, payload, fromId, at) with payload already decoded by protocol.js, 'join' (player), 'leave' (player),
// 'host' (id), 'shared' (obj), 'close' ({code}), plus 'lost' / 'reconnect' around a network drop.
import { encode, decode, check, STATE } from './protocol.js';

const RATE = 25; // msgs/s, under Patch's 30/s
const BURST = 12;
const QUEUE_MAX = 300;

const err = (code, msg) => Object.assign(new Error(msg || code), { code });
const rid = () => Math.random().toString(36).slice(2, 8);

// Local-transport timing (ms); tests shrink these.
const LOCAL = { hb: 1000, timeout: 3500, hide: 5000, discover: 400 };

// ---------- transports: { me, code, players(), host(), data, send(env, to), setData(d), now(), invite(), leave(), setListed() } ----------
// A transport calls h.message(env, from, at), h.join(p), h.leave(p), h.host(id), h.data(d), h.close(info).

async function patchTransport(P, h, { max, quick, code, retry }) {
	let room;
	const bind = (r) => {
		room = r;
		r.on('message', (m, from, at) => h.message(m, from, at));
		r.on('join', (p) => h.join(p));
		r.on('leave', (p) => h.leave(p));
		r.on('host', (id) => h.host(id));
		r.on('data', (d) => h.data(d));
		r.on('close', (info) => h.close(info));
		r.on('error', (e) => h.error?.(e));
	};
	if (code) room = await P.rooms.join(code);
	else if (quick) room = await P.rooms.quickMatch({ max, keep: 10 });
	else room = await P.rooms.create({ max, keep: 10 });
	bind(room);
	const t = {
		get me() {
			return { id: room.me.id, name: room.me.name };
		},
		get code() {
			return room.code;
		},
		players: () => room.players.map((p) => ({ id: p.id, name: p.name })),
		host: () => room.host,
		get data() {
			return room.data;
		},
		send: (env, to) => room.send(env, to ? { to } : undefined),
		setData: (d) => room.setData(d),
		now: () => room.now(),
		invite: async () => room.invite(),
		leave: () => room.leave(),
		setListed: (b) => room.setListed(b),
		async rejoin() {
			bind((room = await P.rooms.join(room.code)));
		},
	};
	return t;
}

// Local peers: earliest joiner (whose tab has not been hidden for `hide` ms) is host. Heartbeats detect closed tabs.
async function localTransport(env, h, { max, code, opts }) {
	const T = { ...LOCAL, ...opts };
	const clock = env.clock || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (x) => clearTimeout(x), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (x) => clearInterval(x) };
	const ch = new env.BroadcastChannel('ashvault-' + code);
	const doc = env.document;
	const me = { id: env.id || 'p' + rid(), name: env.name || 'Wraith-' + rid().slice(0, 3).toUpperCase(), joined: clock.now(), seen: 0, hiddenSince: 0 };
	const peers = new Map([[me.id, me]]);
	let data = null;
	let dv = 0;
	let host = null;
	let closed = false;
	const created = clock.now();
	const hidden = () => !!doc && doc.visibilityState === 'hidden';
	const pub = (p) => ({ id: p.id, name: p.name });
	const post = (o) => {
		if (!closed) ch.postMessage({ ...o, from: me.id });
	};
	const hello = (reply, to) => post({ k: 'hello', name: me.name, joined: me.joined, hs: me.hiddenSince, reply, to });
	const elect = () => {
		const t = clock.now();
		const all = [...peers.values()].sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
		const ok = all.filter((p) => !(p.hiddenSince && t - p.hiddenSince >= T.hide));
		const w = (ok[0] || all[0]).id;
		if (w !== host) {
			host = w;
			return true;
		}
		return false;
	};
	const reelect = () => elect() && live && h.host(host);
	const setHidden = () => {
		const hd = hidden();
		if (hd && !me.hiddenSince) me.hiddenSince = clock.now();
		else if (!hd && me.hiddenSince) {
			me.hiddenSince = 0;
			me.joined = clock.now(); // coming back counts from the return
			hello(true);
		}
	};
	const drop = (id) => {
		const p = peers.get(id);
		if (!p || id === me.id) return;
		peers.delete(id);
		h.leave(pub(p));
		reelect();
	};
	ch.onmessage = (ev) => {
		const m = ev.data;
		if (closed || !m || m.from === me.id || (m.to && m.to !== me.id)) return;
		const t = clock.now();
		let p = peers.get(m.from);
		if (m.k === 'bye') return drop(m.from);
		if (m.k === 'hello' || !p) {
			const isNew = !p;
			p = p || { id: m.from, name: m.name || m.from, joined: m.joined ?? t, seen: t, hiddenSince: 0 };
			if (m.k === 'hello') {
				p.name = m.name || p.name;
				p.joined = m.joined ?? p.joined;
			}
			p.hiddenSince = m.hs || 0;
			peers.set(m.from, p);
			if (isNew && m.k === 'hello') {
				if (!m.reply) hello(true, m.from);
				if (live) h.join(pub(p));
				reelect();
				// the host hands a newcomer the room data
				if (host === me.id && data != null) post({ k: 'data', d: data, v: dv, to: m.from });
			} else if (m.k === 'hello') reelect();
		}
		p.seen = t;
		if (m.k === 'hb') {
			p.hiddenSince = m.hs || 0;
			reelect();
		} else if (m.k === 'data') {
			if ((m.v ?? 0) >= dv) {
				dv = m.v ?? 0;
				data = m.d;
				h.data(data);
			}
		} else if (m.k === 'm') h.message(m.d, m.from, t - created);
	};
	let live = false;
	hello(false);
	await new Promise((r) => clock.setTimeout(r, T.discover));
	if (peers.size > max) {
		closed = true;
		ch.close();
		throw err('room_full');
	}
	live = true;
	elect();
	const timer = clock.setInterval(() => {
		setHidden();
		const t = clock.now();
		post({ k: 'hb', hs: me.hiddenSince });
		for (const p of [...peers.values()]) if (p.id !== me.id && t - p.seen > T.timeout) drop(p.id);
		reelect();
	}, T.hb);
	const bye = () => {
		post({ k: 'bye' });
	};
	env.window?.addEventListener?.('pagehide', bye);
	env.window?.addEventListener?.('beforeunload', bye);
	doc?.addEventListener?.('visibilitychange', setHidden);
	return {
		me: pub(me),
		code,
		players: () => [...peers.values()].sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1)).map(pub),
		host: () => host,
		get data() {
			return data;
		},
		send: (e, to) => post({ k: 'm', d: e, to }),
		setData(d) {
			if (host !== me.id) throw err('not_host');
			dv++;
			data = d;
			post({ k: 'data', d, v: dv });
		},
		now: () => clock.now() - created,
		invite: async () => {
			const u = new URL(env.location.href);
			u.searchParams.set('room', code);
			return { link: u.toString(), copied: false };
		},
		leave() {
			if (closed) return;
			bye();
			closed = true;
			clock.clearInterval(timer);
			env.window?.removeEventListener?.('pagehide', bye);
			env.window?.removeEventListener?.('beforeunload', bye);
			doc?.removeEventListener?.('visibilitychange', setHidden);
			ch.close();
		},
		setListed() {},
	};
}

// ---------- session ----------
export async function createSession({ max = 12, quick = false, env = globalThis, local, code: joinCode } = {}) {
	const ls = new Map();
	const on = (ev, fn) => (ls.has(ev) ? ls.get(ev).add(fn) : ls.set(ev, new Set([fn])), api);
	const off = (ev, fn) => (ls.get(ev)?.delete(fn), api);
	const emit = (ev, ...a) => {
		for (const f of ls.get(ev) || []) {
			try {
				f(...a);
			} catch (e) {
				console.error('[net]', ev, e);
			}
		}
	};
	const q = new URLSearchParams(env.location?.search || '');
	const roomParam = q.get('room');
	const clock = env.clock?.now ? env.clock : null;
	const nowMs = () => (clock ? clock.now() : env.performance?.now?.() ?? Date.now());
	const setT = (f, ms) => (clock ? clock.setTimeout(f, ms) : setTimeout(f, ms));

	let tr = null;
	let mode = 'solo';
	let error = null;
	let players = [];
	let hostId = null;
	let shared = null;
	let left = false;
	const meSolo = { id: 'solo', name: 'You' };

	const sync = () => {
		if (!tr) return;
		hostId = tr.host();
		players = tr.players().map((p) => ({ ...p, host: p.id === hostId }));
	};
	const handlers = {
		message(env_, from, at) {
			if (!env_ || typeof env_ !== 'object') return;
			const payload = decode(env_.t, env_.d);
			if (payload != null) emit('msg', env_.t, payload, from, at);
		},
		join(p) {
			sync();
			emit('join', players.find((x) => x.id === p.id) || { ...p, host: false });
		},
		leave(p) {
			const gone = players.find((x) => x.id === p.id) || { ...p, host: false };
			sync();
			emit('leave', gone);
		},
		host(id) {
			sync();
			emit('host', id);
		},
		data(d) {
			shared = d;
			emit('shared', d);
		},
		error(e) {
			if (e?.code === 'too_fast') api.stats.tooFast++;
			emit('error', e);
		},
		close(info) {
			const code = info?.code ?? info;
			if (left) return;
			if (code === 'lost' && tr.rejoin) return rejoin();
			emit('close', { code });
		},
	};

	async function rejoin() {
		emit('lost');
		for (let i = 0; i < 6 && !left; i++) {
			await new Promise((r) => setT(r, Math.min(8000, 700 * 2 ** i)));
			try {
				await tr.rejoin();
				const before = new Map(players.map((p) => [p.id, p]));
				const oldHost = hostId;
				sync();
				for (const p of before.values()) if (!players.some((x) => x.id === p.id)) emit('leave', p);
				for (const p of players) if (!before.has(p.id)) emit('join', p);
				if (hostId !== oldHost) emit('host', hostId);
				if (tr.data != null) handlers.data(tr.data);
				emit('reconnect');
				return;
			} catch (e) {
				if (e?.code === 'room_not_found' || e?.code === 'room_full' || e?.code === 'room_needs_update') break;
			}
		}
		emit('close', { code: 'lost' });
	}

	// Outgoing: token bucket. State ('p','h') is latest-wins per (type,to) and goes after everything else; the rest is FIFO.
	let tokens = BURST;
	let last = nowMs();
	let timer = null;
	const fifo = [];
	const state = new Map();
	const refill = () => {
		const t = nowMs();
		tokens = Math.min(BURST, tokens + ((t - last) * RATE) / 1000);
		last = t;
	};
	function pump() {
		timer = null;
		if (!tr || left) return;
		refill();
		for (;;) {
			if (tokens < 1) break;
			let item = fifo.shift();
			if (!item) {
				const k = state.keys().next().value;
				if (k === undefined) break;
				item = state.get(k);
				state.delete(k);
			}
			tokens -= 1;
			try {
				tr.send(item.env, item.to);
				api.stats.sent++;
			} catch (e) {
				api.stats.failed++;
				if (e?.code === 'too_fast') api.stats.tooFast++;
			}
		}
		if (fifo.length || state.size) timer = setT(pump, Math.ceil(((1 - tokens) * 1000) / RATE) + 1);
	}

	const api = {
		on,
		off,
		stats: { sent: 0, dropped: 0, failed: 0, tooFast: 0 },
		get mode() {
			return mode;
		},
		get error() {
			return error;
		},
		get me() {
			return tr ? tr.me : meSolo;
		},
		get players() {
			return mode === 'solo' ? [{ ...meSolo, host: true }] : players;
		},
		get isHost() {
			return mode === 'solo' || (tr && hostId === tr.me.id);
		},
		get code() {
			return tr ? tr.code : '';
		},
		get shared() {
			return shared;
		},
		get queued() {
			return fifo.length + state.size;
		},
		// send(type, payload, { to }): encodes with protocol.js (throws too_big), never throws for rate; solo is a no-op.
		send(type, payload, { to } = {}) {
			if (!tr || left) return;
			const env_ = { t: type, d: encode(type, payload) };
			check(env_);
			if (STATE.has(type)) {
				const k = type + '|' + (to || '');
				if (state.has(k)) api.stats.dropped++;
				state.delete(k); // newest goes to the back, keeping order fair
				state.set(k, { env: env_, to });
			} else {
				if (fifo.length >= QUEUE_MAX) {
					fifo.shift();
					api.stats.dropped++;
				}
				fifo.push({ env: env_, to });
			}
			if (!timer) pump();
		},
		setShared(obj) {
			if (!tr) {
				shared = obj;
				return;
			}
			check(obj, 15800);
			tr.setData(obj);
			shared = obj;
		},
		now: () => (tr ? tr.now() : nowMs()),
		async invite() {
			if (!tr) return { link: '', copied: false };
			const r = await tr.invite();
			if (!r.copied) {
				try {
					await env.navigator?.clipboard?.writeText(r.link);
					r.copied = true;
				} catch {}
			}
			return r;
		},
		setListed: (b) => tr?.setListed(b),
		leave() {
			left = true;
			if (timer) clock ? clock.clearTimeout(timer) : clearTimeout(timer);
			try {
				tr?.leave();
			} catch {}
		},
	};

	try {
		if (roomParam && roomParam.startsWith('local') && env.BroadcastChannel) {
			tr = await localTransport(env, handlers, { max, code: roomParam, opts: local });
			mode = 'local';
		} else if (env.patch?.rooms) {
			const P = env.patch;
			const launch = joinCode || (await P.getLaunch?.().catch(() => null))?.room || null;
			const test = q.has('patch-test');
			if (!(test && !launch)) {
				tr = await patchTransport(P, handlers, { max, quick: quick && !launch, code: launch });
				mode = 'patch';
			}
		}
	} catch (e) {
		error = e?.code || String(e);
		tr = null;
		mode = 'solo';
	}
	if (tr) {
		sync();
		shared = tr.data ?? null;
	}
	return api;
}
