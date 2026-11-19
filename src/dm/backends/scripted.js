// The scripted DM: deterministic (seeded from state), no model. Always available; also the fallback for every other backend.
import { PALETTES } from './../schema.js';

const hash = (s) => {
	s = String(s);
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
};
const rng = (seed) => {
	let a = hash(seed);
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};
const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const shuffle = (r, a) => {
	a = a.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
};

const ADJ = {
	ancient: ['Gilded', 'Sunken', 'Forgotten'],
	molten: ['Ember', 'Ashen', 'Cinder'],
	frost: ['Frozen', 'Rimed', 'Pale'],
	grim: ['Weeping', 'Hollow', 'Black'],
	verdant: ['Drowned', 'Mossy', 'Choking'],
};
const NOUN = ['Ossuary', 'Vault', 'Reliquary', 'Catacomb', 'Sepulchre', 'Crypt', 'Undercroft'];
const MOOD = { ancient: 'still', molten: 'wrath', frost: 'cold', grim: 'grim', verdant: 'tense' };
const GLOW = { ancient: 'gold', molten: 'ember', frost: 'frost', grim: 'blood', verdant: 'venom' };
const INTRO = {
	ancient: ['Old kings sleep badly here.', 'Dust remembers every footstep.'],
	molten: ['The walls are still warm. Something stoked them.', 'Ash falls like snow. Go on.'],
	frost: ['Your breath hangs. So do the dead.', 'The cold here is patient.'],
	grim: ['Something weeps below. It is not grief.', 'No one has left this place whole.'],
	verdant: ['The roots have been feeding. Mind your step.', 'Green things grow where they should not.'],
};

const floorNo = (s) => Math.max(1, Math.round(+(s.floorNo ?? (typeof s.floor === 'number' ? s.floor : 1)) || 1));
const seedOf = (s) => s.seed ?? 1;
const nameOf = (s, who) => (s.party || []).find((p) => p.id === who)?.name ?? (who === 'me' ? 'you' : 'one of you');

function plan(s) {
	const n = floorNo(s);
	const r = rng(`${seedOf(s)}|plan|${n}`);
	const pal = PALETTES[(hash(seedOf(s)) + n - 1) % PALETTES.length];
	const name = `The ${pick(r, ADJ[pal])} ${NOUN[(hash(seedOf(s)) + n * 3 + int(r, 0, 2)) % NOUN.length]}`;
	const who = s.party?.[0]?.name;
	const line = r() < 0.35 && who ? `${who}, ${pick(r, INTRO[pal]).replace(/^./, (c) => c.toLowerCase())}` : pick(r, INTRO[pal]);
	return [
		{ op: 'floor', palette: pal, name, rooms: Math.min(20, 9 + n * 2 + int(r, 0, 2)), loops: Math.round((0.15 + r() * 0.3) * 100) / 100 },
		{ op: 'say', text: `${name}. ${line}`.slice(0, 140), voice: 'dm' },
		{ op: 'music', track: n === 1 ? 'calm' : 'dread' },
		{ op: 'mood', as: MOOD[pal] },
	];
}

function populate(s) {
	const n = floorNo(s);
	const r = rng(`${seedOf(s)}|pop|${n}`);
	const pal = s.floor?.palette ?? 'grim';
	const lvl = Math.min(4, n - 1);
	const locked = new Set(s.locked || []);
	const cand = (s.rooms || []).filter((x) => !locked.has(x.id) && x.type !== 'entrance' && x.type !== 'boss');
	const byDepth = cand.slice().sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
	const out = [];

	// roles: elite deep, treasure and shrine anywhere else
	const elite = byDepth.length ? byDepth[Math.floor(r() * Math.min(3, byDepth.length))] : null;
	const rest = shuffle(r, cand.filter((x) => x !== elite));
	const treasure = rest.pop();
	const shrine = rest.pop();
	const fight = rest.filter((x) => x.type === 'combat' || x.type === undefined).slice(0, 2);

	// quests: 1 to 3, first is always playable alone
	const qs = [];
	if (r() < 0.25) qs.push({ op: 'quest', id: 'q1', goal: 'survive', title: 'Hold out until dawn stirs', n: int(r, 30, 60), reward: 'ward' });
	else {
		const k = int(r, 4, 8);
		qs.push({ op: 'quest', id: 'q1', goal: 'kill', title: `Cull ${k} hollows`, enemy: 'hollow', n: k, reward: pick(r, ['heal', 'potion']) });
	}
	if (elite && r() < 0.6) qs.push({ op: 'quest', id: 'q2', goal: 'cleanse', title: 'Purge the deep chamber', room: elite.id, reward: pick(r, ['xp', 'ward']) });
	if (r() < 0.45) qs.push({ op: 'quest', id: 'q3', goal: 'boss', title: 'Fell the warden, together', party: int(r, 2, 3), reward: 'xp' });
	out.push(...qs);

	if (elite) {
		out.push({ op: 'role', room: elite.id, as: 'elite' });
		out.push({ op: 'guard', room: elite.id, enemy: n >= 3 && r() < 0.5 ? 'ogre' : 'revenant', n: int(r, 1, 2 + (n > 2)), level: lvl });
	}
	if (treasure) out.push({ op: 'role', room: treasure.id, as: 'treasure' });
	if (shrine) out.push({ op: 'role', room: shrine.id, as: 'shrine' });
	for (const f of fight) out.push({ op: 'guard', room: f.id, enemy: pick(r, ['hollow', 'hollow', 'wisp']), n: int(r, 3, 5), level: lvl });
	out.push({ op: 'say', text: pick(r, ['The strongest of them waits where it is darkest.', 'Not every door is kind. Some are honest.', 'Take what the dead left. They will want it back.']), voice: 'dm' });
	if (elite) out.push({ op: 'light', room: elite.id, color: GLOW[pal] ?? 'blood', power: 1.6 });
	if (shrine) out.push({ op: 'light', room: shrine.id, color: 'gold', power: 2 });
	return out.slice(0, 12);
}

function react(s, events) {
	const ev = events || [];
	const r = rng(`${seedOf(s)}|react|${hash(JSON.stringify(ev))}|${s.floorNo ?? 1}`);
	const has = (t) => ev.find((e) => e.type === t);
	const n = floorNo(s);
	const lvl = Math.min(4, n - 1);
	let e;
	if ((e = has('boss_dead'))) {
		return [
			{ op: 'music', track: 'calm' },
			{ op: 'sfx', cue: 'levelUp' },
			{ op: 'mood', as: 'warm' },
			{ op: 'say', text: pick(r, ['It is done. The dark exhales.', 'The warden falls. Breathe.']), voice: 'dm' },
		];
	}
	if ((e = has('down'))) {
		return [
			{ op: 'bless', what: 'heal', amount: 40, who: 'actor' },
			{ op: 'say', text: `${nameOf(s, e.who)} is down. The crypt shows mercy. Once.`, voice: 'dm' },
		];
	}
	if ((e = has('quest_done'))) {
		return [
			{ op: 'sfx', cue: 'bell' },
			{ op: 'say', text: pick(r, ['Well fought. Do not get comfortable.', 'A debt is paid. Another is owed.']), voice: 'dm' },
		];
	}
	if ((e = has('low_hp'))) {
		return [
			{ op: 'bless', what: 'potion', amount: 1, who: 'actor' },
			{ op: 'say', text: `${nameOf(s, e.who)} is fading.`, voice: 'whisper' },
		];
	}
	if ((e = has('treasure'))) {
		if (r() < 0.5) return [{ op: 'curse', what: pick(r, ['slow', 'dark', 'poison']), secs: int(r, 8, 16), who: 'actor' }, { op: 'sfx', cue: 'whisper' }, { op: 'say', text: 'Gold is never free.', voice: 'whisper' }];
		return [{ op: 'sfx', cue: 'coins' }, { op: 'say', text: `${nameOf(s, e.who)} grows richer. The crypt watches.`, voice: 'dm' }];
	}
	if ((e = has('shrine'))) {
		return [{ op: 'bless', what: pick(r, ['mana', 'ward', 'haste']), amount: 30, who: 'actor' }, { op: 'sfx', cue: 'bell' }, { op: 'say', text: 'The old gods hear. Briefly.', voice: 'dm' }];
	}
	if ((e = has('join'))) return [{ op: 'say', text: `${nameOf(s, e.who)} descends to join you.`, voice: 'dm' }];
	if ((s.streak ?? 0) >= 4 || ev.filter((x) => x.type === 'kill').length >= 4) {
		const k = [...ev].reverse().find((x) => x.type === 'kill');
		const out = [{ op: 'spawn', enemy: 'wisp', n: int(r, 3, 4), near: 'party', level: lvl }];
		if (k?.room !== undefined) out.push({ op: 'light', room: k.room, color: 'violet', power: 2 });
		out.push({ op: 'say', text: pick(r, ['So much death. They gather.', 'You feed it well.']), voice: 'whisper' });
		return out;
	}
	if ((e = has('lull'))) {
		return [
			{ op: 'sfx', cue: 'rise' },
			{ op: 'spawn', enemy: pick(r, ['hollow', 'hollow', 'revenant']), n: int(r, 2, 3), near: 'party', level: lvl },
			{ op: 'mood', as: 'tense' },
			{ op: 'say', text: 'Quiet. Too quiet.', voice: 'whisper' },
		];
	}
	if ((e = has('room_clear'))) {
		return [{ op: 'music', track: 'calm' }, e.room !== undefined ? { op: 'light', room: e.room, color: 'gold', power: 1.2 } : { op: 'mood', as: 'still' }];
	}
	if ((e = has('enter')) && (e.role === 'elite' || e.role === 'shrine')) {
		return e.role === 'elite' ? [{ op: 'sfx', cue: 'roar', room: e.room }, { op: 'music', track: 'battle' }] : [{ op: 'sfx', cue: 'bell', room: e.room }, { op: 'mood', as: 'warm' }];
	}
	return [{ op: 'light', room: ev.find((x) => x.room !== undefined)?.room ?? 0, color: pick(r, ['ember', 'violet', 'bone']), power: 1.2 }];
}

export function scriptedProgram(kind, state = {}, events = []) {
	return kind === 'plan' ? plan(state) : kind === 'populate' ? populate(state) : react(state, events);
}

export const scripted = {
	name: 'scripted',
	async ready() {
		return true;
	},
	async warm() {},
	async generate(req) {
		return JSON.stringify(scriptedProgram(req.kind, req.state, req.events));
	},
};
export const createScriptedBackend = () => scripted;
export default scripted;
