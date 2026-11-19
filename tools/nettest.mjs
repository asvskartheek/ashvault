// node tools/nettest.mjs: protocol round trips + size bound, session local transport over a fake BroadcastChannel, token bucket.
import assert from 'node:assert/strict';
import { encode, decode, worstCaseH, bytes, MAX_BYTES } from '../src/net/protocol.js';
import { createSession } from '../src/net/session.js';

let n = 0;
const ok = (name) => console.log('ok', ++n, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, e) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

// ---- protocol
{
	const p = { x: 12.3456, z: -7.891, y: 1.234, yaw: 3.0, pitch: -0.5, anim: 'walk', hp: 87.6 };
	const d = decode('p', JSON.parse(JSON.stringify(encode('p', p))));
	near(d.x, p.x, 0.006); near(d.z, p.z, 0.006); near(d.y, p.y, 0.006); near(d.yaw, p.yaw, 0.001); near(d.pitch, p.pitch, 0.001);
	assert.equal(d.anim, 'walk'); assert.equal(d.hp, 88);
	assert.deepEqual(decode('hit', encode('hit', { eid: 7, dmg: 30, crit: true, kind: 'fire' })), { eid: 7, dmg: 30, crit: true, kind: 'fire' });
	assert.deepEqual(decode('dmg', encode('dmg', { to: 'a', dmg: 9, kind: 'sword' })), { to: 'a', dmg: 9, kind: 'sword' });
	assert.deepEqual(decode('ev', encode('ev', { event: { type: 'enter', room: 3 } })), { event: { type: 'enter', room: 3 } });
	const pr = { seq: 4, kind: 'react', cmds: [{ op: 'mood', as: 'tense' }], actor: 'dm' };
	assert.deepEqual(decode('prog', encode('prog', pr)), pr);
	const h = { t: 1234, p: [{ id: 'a', x: 1, z: 2, y: 0, yaw: -3.1, pitch: 0, anim: 'attack', hp: 50 }], e: [{ id: 5, type: 'ogre', x: 3, z: 4.5, yaw: 1, hp: 700, anim: 'slam' }], b: [{ id: 'bot1', x: 9, z: 9, y: 0, yaw: 0, pitch: 0, anim: 'idle', hp: 10, down: true }] };
	const hd = decode('h', JSON.parse(JSON.stringify(encode('h', h))));
	assert.equal(hd.e[0].type, 'ogre'); assert.equal(hd.e[0].anim, 'slam'); assert.equal(hd.b[0].down, true); assert.equal(hd.p[0].id, 'a'); assert.equal(hd.t, 1234);
	assert.equal(decode('h', 'junk'), null); assert.equal(decode('p', [1]), null); assert.equal(decode('nope', {}), null);
	assert.throws(() => encode('shared', { big: 'x'.repeat(MAX_BYTES) }), { code: 'too_big' });
	ok('protocol round trips');
	const w = worstCaseH();
	assert.ok(w < 6000, 'h ' + w);
	ok('worst-case h = ' + w + ' bytes (12 players, 30 enemies, 11 bots)');
	console.log('WORST_H', w);
}

// ---- fake BroadcastChannel (async delivery, structured clone, not echoed to sender)
const chans = new Map();
class FakeBC {
	constructor(name) { this.name = name; this.onmessage = null; (chans.get(name) || chans.set(name, new Set()).get(name)).add(this); }
	postMessage(m) {
		const c = JSON.parse(JSON.stringify(m));
		for (const o of chans.get(this.name)) if (o !== this) queueMicrotask(() => o.onmessage?.({ data: c }));
	}
	close() { chans.get(this.name).delete(this); this.onmessage = null; }
}
const fakeDoc = () => {
	const d = { visibilityState: 'visible', ls: new Set(), addEventListener: (_, f) => d.ls.add(f), removeEventListener: (_, f) => d.ls.delete(f) };
	d.set = (v) => { d.visibilityState = v; d.ls.forEach((f) => f()); };
	return d;
};
const T = { hb: 20, timeout: 70, hide: 120, discover: 50 };
const peer = (code, id) => {
	const doc = fakeDoc();
	return createSession({ max: 3, env: { BroadcastChannel: FakeBC, document: doc, id, name: id, location: { search: '?room=' + code, href: 'http://x/?room=' + code }, performance }, local: T }).then((s) => ((s.doc = doc), s));
};
const collect = (s, ev) => { const a = []; s.on(ev, (...x) => a.push(x)); return a; };

{
	const A = await peer('local-T1', 'A');
	assert.equal(A.mode, 'local'); assert.equal(A.isHost, true);
	const aJoin = collect(A, 'join');
	await sleep(5);
	const B = await peer('local-T1', 'B');
	await sleep(40);
	assert.equal(B.isHost, false); assert.equal(A.isHost, true);
	assert.deepEqual(B.players.map((p) => p.id), ['A', 'B']);
	assert.equal(aJoin.length, 1); assert.equal(aJoin[0][0].id, 'B');
	ok('two peers, earliest is host');

	A.setShared({ seed: 42, quests: [1] });
	await sleep(20);
	assert.deepEqual(B.shared, { seed: 42, quests: [1] });
	assert.throws(() => B.setShared({}), { code: 'not_host' });
	assert.throws(() => A.setShared({ x: 'y'.repeat(20000) }), { code: 'too_big' });
	ok('shared data host-only, 16 KB guard');

	const C = await peer('local-T1', 'C'); // late joiner gets data
	assert.deepEqual(C.shared, { seed: 42, quests: [1] });
	assert.equal(C.players.length, 3);
	ok('late joiner receives shared data');

	const bm = collect(B, 'msg');
	A.send('hit', { eid: 1, dmg: 5, crit: false, kind: 'sword' }, { to: 'B' });
	A.send('dmg', { to: 'B', dmg: 3, kind: 'bolt' });
	await sleep(30);
	assert.equal(bm.length, 2); assert.equal(bm[0][0], 'hit'); assert.equal(bm[0][1].dmg, 5); assert.equal(bm[0][2], 'A');
	const cm = collect(C, 'msg');
	A.send('dmg', { to: 'C', dmg: 3, kind: 'bolt' }, { to: 'C' });
	await sleep(30);
	assert.equal(cm.length, 1); assert.equal(bm.length, 2);
	ok('messages broadcast and targeted, decoded');

	// host closes: B (next earliest) takes over, C sees it
	const bHost = collect(B, 'host'); const bLeave = collect(B, 'leave');
	A.leave();
	await sleep(40);
	assert.equal(B.isHost, true); assert.equal(C.isHost, false);
	assert.equal(bHost.at(-1)[0], 'B'); assert.equal(bLeave[0][0].id, 'A');
	assert.deepEqual(B.shared, { seed: 42, quests: [1] });
	B.setShared({ seed: 43 }); await sleep(20);
	assert.deepEqual(C.shared, { seed: 43 });
	ok('host closes -> migration, new host keeps shared + can setShared');

	// crash (no bye): silence past timeout
	B.leave(); // sends bye; to emulate a crash just drop channel without bye below
	await sleep(40);
	assert.equal(C.isHost, true);
	ok('last peer becomes host');
	C.leave();
}
{
	const A = await peer('local-T2', 'A'); await sleep(5);
	const B = await peer('local-T2', 'B'); await sleep(30);
	// crash: kill A's channel silently
	for (const c of chans.get('ashvault-local-T2')) if (c.onmessage && c !== [...chans.get('ashvault-local-T2')][1]) {}
	const aCh = [...chans.get('ashvault-local-T2')][0]; aCh.postMessage = () => {};
	await sleep(T.timeout + 3 * T.hb + 30);
	assert.equal(B.isHost, true); assert.equal(B.players.length, 1);
	ok('crashed host detected by heartbeat timeout');
	A.leave(); B.leave();
}
{
	const A = await peer('local-T3', 'A'); await sleep(5);
	const B = await peer('local-T3', 'B'); await sleep(30);
	const bHost = collect(B, 'host');
	A.doc.set('hidden');
	await sleep(T.hide - 40);
	assert.equal(B.isHost, false);
	await sleep(120);
	assert.equal(B.isHost, true); assert.equal(bHost.at(-1)[0], 'B');
	A.doc.set('visible'); await sleep(60);
	assert.equal(B.isHost, true); assert.equal(A.isHost, false);
	ok('host hidden 5 s -> migrates; returning host does not take it back');
	A.leave(); B.leave();
}
{
	const A = await peer('local-T4', 'A'); const B = await peer('local-T4', 'B'); const C = await peer('local-T4', 'C');
	const D = await createSession({ max: 3, env: { BroadcastChannel: FakeBC, document: fakeDoc(), id: 'D', location: { search: '?room=local-T4', href: 'x' } }, local: T });
	assert.equal(D.mode, 'solo'); assert.equal(D.error, 'room_full'); assert.equal(D.isHost, true);
	ok('room_full -> solo with error');
	A.leave(); B.leave(); C.leave();
}

// ---- rate limit: 25 msg/s with state coalescing
{
	const A = await peer('local-T5', 'A'); const B = await peer('local-T5', 'B'); await sleep(30);
	const sent = [];
	const t0 = performance.now();
	const bm = collect(B, 'msg');
	for (let i = 0; i < 100; i++) A.send('p', { x: i, z: 0, y: 0, yaw: 0, pitch: 0, anim: 'idle', hp: 100 });
	for (let i = 0; i < 40; i++) A.send('hit', { eid: i, dmg: 1, crit: false, kind: 'sword' });
	assert.ok(A.stats.sent <= 12, 'burst bounded: ' + A.stats.sent);
	assert.ok(A.stats.dropped > 80, "dropped " + A.stats.dropped); // stale p coalesced, newest kept
	await sleep(1800);
	const hits = bm.filter((m) => m[0] === 'hit').length;
	assert.equal(hits, 40); // every non-state message arrives
	assert.equal(bm.filter((m) => m[0] === 'p').at(-1)[1].x, 99); // newest state arrives
	const dt = (performance.now() - t0) / 1000;
	assert.ok(A.stats.sent / dt <= 25 + 12 / dt, `rate ${A.stats.sent / dt}`);
	ok(`token bucket: ${A.stats.sent} sent in ${dt.toFixed(2)}s, queued all ${hits} hits, state coalesced`);
	A.leave(); B.leave();
}
// ---- solo + patch-test
{
	const s = await createSession({ env: { location: { search: '' } } });
	assert.equal(s.mode, 'solo'); assert.equal(s.isHost, true); s.send('p', { x: 1 }); assert.equal(s.players.length, 1);
	const s2 = await createSession({ env: { location: { search: '?patch-test=1' }, patch: { rooms: {}, getLaunch: async () => ({}) } } });
	assert.equal(s2.mode, 'solo');
	ok('solo, patch-test -> solo');
}
// ---- patch transport with a fake room, incl. 'lost' rejoin
{
	const fire = { };
	const mk = () => { const h = {}; const r = { code: 'ABC123', me: { id: 'u1', name: 'Me' }, players: [{ id: 'u1', name: 'Me', host: true }], host: 'u1', data: null, sent: [], on: (e, f) => (h[e] = f), emit: (e, ...a) => h[e]?.(...a), send(m, o) { r.sent.push([m, o]); }, setData(d) { r.data = d; }, now: () => 5, invite: async () => ({ link: 'L', copied: true }), leave() {}, setListed() {} }; return r; };
	let room = mk(); let joins = 0;
	const patch = { getLaunch: async () => ({}), rooms: { create: async (o) => { assert.equal(o.max, 12); return room; }, join: async () => { joins++; room = mk(); return room; } } };
	const s = await createSession({ max: 12, env: { location: { search: '' }, patch, performance } });
	assert.equal(s.mode, 'patch'); assert.equal(s.code, 'ABC123'); assert.equal(s.isHost, true);
	s.send('dmg', { to: 'x', dmg: 1, kind: 'sword' });
	assert.equal(room.sent.length, 1); assert.deepEqual(room.sent[0][0], { t: 'dmg', d: ['x', 1, 0] });
	const got = collect(s, 'msg');
	room.emit('message', { t: 'hit', d: [3, 9, 1, 2] }, 'u2', 77);
	assert.deepEqual(got[0], ['hit', { eid: 3, dmg: 9, crit: true, kind: 'fire' }, 'u2', 77]);
	const re = collect(s, 'reconnect');
	room.emit('close', { code: 'lost' });
	await sleep(1000);
	assert.equal(joins, 1); assert.equal(re.length, 1);
	ok('patch transport + rejoin after lost');
	s.leave();
}
console.log('ALL PASS');
process.exit(0);
