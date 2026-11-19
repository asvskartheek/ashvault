// DM core test: node tools/dmtest.mjs. Plain asserts; scripted backend + a fake world + fake broken LLMs.
import assert from 'node:assert/strict';
import { createDM } from '../src/dm/dm.js';
import { scripted } from '../src/dm/backends/scripted.js';
import { run } from '../src/dm/interpreter.js';
import { createQuests } from '../src/dm/quests.js';
import { systemFor, promptFor, maxTokensFor } from '../src/dm/prompt.js';
import { validate, KINDS } from '../src/dm/schema.js';

let n = 0;
const ok = (name, fn) => Promise.resolve(fn()).then(() => console.log('ok  ' + name), (e) => (console.error('FAIL ' + name + '\n', e), process.exit(1)), n++);

const party = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo', bot: true }];
const rooms = Array.from({ length: 14 }, (_, i) => ({ id: i, type: i === 0 ? 'entrance' : i === 13 ? 'boss' : 'combat', w: 7, h: 7, depth: i }));
const locked = new Set([0, 13]);

const fakeWorld = () => {
	const calls = [];
	return new Proxy({ calls }, { get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])) });
};
const llm = (name, gen) => ({ name, async ready() { return true; }, generate: gen });

await ok('prompt budgets', () => {
	for (const k of Object.keys(KINDS)) {
		assert(systemFor(k).length < 2800, k + ' system ' + systemFor(k).length);
		assert.equal(systemFor(k), systemFor(k));
	}
	assert.deepEqual([maxTokensFor('plan'), maxTokensFor('populate'), maxTokensFor('react')], [96, 320, 128]);
	const p = promptFor('populate', { floorNo: 2, floor: { name: 'The X', palette: 'frost' }, rooms: Array.from({ length: 22 }, (_, i) => ({ id: i, type: 'combat', depth: i })), locked, party }, []);
	assert(p.length < 1200, 'populate prompt ' + p.length);
	const evs = Array.from({ length: 9 }, (_, i) => ({ type: 'kill', enemy: 'hollow', room: i, who: 'a' }));
	assert(promptFor('react', { party, story: 'x'.repeat(600), quests: [] }, evs).length < 1100);
});

await ok('scripted plan: exactly one floor, varies per floor', async () => {
	const pals = new Set();
	for (let f = 1; f <= 5; f++) {
		const cmds = validate(JSON.parse(await scripted.generate({ kind: 'plan', state: { floorNo: f, seed: 7, party } })), { kind: 'plan' });
		assert.equal(cmds.filter((c) => c.op === 'floor').length, 1);
		assert.equal(cmds[0].op, 'floor');
		assert.match(cmds[0].name, /^The \w+ \w+$/);
		pals.add(cmds[0].palette);
	}
	assert.equal(pals.size, 5);
});

await ok('scripted populate: quests, locked untouched, deterministic', async () => {
	const st = { floorNo: 2, floor: { palette: 'molten' }, seed: 3, rooms, locked, party };
	const a = await scripted.generate({ kind: 'populate', state: st });
	assert.equal(a, await scripted.generate({ kind: 'populate', state: st }));
	const cmds = validate(JSON.parse(a), { kind: 'populate', rooms: 14, locked });
	assert.equal(cmds.length, JSON.parse(a).length, 'all cmds valid');
	assert(cmds.some((c) => c.op === 'quest') && cmds.some((c) => c.op === 'role' && c.as === 'elite') && cmds.some((c) => c.op === 'guard'));
	assert(cmds.length <= 12);
	let party2 = 0;
	for (let s = 0; s < 40; s++) party2 += JSON.parse(await scripted.generate({ kind: 'populate', state: { ...st, seed: s } })).some((c) => c.op === 'quest' && c.party >= 2);
	assert(party2 > 5 && party2 < 40, 'party quests sometimes: ' + party2);
});

const cases = {
	kill_streak: [Array.from({ length: 4 }, () => ({ type: 'kill', enemy: 'hollow', room: 3, who: 'a' })), (c) => c.some((x) => x.op === 'spawn' && x.enemy === 'wisp') && c.some((x) => x.op === 'light' && x.color === 'violet') && c.some((x) => x.op === 'say' && x.voice === 'whisper')],
	down: [[{ type: 'down', who: 'a' }], (c) => c.some((x) => x.op === 'bless' && x.what === 'heal') && c.some((x) => x.op === 'say')],
	boss_dead: [[{ type: 'boss_dead' }], (c) => c.some((x) => x.op === 'music' && x.track === 'calm') && c.some((x) => x.op === 'say')],
	lull: [[{ type: 'lull', secs: 20 }], (c) => c.some((x) => x.op === 'spawn' && x.near === 'party') && c.some((x) => x.op === 'sfx' && x.cue === 'rise')],
};
await ok('scripted reactions fit events', async () => {
	for (const [k, [events, test]] of Object.entries(cases)) {
		const c = validate(JSON.parse(await scripted.generate({ kind: 'react', state: { seed: 1, floorNo: 1, party, rooms }, events })), { kind: 'react', rooms: 14 });
		assert(c.length && c.length <= 4 && test(c), k + ' ' + JSON.stringify(c));
	}
	let curses = 0;
	for (let s = 0; s < 30; s++) curses += JSON.parse(await scripted.generate({ kind: 'react', state: { seed: s }, events: [{ type: 'treasure', who: 'a' }] })).some((c) => c.op === 'curse');
	assert(curses > 3 && curses < 30);
});

await ok('interpreter maps ops to world calls', () => {
	const w = fakeWorld();
	const res = run([{ op: 'floor', palette: 'frost' }, { op: 'bless', what: 'heal', amount: 9, who: 'actor' }, { op: 'say', text: 'hi' }, { op: 'guard', room: 2, enemy: 'hollow', n: 3 }, { op: 'quest', id: 'q', goal: 'boss', title: 't' }], w, { actor: 'a' });
	assert.deepEqual(w.calls.map((c) => c[0]), ['bless', 'say', 'guard', 'quest']);
	assert.deepEqual(w.calls[0], ['bless', 'heal', 9, 'actor', 'a']);
	assert.equal(res.length, 4);
	const bad = { say() { throw new Error('boom'); }, mood() {} };
	const r = run([{ op: 'say', text: 'x' }, { op: 'mood', as: 'grim' }, { op: 'nope' }], bad);
	assert.deepEqual(r.map((x) => x.ok), [false, true, false]);
});

await ok('quests: kill, reach, survive, boss, party, persistence', () => {
	const ev = [], paid = [];
	const q = createQuests({ onEvent: (e) => ev.push(e), pay: (r) => paid.push(r) });
	q.add({ id: 'k', goal: 'kill', title: 'k', enemy: 'hollow', n: 2, reward: 'heal' });
	q.add({ id: 'r', goal: 'reach', title: 'r', room: 5, reward: 'xp' });
	q.add({ id: 's', goal: 'survive', title: 's', n: 10, reward: 'ward' });
	q.add({ id: 'b', goal: 'boss', title: 'b', party: 3, reward: 'mana' });
	assert.equal(q.partyWanted(), 3);
	q.observe({ type: 'kill', enemy: 'wisp' });
	q.observe({ type: 'kill', enemy: 'hollow' });
	assert.equal(q.list()[0].k, 1);
	q.observe({ type: 'kill', enemy: 'hollow' });
	q.observe({ type: 'enter', room: 5 });
	for (let i = 0; i < 100; i++) q.tick(0.1);
	q.observe({ type: 'boss_dead' });
	assert.deepEqual(paid, ['heal', 'xp', 'ward', 'mana']);
	assert.equal(ev.filter((e) => e.type === 'quest_done').length, 4);
	assert(ev.some((e) => e.type === 'quest_progress' && e.id === 'k'));
	assert.equal(q.partyWanted(), 1);
	const q2 = createQuests({});
	q2.load(JSON.parse(JSON.stringify(q.toJSON())));
	assert.equal(q2.list().length, 4);
});

const dmWith = (backend, opts = {}) => {
	const log = [];
	const dm = createDM({ backend, onProgram: (c, m) => log.push({ c, m }), ...opts });
	return { dm, log };
};
const drive = async (dm, secs, step = 0.5) => {
	for (let i = 0; i < secs / step; i++) {
		dm.tick(step);
		await dm.idle();
	}
};

await ok('DM flow: plan -> populate -> events -> lull', async () => {
	const { dm, log } = dmWith(scripted);
	const plan = await dm.plan({ floor: 2, seed: 'abc', party });
	assert.equal(plan.filter((c) => c.op === 'floor').length, 1);
	const pop = await dm.populate({ rooms, locked, party });
	assert(pop.some((c) => c.op === 'quest'));
	assert.deepEqual(log.map((l) => l.m.kind), ['plan', 'populate']);
	assert.equal(log[0].m.seq, 1);
	assert.equal(log[1].m.backend, 'scripted');
	dm.observe({ type: 'down', who: 'a' });
	await drive(dm, 1);
	const r = log.find((l) => l.m.kind === 'react');
	assert(r, 'priority react within 1 s');
	assert.equal(r.m.actor, 'a');
	for (let i = 0; i < 6; i++) dm.observe({ type: 'kill', enemy: 'hollow', room: 2, who: 'b' });
	await drive(dm, 2);
	assert.equal(log.filter((l) => l.m.kind === 'react').length, 1, 'rate limit 4 s');
	await drive(dm, 3);
	assert.equal(log.filter((l) => l.m.kind === 'react').length, 2);
	const before = log.length;
	await drive(dm, 25);
	assert(log.length > before && log.at(-1).c.some((c) => c.op === 'spawn'), 'lull ambush');
	assert(dm.story.length > 0 && dm.story.length <= 600 && /Ana fell/.test(dm.story), dm.story);
	for (let i = 0; i < 200; i++) dm.observe({ type: 'down', who: 'a' });
	assert(dm.story.length <= 600);
	dm.stop();
});

await ok('fallback: garbage / partial / timeout / throw / not ready', async () => {
	const fast = { timeouts: { plan: 80, populate: 80, react: 80 } };
	const hang = llm('hang', (r, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))));
	const hang2 = llm('hang2', () => new Promise(() => {})); // ignores the signal
	const bad = [
		['garbage', llm('garbage', async () => 'lol no json {{{')],
		['empty', llm('empty', async () => '[]')],
		['invalid', llm('invalid', async () => '[{"op":"floor","palette":"purple"},{"op":"nuke"}]')],
		['throws', llm('throws', async () => { throw new Error('gpu lost'); })],
		['hang', hang],
		['hang2', hang2],
		['notready', { name: 'nr', ready: async () => false, generate: async () => '[{"op":"mood","as":"grim"}]' }],
	];
	for (const [k, b] of bad) {
		const { dm, log } = dmWith(b, fast);
		const plan = await dm.plan({ floor: 1, seed: 1, party });
		assert.equal(plan.filter((c) => c.op === 'floor').length, 1, k + ' plan');
		const pop = await dm.populate({ rooms, locked, party });
		assert(pop.some((c) => c.op === 'quest'), k + ' populate');
		dm.observe({ type: 'boss_dead' });
		await drive(dm, 2);
		await dm.idle();
		const r = log.find((l) => l.m.kind === 'react');
		assert(r && r.c.length, k + ' react');
		assert(log.every((l) => l.m.backend === 'scripted'), k + ' backend ' + log.map((l) => l.m.backend));
		dm.stop();
	}
});

await ok('LLM partial JSON keeps whole cmds; plan gets floor injected; populate gets quest', async () => {
	const partial = llm('lfm', async (req) => (req.kind === 'plan' ? '[{"op":"say","text":"Hello.","voice":"dm"},{"op":"music","track":"dread"},{"op":"mood","as":"gri' : req.kind === 'populate' ? '[{"op":"role","room":3,"as":"shrine"},{"op":"role","room":0,"as":"elite"},{"op":"light","room":3,"color":"gold","power":9' : '[{"op":"mood","as":"wrath"},{"op":"sfx","cue":"quake"'));
	const { dm, log } = dmWith(partial);
	const plan = await dm.plan({ floor: 1, seed: 1, party });
	assert.equal(plan[0].op, 'floor');
	assert(plan.some((c) => c.op === 'say') && plan.length <= 4);
	assert.equal(log[0].m.backend, 'lfm');
	const pop = await dm.populate({ rooms, locked, party });
	assert(pop.some((c) => c.op === 'quest') && pop.some((c) => c.op === 'role' && c.room === 3));
	assert(!pop.some((c) => c.op === 'role' && c.room === 0), 'locked role dropped');
	dm.observe({ type: 'kill', enemy: 'hollow', room: 1, who: 'a' });
	await drive(dm, 2);
	const r = log.find((l) => l.m.kind === 'react');
	assert.deepEqual(r.c.map((c) => c.op), ['mood']);
	assert.equal(r.m.backend, 'lfm');
	dm.stop();
});

await ok('plan cancels a react in flight; one generation at a time', async () => {
	let live = 0, peak = 0;
	const slow = llm('slow', async (req, { signal }) => {
		await new Promise((r) => setTimeout(r, 0)); // let a cancelled predecessor unwind
		peak = Math.max(peak, ++live);
		try {
			await new Promise((r, j) => (setTimeout(r, 40), signal.addEventListener('abort', () => j(new Error('abort')))));
		} finally {
			live--;
		}
		return JSON.stringify(req.kind === 'react' ? [{ op: 'mood', as: 'grim' }] : [{ op: 'floor', palette: 'frost', name: 'X' }]);
	});
	const { dm, log } = dmWith(slow);
	await dm.plan({ floor: 1, seed: 1, party });
	await dm.populate({ rooms, locked, party });
	dm.observe({ type: 'down', who: 'a' });
	dm.tick(1);
	const p = dm.plan({ floor: 2, seed: 1, party });
	await p;
	assert.equal(log.filter((l) => l.m.kind === 'react').length, 0, 'react dropped');
	assert.equal(peak, 1);
	dm.stop();
});

console.log(`\n${n} groups passed`);
