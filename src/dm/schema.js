// The Dungeon Master's world code: the only thing any DM backend (Chrome's built-in model, a Liquid LFM in WebGPU, or the scripted DM)
// may produce. A program is a JSON array of commands. Every enum comes from what the game already has, so the DM composes the world
// from existing parts; it never makes assets. validate() is the gate: it drops what it can't read and clamps every number.

// The crypt is always built with the generator's crypt rules; a palette is one of the five themes' looks laid over it.
export const PALETTES = ['ancient', 'molten', 'frost', 'grim', 'verdant'];
export const ENEMIES = ['hollow', 'revenant', 'wisp', 'ogre'];
// What the DM may make a room. 'entrance' and 'boss' rooms are the generator's and locked; nothing becomes a boss room.
export const ROLES = ['combat', 'elite', 'treasure', 'shrine', 'empty'];
export const SFX = ['rise', 'roar', 'door', 'bell', 'boneBreak', 'explode', 'shockwave', 'levelUp', 'pickup', 'hurt', 'coins', 'whisper', 'quake'];
export const MUSIC = ['calm', 'dread', 'battle', 'boss', 'silence'];
export const GOALS = ['kill', 'reach', 'survive', 'cleanse', 'boss'];
export const BLESSINGS = ['heal', 'mana', 'potion', 'xp', 'haste', 'ward'];
export const CURSES = ['dark', 'poison', 'slow', 'frenzy'];
// A mood sets fog, exposure and grade together.
export const MOODS = ['still', 'tense', 'grim', 'warm', 'cold', 'wrath'];
export const COLORS = { ember: '#ff7a30', blood: '#c0202a', gold: '#e8b04a', frost: '#9fd8ff', venom: '#7fe04a', violet: '#9b6cf0', bone: '#e8e0c8', void: '#30206a' };
const COLOR_NAMES = Object.keys(COLORS);

// One entry per op: its fields, as [name, kind, ...limits]. kinds: enum <list>, int <min> <max>, num <min> <max>, text <maxLen>, room, bool.
export const OPS = {
	floor: [['palette', 'enum', PALETTES], ['name', 'text', 40], ['rooms', 'int', 8, 22], ['loops', 'num', 0, 0.8]],
	role: [['room', 'room'], ['as', 'enum', ROLES]],
	guard: [['room', 'room'], ['enemy', 'enum', ENEMIES], ['n', 'int', 1, 8], ['level', 'int', 0, 4]],
	spawn: [['enemy', 'enum', ENEMIES], ['n', 'int', 1, 6], ['near', 'enum', ['party', 'room']], ['room', 'room'], ['level', 'int', 0, 4]],
	light: [['room', 'room'], ['color', 'enum', COLOR_NAMES], ['power', 'num', 0, 3]],
	mood: [['as', 'enum', MOODS]],
	sfx: [['cue', 'enum', SFX], ['room', 'room']],
	music: [['track', 'enum', MUSIC]],
	bless: [['what', 'enum', BLESSINGS], ['amount', 'int', 1, 100], ['who', 'enum', ['all', 'actor']]],
	curse: [['what', 'enum', CURSES], ['secs', 'int', 3, 60], ['who', 'enum', ['all', 'actor']]],
	seal: [['room', 'room'], ['open', 'bool']],
	say: [['text', 'text', 140], ['voice', 'enum', ['dm', 'whisper', 'boss']]],
	// party: how many characters the mission wants; the host fills the gap with companions. reward is paid by quests.js on completion.
	quest: [['id', 'text', 12], ['goal', 'enum', GOALS], ['title', 'text', 60], ['room', 'room'], ['enemy', 'enum', ENEMIES], ['n', 'int', 1, 30], ['party', 'int', 1, 12], ['reward', 'enum', BLESSINGS]],
};

// Fields an op can't do without.
export const NEED = { floor: ['palette'], role: ['room', 'as'], guard: ['room', 'enemy', 'n'], spawn: ['enemy', 'n'], light: ['room', 'color'], mood: ['as'], sfx: ['cue'], music: ['track'], bless: ['what'], curse: ['what'], seal: ['room'], say: ['text'], quest: ['id', 'goal', 'title'] };
// And per quest goal.
export const GOAL_NEED = { kill: ['enemy', 'n'], reach: ['room'], cleanse: ['room'], survive: ['n'], boss: [] };

// Ops that change shared state: only the host's world runs them; everyone else gets their result through snapshots.
export const HOST_ONLY = new Set(['guard', 'spawn', 'bless', 'curse', 'quest', 'role', 'seal']);

// The three kinds of program: which ops each may use and how many commands.
// plan: at floor start, before the floor is built. populate: once built, overrides on the generator's defaults. react: a short consequence.
export const KINDS = {
	plan: { ops: ['floor', 'say', 'music', 'mood'], max: 4 },
	populate: { ops: ['role', 'guard', 'quest', 'light', 'seal', 'say', 'music', 'mood'], max: 12 },
	react: { ops: ['spawn', 'light', 'mood', 'sfx', 'music', 'bless', 'curse', 'say', 'quest'], max: 4 },
};

// JSON Schema of one kind of program, for backends that can constrain output to one (Chrome's Prompt API responseConstraint).
export function programSchema(kind = 'react', rooms = 22) {
	const K = KINDS[kind];
	const field = ([, k, a, b]) => {
		if (k === 'enum') return { type: 'string', enum: a };
		if (k === 'int') return { type: 'integer', minimum: a, maximum: b };
		if (k === 'room') return { type: 'integer', minimum: 0, maximum: Math.max(0, rooms - 1) };
		if (k === 'num') return { type: 'number', minimum: a, maximum: b };
		if (k === 'bool') return { type: 'boolean' };
		return { type: 'string', maxLength: a };
	};
	return {
		type: 'array',
		minItems: 1,
		maxItems: K.max,
		items: {
			anyOf: K.ops.map((op) => ({
				type: 'object',
				properties: { op: { const: op }, ...Object.fromEntries(OPS[op].map((f) => [f[0], field(f)])) },
				required: ['op', ...NEED[op]],
				additionalProperties: false,
			})),
		},
	};
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// A program in, the commands the game may run out.
// ctx: { kind: 'plan'|'populate'|'react', rooms: number of rooms, locked: Set of room ids no `role` may change (entrance, boss) }.
export function validate(program, ctx = {}) {
	const K = KINDS[ctx.kind ?? 'react'];
	const rooms = ctx.rooms ?? 22;
	const out = [];
	for (const c of Array.isArray(program) ? program : []) {
		if (!c || typeof c !== 'object' || !K.ops.includes(c.op)) continue;
		const cmd = { op: c.op };
		for (const [name, kind, a, b] of OPS[c.op]) {
			let v = c[name];
			if (v === undefined || v === null) continue;
			if (kind === 'enum') {
				const hit = typeof v === 'string' && a.find((x) => x.toLowerCase() === v.trim().toLowerCase());
				if (hit) cmd[name] = hit;
			} else if (kind === 'int') {
				if (Number.isFinite(+v)) cmd[name] = clamp(Math.round(+v), a, b);
			} else if (kind === 'num') {
				if (Number.isFinite(+v)) cmd[name] = clamp(+v, a, b);
			} else if (kind === 'room') {
				if (Number.isInteger(+v) && +v >= 0 && +v < rooms) cmd[name] = +v;
			} else if (kind === 'bool') cmd[name] = v === true || v === 'true' || v === 1;
			else if (typeof v === 'string') cmd[name] = v.replace(/[<>]/g, '').slice(0, a).trim();
		}
		if (!NEED[c.op].every((k) => cmd[k] !== undefined && cmd[k] !== '')) continue;
		if (c.op === 'quest' && !GOAL_NEED[cmd.goal].every((k) => cmd[k] !== undefined)) continue;
		if (c.op === 'role' && ctx.locked?.has(cmd.room)) continue;
		out.push(cmd);
		if (out.length >= K.max) break;
	}
	return out;
}

// Small models don't always close their JSON. Pull out every complete {...} object at depth 1, so a cut-off program still yields its whole commands.
export function parseLoose(text) {
	const s = String(text ?? '');
	try {
		const v = JSON.parse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1));
		if (Array.isArray(v)) return v;
	} catch {}
	const out = [];
	let depth = 0;
	let start = -1;
	let inStr = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (ch === '\\') i++;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === '{') {
			if (depth++ === 0) start = i;
		} else if (ch === '}' && depth > 0 && --depth === 0) {
			try {
				out.push(JSON.parse(s.slice(start, i + 1)));
			} catch {}
		}
	}
	return out;
}
