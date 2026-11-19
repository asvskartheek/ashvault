// The Dungeon Master agent (host only). Asks a backend for a program, gates it with schema.validate, falls back to the scripted DM on
// timeout, garbage or an empty result. One generation in flight; reactions are debounced and rate-limited. Time comes from tick(dt).
import { validate, parseLoose, programSchema } from './schema.js';
import { systemFor, promptFor, maxTokensFor } from './prompt.js';
import { scripted } from './backends/scripted.js';

const TIMEOUT = { plan: 4000, populate: 6000, react: 8000 };
const DEBOUNCE = 1.5; // secs after an event before reacting
const DEBOUNCE_PRIO = 0.3;
const MIN_GAP = 4; // never react more than once per this many secs
const LULL = 20;
const PRIORITY = new Set(['down', 'boss_dead', 'quest_done', 'join']);
const QUIET = new Set(['quest_progress']); // recorded as activity, never worth a reaction on their own

export function createDM({ backend, fallback = scripted, onProgram = () => {}, quests = null, timeouts = {}, story = '' } = {}) {
	const TO = { ...TIMEOUT, ...timeouts };
	const beats = story ? [String(story).slice(-600)] : [];
	const ctx = { seed: 1, party: [], floorNo: 0, floor: null, rooms: [], roomCount: 22, locked: new Set(), questCmds: [] };
	let seq = 0;
	let t = 0;
	let stopped = false;
	let current = null; // promise of the generation in flight
	let ctrl = null;
	let pending = [];
	let due = Infinity;
	let lastReact = -Infinity;
	let lastActivity = 0;
	let streak = 0;
	let lastKill = -99;

	const trim = () => {
		while (beats.join(' ').length > 600 && beats.length > 1) beats.shift();
		if (beats.length && beats[0].length > 600) beats[0] = beats[0].slice(-600);
	};
	const beat = (s) => {
		beats.push(s);
		trim();
	};
	const who = (id) => ctx.party.find((p) => p.id === id)?.name ?? (id === 'me' ? 'You' : 'Someone');
	const questTitle = (id) => (quests?.list().find((q) => q.id === id) ?? ctx.questCmds.find((q) => q.id === id))?.title ?? id;

	// reject on timeout (-> fallback) or on cancel (-> drop result)
	const guarded = (fn, ms, c) =>
		new Promise((res, rej) => {
			const id = setTimeout(() => {
				c.abort();
				rej(new Error('timeout'));
			}, ms);
			c.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
			Promise.resolve()
				.then(fn)
				.then(
					(v) => (clearTimeout(id), res(v)),
					(e) => (clearTimeout(id), rej(e)),
				);
		});

	async function generate(kind, state, events, vctx, actor) {
		const c = new AbortController();
		ctrl = c;
		const t0 = Date.now();
		const req = { kind, system: systemFor(kind), prompt: promptFor(kind, state, events), schema: programSchema(kind, vctx.rooms), maxTokens: maxTokensFor(kind), state, events };
		let cmds = [];
		let used = backend?.name ?? fallback.name;
		const fb = async () => validate(parseLoose(await fallback.generate(req, { signal: c.signal })), vctx);
		if (backend && backend !== fallback) {
			try {
				const text = await guarded(async () => ((await backend.ready()) && !c.signal.aborted ? backend.generate(req, { signal: c.signal }) : ''), TO[kind], c);
				cmds = validate(parseLoose(text), vctx);
			} catch {
				cmds = [];
			}
		}
		if (c.cancelled) return null;
		if (!cmds.length) {
			cmds = await fb();
			used = fallback.name;
		}
		// shape rules per kind
		if (kind === 'plan') {
			const floor = cmds.find((x) => x.op === 'floor') ?? (await fb()).find((x) => x.op === 'floor');
			cmds = floor ? [floor, ...cmds.filter((x) => x.op !== 'floor').slice(0, 3)] : cmds;
		} else if (kind === 'populate' && !cmds.some((x) => x.op === 'quest')) {
			const q = (await fb()).find((x) => x.op === 'quest');
			if (q) cmds = [q, ...cmds].slice(0, 12);
		}
		if (ctrl === c) ctrl = null;
		const meta = { seq: ++seq, kind, backend: used, ms: Date.now() - t0, actor };
		return { cmds, meta };
	}

	// plan/populate pre-empt a reaction in flight
	async function exclusive(kind, state, events, vctx, actor) {
		if (ctrl) {
			ctrl.cancelled = true;
			ctrl.abort();
		}
		await current?.catch(() => {});
		const p = generate(kind, state, events, vctx, actor);
		current = p;
		const r = await p;
		if (current === p) current = null;
		if (stopped || !r) return [];
		onProgram(r.cmds, r.meta);
		return r.cmds;
	}

	function maybeReact() {
		if (stopped || current || !pending.length || t < due || t - lastReact < MIN_GAP || !ctx.rooms.length) return;
		const events = pending;
		pending = [];
		due = Infinity;
		lastReact = t;
		const prio = events.find((e) => PRIORITY.has(e.type)) ?? events[events.length - 1];
		const state = { seed: ctx.seed, floorNo: ctx.floorNo, floor: ctx.floor, party: ctx.party, rooms: ctx.rooms, story: dm.story, streak, quests: quests?.list() ?? ctx.questCmds.map((q) => ({ ...q, k: 0 })) };
		if (events.some((e) => e.type === 'kill') && streak >= 4) streak = 0;
		const p = generate('react', state, events, { kind: 'react', rooms: ctx.roomCount }, prio?.who).then((r) => {
			if (current === p) current = null;
			if (stopped || !r) return;
			onProgram(r.cmds, r.meta);
		});
		current = p;
	}

	const dm = {
		get story() {
			return beats.join(' ');
		},
		async plan({ floor = 1, seed = 1, party = [], story: s } = {}) {
			ctx.floorNo = Math.max(1, Math.round(+floor) || 1);
			ctx.seed = seed;
			ctx.party = party;
			ctx.rooms = [];
			ctx.questCmds = [];
			pending = [];
			if (s && !beats.length) beat(String(s).slice(-600));
			const cmds = await exclusive('plan', { floorNo: ctx.floorNo, floor: ctx.floorNo, seed, party, story: dm.story }, [], { kind: 'plan', rooms: 22 });
			ctx.floor = cmds.find((c) => c.op === 'floor') ?? null;
			if (ctx.floor) beat(`Floor ${ctx.floorNo}: ${ctx.floor.name ?? ctx.floor.palette}.`);
			return cmds;
		},
		async populate({ rooms = [], locked = [], party = ctx.party } = {}) {
			ctx.rooms = rooms;
			ctx.roomCount = Math.max(1, ...rooms.map((r) => r.id + 1));
			ctx.locked = new Set(locked);
			ctx.party = party;
			const state = { floorNo: ctx.floorNo, floor: ctx.floor, seed: ctx.seed, rooms, locked: ctx.locked, party, story: dm.story };
			const cmds = await exclusive('populate', state, [], { kind: 'populate', rooms: ctx.roomCount, locked: ctx.locked });
			ctx.questCmds = cmds.filter((c) => c.op === 'quest');
			lastActivity = t;
			return cmds;
		},
		observe(e) {
			if (stopped || !e?.type) return;
			if (e.type !== 'lull') lastActivity = t;
			if (e.type === 'kill') {
				streak = t - lastKill > 10 ? 1 : streak + 1;
				lastKill = t;
			} else if (e.type === 'down') streak = 0;
			if (e.type === 'down') beat(`${who(e.who)} fell.`);
			else if (e.type === 'boss_dead') beat('The warden died.');
			else if (e.type === 'quest_done') beat(`Done: ${questTitle(e.id)}.`);
			else if (e.type === 'join') beat(`${who(e.who)} joined.`);
			else if (e.type === 'leave') beat(`${who(e.who)} left.`);
			else if (e.type === 'shrine') beat(`${who(e.who)} prayed.`);
			else if (e.type === 'treasure') beat(`${who(e.who)} looted.`);
			if (QUIET.has(e.type)) return;
			pending.push(e);
			if (pending.length > 8) pending.splice(0, pending.length - 8);
			due = Math.min(due, t + (PRIORITY.has(e.type) ? DEBOUNCE_PRIO : DEBOUNCE));
		},
		tick(dt) {
			if (stopped) return;
			t += dt;
			if (ctx.rooms.length && !pending.length && !current && t - lastActivity >= LULL) {
				const secs = Math.round(t - lastActivity);
				dm.observe({ type: 'lull', secs });
				lastActivity = t;
			}
			maybeReact();
		},
		idle: async () => {
			while (current) await current.catch(() => {});
		},
		stop() {
			stopped = true;
			if (ctrl) {
				ctrl.cancelled = true;
				ctrl.abort();
			}
		},
	};
	return dm;
}
