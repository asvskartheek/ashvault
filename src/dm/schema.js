// The Dungeon Master's world code: the only thing any DM backend (Chrome's built-in model, a Liquid LFM in WebGPU, or the scripted DM)
// may produce. A program is a JSON array of commands. Every enum comes from what the game already has, so the DM composes the world
// from existing parts; it never makes assets. validate() is the gate: it drops what it can't read and clamps every number.

export const THEMES = ['ancient', 'molten', 'frost', 'grim', 'verdant'];
export const ENEMIES = ['hollow', 'revenant', 'wisp', 'ogre'];
export const ROLES = ['combat', 'elite', 'treasure', 'shrine', 'boss', 'empty'];
export const SFX = ['rise', 'roar', 'door', 'bell', 'boneBreak', 'explode', 'shockwave', 'levelUp', 'pickup', 'hurt', 'coins', 'whisper', 'quake'];
export const MUSIC = ['calm', 'dread', 'battle', 'boss', 'silence'];
export const GOALS = ['kill', 'reach', 'survive', 'cleanse', 'escort', 'boss'];
export const BLESSINGS = ['heal', 'mana', 'potion', 'xp', 'haste', 'ward'];
export const CURSES = ['dark', 'poison', 'slow', 'frenzy'];
export const MOODS = ['still', 'tense', 'grim', 'warm', 'cold', 'wrath'];

// One entry per op: its fields, as [name, kind, ...limits]. kinds: enum <list>, int <min> <max>, num <min> <max>, color, text <maxLen>, room, bool.
export const OPS = {
	// Floor genesis (only at floor start; ignored mid-floor).
	floor: [['theme', 'enum', THEMES], ['name', 'text', 40], ['rooms', 'int', 8, 22], ['loops', 'num', 0, 0.8]],
	// Room roles and what waits in them.
	role: [['room', 'room'], ['as', 'enum', ROLES]],
	guard: [['room', 'room'], ['enemy', 'enum', ENEMIES], ['n', 'int', 1, 8], ['level', 'int', 0, 4]],
	// Live consequences anywhere, any time.
	spawn: [['enemy', 'enum', ENEMIES], ['n', 'int', 1, 6], ['near', 'enum', ['party', 'room']], ['room', 'room'], ['level', 'int', 0, 4]],
	light: [['room', 'room'], ['color', 'color'], ['power', 'num', 0, 3]],
	fog: [['color', 'color'], ['density', 'num', 0, 2]],
	mood: [['as', 'enum', MOODS]],
	sfx: [['cue', 'enum', SFX], ['room', 'room']],
	music: [['track', 'enum', MUSIC]],
	shake: [['power', 'num', 0, 1]],
	bless: [['what', 'enum', BLESSINGS], ['amount', 'int', 1, 100], ['who', 'enum', ['all', 'actor']]],
	curse: [['what', 'enum', CURSES], ['secs', 'int', 3, 60], ['who', 'enum', ['all', 'actor']]],
	seal: [['room', 'room'], ['open', 'bool']],
	// Story.
	say: [['text', 'text', 140], ['voice', 'enum', ['dm', 'whisper', 'boss']]],
	quest: [['id', 'text', 12], ['goal', 'enum', GOALS], ['title', 'text', 60], ['room', 'room'], ['enemy', 'enum', ENEMIES], ['n', 'int', 1, 30], ['party', 'int', 1, 12]],
	complete: [['id', 'text', 12], ['reward', 'enum', BLESSINGS]],
	companions: [['n', 'int', 0, 11]],
};

// JSON Schema of a program, for backends that can constrain output to one (Chrome's Prompt API responseConstraint).
export function programSchema() {
	const field = ([, kind, a, b]) => {
		if (kind === 'enum') return { type: 'string', enum: a };
		if (kind === 'int' || kind === 'room') return { type: 'integer', ...(kind === 'int' ? { minimum: a, maximum: b } : { minimum: 0, maximum: 40 }) };
		if (kind === 'num') return { type: 'number', minimum: a, maximum: b };
		if (kind === 'color') return { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
		if (kind === 'bool') return { type: 'boolean' };
		return { type: 'string', maxLength: a };
	};
	return {
		type: 'array',
		maxItems: 16,
		items: { anyOf: Object.entries(OPS).map(([op, fields]) => ({ type: 'object', properties: { op: { const: op }, ...Object.fromEntries(fields.map((f) => [f[0], field(f)])) }, required: ['op'], additionalProperties: false })) },
	};
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// A program in, the commands the game may run out. ctx: { rooms } (how many rooms the floor has), genesis (whether floor ops may run).
export function validate(program, ctx = {}) {
	const rooms = ctx.rooms ?? 40;
	const out = [];
	for (const c of Array.isArray(program) ? program : []) {
		if (!c || typeof c !== 'object') continue;
		const spec = OPS[c.op];
		if (!spec) continue;
		if (c.op === 'floor' && !ctx.genesis) continue;
		const cmd = { op: c.op };
		let ok = true;
		for (const [name, kind, a, b] of spec) {
			const v = c[name];
			if (v === undefined || v === null) continue;
			if (kind === 'enum') {
				if (a.includes(v)) cmd[name] = v;
			} else if (kind === 'int') {
				if (Number.isFinite(+v)) cmd[name] = clamp(Math.round(+v), a, b);
			} else if (kind === 'num') {
				if (Number.isFinite(+v)) cmd[name] = clamp(+v, a, b);
			} else if (kind === 'room') {
				if (Number.isInteger(+v) && +v >= 0 && +v < rooms) cmd[name] = +v;
			} else if (kind === 'color') {
				if (/^#[0-9a-f]{6}$/i.test(v)) cmd[name] = v.toLowerCase();
			} else if (kind === 'bool') cmd[name] = !!v;
			else if (typeof v === 'string') cmd[name] = v.replace(/[<>]/g, '').slice(0, a).trim();
		}
		// What each op can't do without.
		const need = { role: ['room', 'as'], guard: ['room', 'enemy'], spawn: ['enemy'], light: ['room'], sfx: ['cue'], music: ['track'], say: ['text'], quest: ['id', 'goal', 'title'], complete: ['id'], bless: ['what'], curse: ['what'], seal: ['room'], mood: ['as'], companions: ['n'] }[c.op] ?? [];
		for (const k of need) if (cmd[k] === undefined) ok = false;
		if (ok) out.push(cmd);
		if (out.length >= 16) break;
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
