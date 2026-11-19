// Proves the DM doesn't hitch the game: for each available backend, warm it, run 5 react + 1 populate generations,
// and record time, valid commands and the worst main-thread frame gap (rAF) while generating.  Open with ?mute (nothing plays audio anyway).
import { createPromptApiBackend, promptApiAvailability } from '../src/dm/backends/prompt-api.js';
import { createLfmBackend } from '../src/dm/backends/lfm.js';
import { programSchema, validate, parseLoose } from '../src/dm/schema.js';

const promptMod = Object.values(import.meta.glob('../src/dm/prompt.js', { eager: true }))[0];
const scriptedMod = Object.values(import.meta.glob('../src/dm/backends/scripted.js', { eager: true }))[0];

const OPS_HELP = 'Ops: spawn{enemy,n,near,level} light{room,color,power} mood{as} sfx{cue,room} music{track} bless{what,amount,who} curse{what,secs,who} say{text,voice} quest{id,goal,title,room,enemy,n,party,reward}; role{room,as} guard{room,enemy,n,level} seal{room,open}. enemy: hollow|revenant|wisp|ogre. color: ember|blood|gold|frost|venom|violet|bone|void. mood: still|tense|grim|warm|cold|wrath.';
const systemFor = (kind) => promptMod?.systemFor?.(kind) ?? `You are the Dungeon Master of a crypt. Reply with ONLY a JSON array of at most ${kind === 'populate' ? 12 : 4} commands. ${OPS_HELP}\nExample: [{"op":"mood","as":"tense"},{"op":"spawn","enemy":"wisp","n":2,"near":"party"}]`;
const rooms = Array.from({ length: 12 }, (_, id) => ({ id, type: id === 0 ? 'entrance' : id === 11 ? 'boss' : 'combat', w: 9, h: 9, depth: id }));
const state = { floor: 2, seed: 7, party: [{ id: 'a', name: 'Mira' }], rooms, locked: [0, 11], quests: [], story: 'Mira entered the crypt.' };
const events = [{ type: 'kill', enemy: 'hollow', room: 3, who: 'a' }, { type: 'low_hp', who: 'a' }];
const promptFor = (kind) => promptMod?.promptFor?.(kind, state, events) ?? `Floor ${state.floor}, ${rooms.length} rooms (0..11). Party: Mira. Events: Mira killed a hollow in room 3. Mira is at low health. Write the program.`;

const out = document.getElementById('out');
const log = (s) => (out.textContent += '\n' + s);
const results = [];

// A spinning square, to see frames drop.
const ctx = document.getElementById('c').getContext('2d');
let last = performance.now();
let maxGap = 0;
let a = 0;
// rAF stalls in a hidden tab, so also watch the event loop with a short timer chain: the larger of the two is the main-thread gap.
let tlast = performance.now();
(function tick() {
	const n = performance.now();
	maxGap = Math.max(maxGap, n - tlast - 4);
	tlast = n;
	setTimeout(tick, 4);
})();
(function frame(t) {
	maxGap = Math.max(maxGap, t - last);
	last = t;
	a += 0.05;
	ctx.clearRect(0, 0, 160, 160);
	ctx.save();
	ctx.translate(80, 80);
	ctx.rotate(a);
	ctx.fillStyle = '#e8b04a';
	ctx.fillRect(-30, -30, 60, 60);
	ctx.restore();
	requestAnimationFrame(frame);
})(performance.now());

async function run(backend) {
	const row = { backend: backend.name, warmMs: 0, runs: [] };
	const t0 = performance.now();
	try {
		await backend.ready();
		for (const k of ['react', 'populate']) await backend.warm(k, systemFor(k), programSchema(k, rooms.length));
	} catch (e) {
		row.error = String(e?.message ?? e);
		return row;
	}
	row.warmMs = Math.round(performance.now() - t0);
	for (const kind of ['react', 'react', 'react', 'react', 'react', 'populate']) {
		const schema = programSchema(kind, rooms.length);
		const req = { kind, system: systemFor(kind), prompt: promptFor(kind), schema, maxTokens: { react: 128, populate: 320 }[kind], state, events };
		await new Promise((r) => setTimeout(r, 200));
		maxGap = 0;
		const t = performance.now();
		let text = '';
		let err = null;
		try {
			text = await backend.generate(req, { signal: AbortSignal.timeout(30000) });
		} catch (e) {
			err = String(e?.message ?? e);
		}
		const ms = Math.round(performance.now() - t);
		const cmds = validate(parseLoose(text), { kind, rooms: rooms.length, locked: new Set([0, 11]) });
		row.runs.push({ kind, ms, valid: cmds.length, maxGapMs: Math.round(maxGap), err, sample: text.slice(0, 160) });
	}
	return row;
}

const backends = [];
if ((await promptApiAvailability()) === 'available') backends.push(createPromptApiBackend());
if (navigator.gpu) backends.push(createLfmBackend({ base: new URL('/', location.href).href }));
if (scriptedMod?.createScriptedBackend) backends.push(scriptedMod.createScriptedBackend());
out.textContent = `backends: ${backends.map((b) => b.name).join(', ') || 'none'}`;
for (const b of backends) {
	log(`\n== ${b.name}`);
	const row = await run(b);
	results.push(row);
	if (row.error) log(`error: ${row.error}`);
	else {
		log(`warm ${row.warmMs} ms`);
		for (const r of row.runs) log(`${r.kind.padEnd(8)} ${String(r.ms).padStart(6)} ms  valid ${r.valid}  maxFrameGap ${r.maxGapMs} ms${r.err ? '  ERR ' + r.err : ''}`);
		log(`sample: ${row.runs[0].sample}`);
	}
	b.close?.();
}
window.__bench = results;
log('\ndone');
