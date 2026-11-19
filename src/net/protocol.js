// Wire format for Ashvault co-op. Every message is a compact JSON value (arrays of ints) under Patch's 16 KB cap.
// Positions are in dungeon cells, sent as 1/100 cell ints (1.5 cm); y is feet height in metres, sent as cm; angles as 1/1000 rad; hp as ints.
import { ENEMIES } from '../dm/schema.js';

export const MAX_BYTES = 16384;
// Envelope + headroom: nothing we send may exceed this once serialised.
export const LIMIT = 15800;
export const ANIMS = ['idle', 'walk', 'attack', 'hit', 'die', 'slam', 'taunt', 'attack2'];
export const HIT_KINDS = ['sword', 'bolt', 'fire', 'blast'];
export const STATE = new Set(['p', 'h']);
export const TYPES = ['p', 'hit', 'ev', 'h', 'prog', 'dmg', 'fx', 'shared'];

const TAU = Math.PI * 2;
const q = (v, k) => Math.round((Number.isFinite(v) ? v : 0) * k);
const wrap = (a) => {
	a = Number.isFinite(a) ? a : 0;
	return a - TAU * Math.round(a / TAU);
};
const qa = (a) => Math.round(wrap(a) * 1000);
const idx = (list, v) => Math.max(0, list.indexOf(v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

export function bytes(payload) {
	const s = JSON.stringify(payload);
	let n = s.length;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) n += s.charCodeAt(i) > 2047 ? 2 : 1;
	return n;
}

export function check(payload, limit = LIMIT) {
	const n = bytes(payload);
	if (n > limit) {
		const e = new Error(`message too big: ${n} > ${limit}`);
		e.code = 'too_big';
		throw e;
	}
	return n;
}

// One body row: [x, z, y, yaw, pitch, anim, hp]
const body = (s) => [q(s.x, 100), q(s.z, 100), q(s.y, 100), qa(s.yaw), qa(s.pitch), idx(ANIMS, s.anim), Math.max(0, Math.round(num(s.hp)))];
const unbody = (r, o = {}) => {
	o.x = r[0] / 100;
	o.z = r[1] / 100;
	o.y = r[2] / 100;
	o.yaw = r[3] / 1000;
	o.pitch = r[4] / 1000;
	o.anim = ANIMS[r[5]] || 'idle';
	o.hp = r[6];
	return o;
};

const enc = {
	p: (s) => body(s),
	hit: (m) => [Math.round(num(m.eid)), Math.round(num(m.dmg)), m.crit ? 1 : 0, HIT_KINDS.includes(m.kind) ? HIT_KINDS.indexOf(m.kind) : String(m.kind ?? '').slice(0, 12)],
	ev: (m) => m.event,
	// Bundled host tick. p/b rows: [id, ...body, downed?]; e rows: [id, type, x, z, yaw, hp, anim]
	h: (m) => ({
		t: Math.round(num(m.t)),
		p: (m.p || []).map((s) => [s.id, ...body(s)]),
		e: (m.e || []).map((e) => [e.id, idx(ENEMIES, e.type), q(e.x, 100), q(e.z, 100), qa(e.yaw), Math.max(0, Math.round(num(e.hp))), Number.isInteger(e.wa) ? e.wa : idx(ANIMS, e.anim)]),
		b: (m.b || []).map((s) => [s.id, ...body(s), s.down ? 1 : 0]),
	}),
	prog: (m) => ({ seq: m.seq, kind: m.kind, cmds: m.cmds, actor: m.actor }),
	dmg: (m) => [m.to, Math.round(num(m.dmg)), HIT_KINDS.includes(m.kind) ? HIT_KINDS.indexOf(m.kind) : String(m.kind ?? '').slice(0, 12)],
	fx: (m) => m,
	shared: (m) => m,
};

const dec = {
	p: (r) => (Array.isArray(r) && r.length >= 7 ? unbody(r) : null),
	hit: (r) => (Array.isArray(r) ? { eid: r[0], dmg: r[1], crit: !!r[2], kind: typeof r[3] === 'number' ? HIT_KINDS[r[3]] || 'sword' : r[3] } : null),
	ev: (e) => (e && typeof e === 'object' ? { event: e } : null),
	h: (m) =>
		m && typeof m === 'object' && Array.isArray(m.p)
			? {
					t: m.t,
					p: m.p.map((r) => unbody(r.slice(1), { id: r[0] })),
					e: (m.e || []).map((r) => ({ id: r[0], type: ENEMIES[r[1]] || ENEMIES[0], x: r[2] / 100, z: r[3] / 100, yaw: r[4] / 1000, hp: r[5], anim: ANIMS[r[6]] || 'idle', wa: r[6] })),
					b: (m.b || []).map((r) => unbody(r.slice(1, 8), { id: r[0], down: !!r[8] })),
				}
			: null,
	prog: (m) => (m && Array.isArray(m.cmds) ? { seq: m.seq, kind: m.kind, cmds: m.cmds, actor: m.actor } : null),
	dmg: (r) => (Array.isArray(r) ? { to: r[0], dmg: r[1], kind: typeof r[2] === 'number' ? HIT_KINDS[r[2]] || 'sword' : r[2] } : null),
	fx: (m) => (m && typeof m === 'object' ? m : null),
	shared: (m) => (m && typeof m === 'object' ? m : null),
};

// Encode to the wire payload (throws code 'too_big' past the limit; 'bad_type' for an unknown type).
export function encode(type, msg) {
	const f = enc[type];
	if (!f) throw Object.assign(new Error('unknown message type ' + type), { code: 'bad_type' });
	const out = f(msg ?? {});
	check(out);
	return out;
}

// Decode a wire payload; null when malformed or unknown (never throws).
export function decode(type, payload) {
	try {
		const f = dec[type];
		return f ? f(payload) : null;
	} catch {
		return null;
	}
}

// Worst-case `h`: 12 players + 30 enemies + 11 bots with long ids and large coordinates.
export function worstCaseH() {
	const id = 'plr_' + 'x'.repeat(32);
	const s = (i) => ({ id: i, x: -123.456, z: 234.567, y: -12.34, yaw: -3.14159, pitch: -1.5, anim: 'attack2', hp: 100 });
	const m = {
		t: 99999999,
		p: Array.from({ length: 12 }, (_, i) => s(id + i)),
		e: Array.from({ length: 30 }, (_, i) => ({ id: 10000 + i, type: 'revenant', x: -123.456, z: 234.567, yaw: -3.14159, hp: 720, anim: 'attack2' })),
		b: Array.from({ length: 11 }, (_, i) => ({ ...s('bot' + i), down: true })),
	};
	const n = bytes(encode('h', m));
	if (n >= MAX_BYTES) throw new Error('worst-case h too big: ' + n);
	return n;
}
