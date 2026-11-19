// Grammar-constrained decoding for the DM: a character-level automaton over the JSON of one program kind, lifted to the tokenizer's tokens.
// Every output it allows is `[cmd,cmd,...]` where each cmd is `{"op":"<op>","field":value,...}` and passes schema.validate() untouched.
// No dependencies (works in a worker and in node). Use:
//   const vocab = buildVocab(strings)                    // strings[id] = the text of token id ('' for special tokens), once per tokenizer
//   const g = grammarFor(vocab, { kind, rooms, locked })  // cached
//   const r = g.runner(); r.mask() -> parts (Int32Array[]) of allowed token ids; r.advance(id); r.done
import { OPS, NEED, GOAL_NEED, KINDS } from './schema.js';

// Per kind: the op that must open the program, the fewest commands, which ops may repeat.
const RULES = {
	plan: { first: 'floor', min: 3, repeat: [], skip: [] },
	populate: { first: 'quest', min: 5, repeat: ['role', 'guard', 'light', 'quest'], skip: ['seal'] },
	react: { first: null, min: 2, repeat: [], skip: ['quest'] },
};
// Optional fields the grammar makes mandatory so a command is always whole (the model still picks every value).
const EXTRA = { floor: ['name', 'rooms'], say: ['voice'], light: ['power'], spawn: ['near', 'level'], guard: ['level'], quest: ['reward'], bless: ['amount', 'who'], curse: ['secs', 'who'] };
// Ops whose room may not repeat within one program.
const ROOM_ONCE = new Set(['role', 'guard', 'light']);
const TEXT_CAP = { say: 90, title: 48, name: 32, id: 10 };
const TEXT_ROOM = 24; // longest token (chars) a text state tells apart; longer ones are never allowed in free text
const PLAIN = /^[ -~]+$/;
const TEXT_OK = /^[^"\\<>]+$/;
const ID_OK = /^[a-z0-9_]+$/;

export function buildVocab(strings) {
	const strs = strings.map((s) => (s && PLAIN.test(s) ? s : null));
	const byFirst = new Map();
	const byStr = new Map();
	const quoted = [];
	const plain = { text: [], id: [] };
	strs.forEach((s, id) => {
		if (s === null) return;
		if (!byFirst.has(s[0])) byFirst.set(s[0], []);
		byFirst.get(s[0]).push(id);
		if (!byStr.has(s)) byStr.set(s, id);
		if (s.includes('"')) quoted.push(id);
		else if (s.length <= TEXT_ROOM) {
			if (TEXT_OK.test(s)) plain.text.push(id);
			if (ID_OK.test(s)) plain.id.push(id);
		}
	});
	return { strs, byFirst, byStr, quoted, plain, grammars: new Map() };
}

export function grammarFor(vocab, { kind = 'react', rooms = 22, locked = [] } = {}) {
	const key = `${kind}|${rooms}|${[...locked].sort((a, b) => a - b)}`;
	if (!vocab.grammars.has(key)) vocab.grammars.set(key, makeGrammar(vocab, kind, rooms, new Set(locked)));
	return vocab.grammars.get(key);
}

const trimNum = (x) => String(Math.round(x * 100) / 100);
const range = (a, b, step = 1) => {
	const out = [];
	for (let x = a; x <= b + 1e-9; x += step) out.push(trimNum(x));
	return out;
};

function makeGrammar(vocab, kind, rooms, locked) {
	const K = KINDS[kind];
	const R = RULES[kind];
	const { strs, byFirst, byStr } = vocab;
	const intern = new Map();
	const textCache = new Map();

	const mk = (o) => {
		const key = `${o.ph}|${o.at ?? ''}|${o.n}|${o.u}|${o.op ?? ''}|${o.i}|${o.rm ?? ''}|${o.goal ?? ''}|${o.p ?? ''}|${o.len ?? 0}`;
		let s = intern.get(key);
		if (!s) {
			s = { ...o, key, tr: new Map(), mask: null, forced: undefined };
			intern.set(key, s);
		}
		return s;
	};
	const START = mk({ ph: 'alt', at: 'start', n: 0, u: 0, p: '', i: -1, rm: '' });

	const fieldOf = (op, j) => {
		const [name, k, a, b] = OPS[op][j];
		return { name, k, a, b };
	};
	const reqOf = (op, goal) => new Set([...NEED[op], ...(EXTRA[op] ?? []), ...(op === 'quest' && goal ? GOAL_NEED[goal] : [])]);
	const isStr = (k) => k === 'enum' || k === 'text';
	const altFor = (op, j) => {
		const f = fieldOf(op, j);
		return `,"${f.name}":` + (isStr(f.k) ? '"' : '');
	};
	const opCands = (s) => {
		let ops = K.ops.filter((o) => !R.skip.includes(o));
		if (s.n === 0 && R.first) ops = [R.first];
		else ops = ops.filter((o) => o !== 'floor' || s.n === 0).filter((o) => R.repeat.includes(o) || !(s.u >> K.ops.indexOf(o) & 1));
		return ops;
	};
	const valuesOf = (op, f, s) => {
		if (f.k === 'enum') return f.a.map((v) => v + '"');
		if (f.k === 'bool') return ['true', 'false'];
		if (f.k === 'int') return range(f.a, f.b);
		if (f.k === 'num') return range(f.a, f.b, f.b > 1 ? 0.5 : 0.1);
		const all = range(0, rooms - 1);
		const used = ROOM_ONCE.has(op) ? new Set((s.rm.match(new RegExp(`${op}:(\\d+);`, 'g')) ?? []).map((m) => m.slice(op.length + 1, -1))) : new Set();
		const ok = all.filter((v) => !used.has(v) && !((op === 'role' || op === 'guard') && locked.has(+v)));
		return ok.length ? ok : all;
	};
	const capOf = (f) => Math.min(f.a, TEXT_CAP[f.name] ?? 60);

	// The strings the 'alt' phase can be typing: [string, next-state factory]
	const altsOf = (s) => {
		if (s.at === 'start') return [['{"op":"', () => mk({ ph: 'op', n: 0, u: 0, p: '', i: -1, rm: '' })]];
		if (s.at === 'after') {
			const out = [];
			if (s.n < K.max) out.push([',{"op":"', () => mk({ ph: 'op', n: s.n, u: s.u, p: '', i: -1, rm: s.rm })]);
			if (s.n >= R.min) out.push([']', () => mk({ ph: 'done', n: s.n, u: s.u, i: -1, rm: s.rm })]);
			return out;
		}
		const fields = OPS[s.op];
		const req = reqOf(s.op, s.goal);
		const out = [];
		let closed = true;
		for (let j = s.i + 1; j < fields.length; j++) {
			const f = fieldOf(s.op, j);
			out.push([altFor(s.op, j), () => (f.k === 'text' ? mk({ ...s, ph: 'text', i: j, p: '', len: 0 }) : mk({ ...s, ph: 'val', i: j, p: '' }))]);
			if (req.has(f.name)) {
				closed = false;
				break;
			}
		}
		if (closed) out.push(['}', () => mk({ ph: 'alt', at: 'after', n: s.n + 1, u: s.u, i: -1, p: '', rm: s.rm })]);
		return out;
	};

	const after = (s, j, v) => {
		const f = fieldOf(s.op, j);
		const rm = f.k === 'room' && ROOM_ONCE.has(s.op) ? s.rm + `${s.op}:${v};` : s.rm;
		return mk({ ph: 'alt', at: 'next', n: s.n, u: s.u, op: s.op, i: j, goal: s.goal, p: '', rm });
	};

	const textRule = (s) => {
		const f = fieldOf(s.op, s.i);
		return { cs: f.name === 'id' ? 'id' : 'text', cap: capOf(f) };
	};

	function step(s, ch) {
		if (s.tr.has(ch)) return s.tr.get(ch);
		const r = step_(s, ch);
		s.tr.set(ch, r);
		return r;
	}
	function step_(s, ch) {
		switch (s.ph) {
			case 'alt': {
				const p = s.p + ch;
				const alts = altsOf(s);
				const hit = alts.find(([a]) => a === p);
				if (hit) return hit[1]();
				return alts.some(([a]) => a.startsWith(p)) ? mk({ ...s, p }) : null;
			}
			case 'op': {
				const p = s.p + ch;
				const c = opCands(s).map((o) => o + '"');
				if (c.includes(p)) {
					const op = p.slice(0, -1);
					const bit = R.repeat.includes(op) ? 0 : 1 << K.ops.indexOf(op);
					return mk({ ph: 'alt', at: 'next', n: s.n, u: s.u | bit, op, i: -1, p: '', rm: s.rm });
				}
				return c.some((x) => x.startsWith(p)) ? mk({ ...s, p }) : null;
			}
			case 'val': {
				const f = fieldOf(s.op, s.i);
				const p = s.p + ch;
				const vals = valuesOf(s.op, f, s);
				if (f.k === 'enum' || f.k === 'bool') {
					if (vals.includes(p)) {
						const nx = after(s, s.i, p);
						return f.name === 'goal' ? mk({ ...nx, goal: p.slice(0, -1) }) : nx;
					}
					return vals.some((x) => x.startsWith(p)) ? mk({ ...s, p }) : null;
				}
				// numbers: the value ends at the delimiter that follows it
				if ((ch === ',' || ch === '}') && vals.includes(s.p)) return step(after(s, s.i, s.p), ch);
				return vals.some((x) => x.startsWith(p)) ? mk({ ...s, p }) : null;
			}
			case 'text': {
				const { cs, cap } = textRule(s);
				if (ch === '"') return s.len > 0 ? after(s, s.i) : null;
				if (s.len >= cap || (cs === 'id' ? !ID_OK.test(ch) : !TEXT_OK.test(ch)) || (s.len === 0 && ch === ' ')) return null;
				return mk({ ...s, len: s.len + 1 });
			}
			default:
				return null;
		}
	}

	const accept = (s, str) => {
		for (let k = 0; k < str.length && s; k++) s = step(s, str[k]);
		return s;
	};

	// Chars the state allows next (non-text phases).
	function nextChars(s) {
		const out = new Set();
		const add = (str) => str.length > s.p.length && str.startsWith(s.p) && out.add(str[s.p.length]);
		if (s.ph === 'alt') altsOf(s).forEach(([a]) => add(a));
		else if (s.ph === 'op') opCands(s).forEach((o) => add(o + '"'));
		else if (s.ph === 'val') {
			const f = fieldOf(s.op, s.i);
			const vals = valuesOf(s.op, f, s);
			vals.forEach(add);
			if (f.k !== 'enum' && f.k !== 'bool' && vals.includes(s.p)) {
				for (const c of ',}') if (step(after(s, s.i, s.p), c)) out.add(c);
			}
		}
		return out;
	}

	// If exactly one string can follow, that string (so it can be fed as the longest-matching token).
	function forcedOf(s) {
		if (s.forced !== undefined) return s.forced;
		let t = s;
		let str = '';
		while (t && t.ph !== 'done' && t.ph !== 'text' && str.length < 48) {
			const cs = nextChars(t);
			if (cs.size !== 1) break;
			const [c] = cs;
			str += c;
			t = step(t, c);
		}
		return (s.forced = str);
	}

	function textParts(s) {
		const { cs, cap } = textRule(s);
		const rem = cap - s.len;
		const ck = `${cs}|${s.len === 0}|${Math.min(rem, TEXT_ROOM)}`;
		let plain = textCache.get(ck);
		if (!plain) {
			const lim = Math.min(rem, TEXT_ROOM);
			const first = s.len === 0;
			plain = Int32Array.from(vocab.plain[cs].filter((id) => strs[id].length <= lim && !(first && strs[id][0] === ' ')));
			textCache.set(ck, plain);
		}
		const q = vocab.quoted.filter((id) => accept(s, strs[id]));
		return [plain, Int32Array.from(q)];
	}

	function maskOf(s) {
		if (s.mask) return s.mask;
		let parts;
		if (s.ph === 'done') parts = [];
		else if (s.ph === 'text') parts = textParts(s);
		else {
			const f = forcedOf(s);
			if (f.length) {
				let id;
				for (let l = f.length; l > 0 && id === undefined; l--) id = byStr.get(f.slice(0, l));
				parts = id === undefined ? null : [Int32Array.of(id)];
			}
			if (!parts) {
				const ids = [];
				for (const c of nextChars(s)) for (const id of byFirst.get(c) ?? []) if (accept(s, strs[id])) ids.push(id);
				parts = [Int32Array.from(ids)];
			}
		}
		return (s.mask = parts);
	}

	return {
		kind,
		runner() {
			let s = START;
			return {
				get done() {
					return !s || s.ph === 'done';
				},
				get broken() {
					return !s;
				},
				mask: () => maskOf(s),
				advance(id) {
					s = accept(s, strs[id] ?? '\0');
				},
			};
		},
	};
}

// Token table from a transformers.js tokenizer (call once). Special tokens decode to ''.
export function tokenStrings(tok, size) {
	const opt = { skip_special_tokens: true, clean_up_tokenization_spaces: false };
	return Array.from({ length: size }, (_, id) => tok.decode([id], opt));
}

// Keep only the allowed ids of a logits vector (Float32Array), everything else -Infinity.
export function applyMask(data, parts) {
	let total = 0;
	for (const p of parts) total += p.length;
	const keep = new Float32Array(total);
	let k = 0;
	for (const p of parts) for (let i = 0; i < p.length; i++) keep[k++] = data[p[i]];
	data.fill(-Infinity);
	k = 0;
	for (const p of parts) for (let i = 0; i < p.length; i++) data[p[i]] = keep[k++];
}
