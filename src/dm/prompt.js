// Prompts for the DM's language models. The system text is STATIC per kind (so backends can reuse the prefix); the prompt is the small, changing part.
// Tuned for a 350M model: terse, concrete, one few-shot example. Budget: system <= ~700 tokens, prompt <= ~300.
import { OPS, KINDS } from './schema.js';

const MAX_TOKENS = { plan: 96, populate: 320, react: 128 };
export const maxTokensFor = (kind) => MAX_TOKENS[kind] ?? 128;

const SHOT = {
	plan: '[{"op":"floor","palette":"molten","name":"The Ember Ossuary","rooms":12,"loops":0.3},{"op":"say","text":"Ash falls like snow. Go on.","voice":"dm"},{"op":"music","track":"dread"},{"op":"mood","as":"tense"}]',
	populate:
		'[{"op":"quest","id":"q1","goal":"kill","title":"Cull 5 hollows","enemy":"hollow","n":5,"reward":"heal"},{"op":"role","room":4,"as":"elite"},{"op":"guard","room":4,"enemy":"revenant","n":2,"level":1},{"op":"light","room":4,"color":"blood","power":1.5},{"op":"role","room":2,"as":"treasure"}]',
	react: '[{"op":"spawn","enemy":"wisp","n":3,"near":"party"},{"op":"light","room":3,"color":"violet","power":2},{"op":"say","text":"They gather.","voice":"whisper"}]',
};
const TASK = {
	plan: 'Design the next floor of the crypt: one floor command first, then a line to say, music, mood.',
	populate: 'Dress the built floor. Always include one quest. Make a few rooms elite, treasure or shrine, set guards, add lights. Never touch entrance or boss rooms.',
	react: 'React to what the players just did with a short, fitting consequence.',
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
		`Commands (max ${KINDS[kind].max}):`,
		...KINDS[kind].ops.map((op) => `{"op":"${op}",${OPS[op].map(fieldText).join(',')}}`),
		'Use only these ops and values.',
		`Example: ${SHOT[kind]}`,
	].join('\n'));
}

const nameOf = (state, who) => (state.party || []).find((p) => p.id === who)?.name ?? (who === 'me' ? 'you' : who ?? 'someone');

export function describeEvent(e, state = {}) {
	const who = e.who !== undefined ? ' ' + nameOf(state, e.who) : '';
	const room = e.room !== undefined ? ` r${e.room}` : '';
	switch (e.type) {
		case 'kill': return `kill ${e.enemy ?? ''}${room}${who}`;
		case 'enter': return `enter${room} ${e.role ?? ''}${who}`;
		case 'quest_progress': return `quest ${e.id} ${e.k}/${e.n}`;
		case 'quest_done': return `quest ${e.id} done`;
		case 'lull': return `quiet ${e.secs ?? 20}s`;
		case 'action': return `${e.what ?? 'act'}${who}`;
		default: return `${e.type}${room}${who}`;
	}
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
	} else {
		const qs = (state.quests || []).filter((q) => !q.done).slice(0, 3).map((q) => `${q.id} ${q.goal} ${q.k ?? 0}/${q.n ?? 1}`);
		if (qs.length) L.push(`Quests: ${qs.join('; ')}.`);
		if (state.story) L.push(`Story: ${String(state.story).slice(-160)}`);
		L.push('Events: ' + events.slice(-6).map((e) => describeEvent(e, state)).join('; '));
	}
	L.push('Reply with a JSON array only.');
	return L.join('\n');
}
