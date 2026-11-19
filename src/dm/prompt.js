// Prompts for the DM's language models. The system text is STATIC per kind (so backends can reuse the prefix); the prompt is the small, changing part.
// Tuned for a 350M model: terse, concrete, one few-shot example. Budget: system <= ~700 tokens, prompt <= ~300.
import { OPS, KINDS } from './schema.js';

const MAX_TOKENS = { plan: 96, populate: 320, react: 128 };
export const maxTokensFor = (kind) => MAX_TOKENS[kind] ?? 128;

// Few-shots: event -> program pairs for react (so the model adapts them), one full program for plan and populate.
const SHOT = {
	plan: '[{"op":"floor","palette":"molten","name":"The Ember Ossuary","rooms":12,"loops":0.3},{"op":"say","text":"Ash falls like snow. Go on.","voice":"dm"},{"op":"music","track":"dread"},{"op":"mood","as":"tense"}]',
	populate:
		'[{"op":"quest","id":"q1","goal":"kill","title":"Cull 5 hollows","enemy":"hollow","n":5,"reward":"heal"},{"op":"role","room":6,"as":"elite"},{"op":"guard","room":6,"enemy":"revenant","n":2,"level":1},{"op":"light","room":6,"color":"blood","power":1.5},{"op":"role","room":3,"as":"treasure"},{"op":"guard","room":4,"enemy":"hollow","n":3,"level":0}]',
};
const REACT_SHOTS = [
	['', '[{"op":"bless","what":"heal","amount":30,"who":"actor"},{"op":"spawn","enemy":"revenant","n":2,"near":"party","level":1},{"op":"say","text":"Your wounds knit. The dark grows hungry.","voice":"dm"}]'],
	['', '[{"op":"light","room":5,"color":"gold","power":2},{"op":"sfx","cue":"coins","room":5},{"op":"say","text":"Something glitters in the dust.","voice":"whisper"}]'],
	['', '[{"op":"spawn","enemy":"hollow","n":3,"near":"party","level":0},{"op":"say","text":"They keep coming.","voice":"whisper"}]'],
	['', '[{"op":"spawn","enemy":"wisp","n":2,"near":"party","level":0},{"op":"mood","as":"tense"},{"op":"say","text":"Too quiet. Something stirs.","voice":"dm"}]'],
	['', '[{"op":"bless","what":"xp","amount":40,"who":"all"},{"op":"sfx","cue":"levelUp"},{"op":"say","text":"Well done. It will not last.","voice":"boss"}]'],
];
const TASK = {
	plan: 'Design the next floor of the crypt: one floor command first, then a line to say, music, mood.',
	populate: 'Dress the built floor. Follow the Do: list in order, fill in every field, then add a few more guards or lights. Never touch entrance or boss rooms.',
	react: 'React to what the players just did. Follow the Do: list in order, fill in every field, and end with a short line to say.',
};

const fieldText = ([name, k, a, b]) => {
	const v = k === 'enum' ? a.join('|') : k === 'int' || k === 'num' ? `${a}-${b}` : k === 'bool' ? 'true|false' : k === 'room' ? 'room number' : `text<=${a}`;
	return `"${name}":${v}`;
};

const cache = {};
export function systemFor(kind) {
	return (cache[kind] ??= [
		'You are the Dungeon Master of a dark crypt game. Reply with a JSON array only. No prose, no markdown.',
		TASK[kind],
		`Commands (max ${KINDS[kind].max}, each field in this order):`,
		...KINDS[kind].ops.filter((op) => !(kind === 'react' && op === 'quest') && !(kind === 'populate' && op === 'seal')).map((op) => `{"op":"${op}",${OPS[op].map(fieldText).join(',')}}`),
		'Use only these ops and values.',
	].join('\n'));
}

// Worked examples as chat turns (user prompt in the real format -> program); a 350M model follows these far better than prose.
const MIRA = { party: [{ id: 'a', name: 'Mira' }], floorNo: 2, floor: { name: 'The Ash Vault', palette: 'molten' }, quests: [{ id: 'q1', goal: 'kill', k: 3, n: 5 }] };
const ROOMS = Array.from({ length: 10 }, (_, id) => ({ id, type: id === 0 ? 'entrance' : id === 9 ? 'boss' : 'combat', depth: id }));
const REACT_EVENTS = [
	[{ type: 'kill', enemy: 'hollow', room: 3, who: 'a' }, { type: 'low_hp', who: 'a' }],
	[{ type: 'enter', room: 5, role: 'treasure', who: 'a' }],
	[{ type: 'kill', enemy: 'hollow', room: 2, who: 'a' }, { type: 'kill', enemy: 'hollow', room: 2, who: 'a' }, { type: 'kill', enemy: 'wisp', room: 2, who: 'a' }],
	[{ type: 'lull', secs: 25 }],
	[{ type: 'quest_done', id: 'q1' }],
];
const shotCache = {};
export function shotsFor(kind) {
	return (shotCache[kind] ??= kind === 'react'
		? REACT_SHOTS.map(([, a], i) => [promptFor('react', MIRA, REACT_EVENTS[i]), a])
		: kind === 'populate'
			? [[promptFor('populate', { ...MIRA, rooms: ROOMS, locked: new Set([0, 9]) }, []), SHOT.populate]]
			: [[promptFor('plan', { party: MIRA.party, floorNo: 2 }, []), SHOT.plan]]);
}

const nameOf = (state, who) => (state.party || []).find((p) => p.id === who)?.name ?? (who === 'me' ? 'you' : who ?? 'someone');

export function describeEvent(e, state = {}) {
	const who = e.who !== undefined ? nameOf(state, e.who) : 'The party';
	const room = e.room !== undefined ? ` in room ${e.room}` : '';
	switch (e.type) {
		case 'kill': return `${who} killed a ${e.enemy ?? 'foe'}${room}`;
		case 'enter': return `${who} entered room ${e.room ?? '?'}${e.role ? ` (${e.role})` : ''}`;
		case 'quest_progress': return `Quest ${e.id} is at ${e.k}/${e.n}`;
		case 'quest_done': return `Quest ${e.id} is complete`;
		case 'lull': return `Quiet for ${e.secs ?? 20}s`;
		case 'low_hp': return `${who} is at low health`;
		case 'room_clear': return `${who} cleared room ${e.room ?? '?'}`;
		case 'action': return `${who} ${e.what ?? 'acted'}`;
		default: return `${e.type}${room} ${who}`.trim();
	}
}

// What a good DM does for each kind of event, as the opening words of the commands. A 350M model copies and fills these far more
// reliably than it reasons from events to ops; the grammar then makes every filled-in command valid.
const BIGGER = { hollow: 'revenant', revenant: 'ogre', wisp: 'hollow', ogre: 'ogre' };
function ideaFor(e) {
	switch (e.type) {
		case 'kill': return [`spawn ${BIGGER[e.enemy] ?? 'hollow'} near party`];
		case 'low_hp': return ['bless heal'];
		case 'enter': return e.role === 'treasure' ? [`light room ${e.room} gold`, 'sfx coins'] : e.role === 'elite' ? ['music battle', `light room ${e.room} blood`] : e.role === 'shrine' ? [`light room ${e.room} venom`] : ['mood tense'];
		case 'quest_done': return ['bless xp', 'sfx levelUp'];
		case 'quest_progress': return ['sfx bell'];
		case 'lull': return ['spawn wisp near party', 'mood tense'];
		case 'room_clear': return ['sfx bell', 'mood warm'];
		default: return [];
	}
}
export function ideasFor(events = []) {
	const out = [];
	for (const e of events.slice(-6).reverse()) for (const i of ideaFor(e)) if (!out.some((o) => o.split(' ')[0] === i.split(' ')[0])) out.push(i);
	return [...out.slice(0, 3), 'say'];
}

// Rooms the populate hint points at: mid-depth for the elite, early for treasure, between for a guard. Skips locked rooms.
function pickRooms(state) {
	const lock = new Set(state.locked ? [...state.locked] : []);
	const free = (state.rooms || []).filter((r) => !lock.has(r.id) && r.type !== 'entrance' && r.type !== 'boss').sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
	const at = (f) => free[Math.min(free.length - 1, Math.floor(free.length * f))]?.id ?? 1;
	return { elite: at(0.7), treasure: at(0.25), guard: at(0.45) };
}

export function promptFor(kind, state = {}, events = []) {
	const L = [];
	const party = (state.party || []).map((p) => p.name + (p.bot ? ' (bot)' : '')).join(', ') || 'one hero';
	if (kind === 'plan') {
		L.push(`Floor ${state.floorNo ?? state.floor ?? 1}. Party: ${party}.`);
		if (state.story) L.push(`Story: ${String(state.story).slice(-200)}`);
		L.push('Reply with a JSON array only.');
		return L.join('\n');
	}
	const f = state.floor && typeof state.floor === 'object' ? state.floor : {};
	L.push(`Floor ${state.floorNo ?? 1}: ${f.name ?? 'the crypt'} (${f.palette ?? 'grim'}). Party: ${party}.`);
	if (kind === 'populate') {
		const lock = (state.locked ? [...state.locked] : []).join(',');
		L.push('Rooms: ' + (state.rooms || []).slice(0, 22).map((r) => `${r.id} ${r.type} d${r.depth ?? 0}`).join('; '));
		L.push(`Locked (no role): ${lock || 'none'}.`);
		const r = pickRooms(state);
		L.push(`Do: quest; role room ${r.elite} elite; guard room ${r.elite}; light room ${r.elite}; role room ${r.treasure} treasure; guard room ${r.guard}.`);
	} else {
		L.push('Events: ' + events.slice(-6).map((e) => describeEvent(e, state)).join('. ') + '.');
		L.push('Do: ' + ideasFor(events).join('; ') + '.');
	}
	L.push('Reply with a JSON array only.');
	return L.join('\n');
}
