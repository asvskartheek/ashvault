// Fixed-shape action ruling grammar: {"stat":..,"dc":..,"effect":..,"target":..,"power":..,"pass":"..","fail":".."}.
// Same technique as src/dm/grammar.js (char automaton lifted to tokens, mask = allowed ids); reuses its vocab/mask helpers.
import { buildVocab, tokenStrings, applyMask } from '../../src/dm/grammar.js';
export { buildVocab, tokenStrings, applyMask };

export const STATS = ['str', 'dex', 'int', 'wis', 'con', 'cha'];
export const DCS = ['8', '10', '12', '14', '16', '18'];
export const EFFECTS = ['push', 'stun', 'burn', 'freeze', 'fear', 'lure', 'blind', 'collapse', 'heal', 'ward', 'hide', 'smite', 'none'];
export const TARGETS = ['aimed', 'nearest', 'group', 'self', 'ally'];
export const TEXT_CAP = 90;
const TEXT_ROOM = 24;
const TEXT_OK = /^[^"\\<>]+$/;
const FIELD = {
	stat: [STATS.map((s) => s + '"'), '"'],
	dc: [DCS, ''],
	effect: [EFFECTS.map((s) => s + '"'), '"'],
	target: [TARGETS.map((s) => s + '"'), '"'],
	power: [['1', '2', '3'], ''],
	pass: ['TEXT', '"'],
	fail: ['TEXT', '"'],
};
export const ORDERS = {
	std: ['stat', 'dc', 'effect', 'target', 'power', 'pass', 'fail'],
	eff: ['effect', 'target', 'stat', 'dc', 'power', 'pass', 'fail'],
};
const segsFor = (order) => [...order.flatMap((k, i) => [[(i ? ',' : '{') + `"${k}":` + FIELD[k][1]], FIELD[k][0]]), ['}']];

export function ruleGrammar(vocab, orderName = 'std') {
	vocab.actG ??= {};
	if (vocab.actG[orderName]) return vocab.actG[orderName];
	const SEGS = segsFor(ORDERS[orderName]);
	const { strs, byFirst } = vocab;
	const intern = new Map();
	const mk = (seg, p, len) => {
		const k = `${seg}|${p}|${len}`;
		let s = intern.get(k);
		if (!s) intern.set(k, (s = { seg, p, len, tr: new Map(), mask: null }));
		return s;
	};
	const START = mk(0, '', 0);
	const done = (s) => s.seg >= SEGS.length;
	function step(s, ch) {
		if (s.tr.has(ch)) return s.tr.get(ch);
		const r = step_(s, ch);
		s.tr.set(ch, r);
		return r;
	}
	function step_(s, ch) {
		if (done(s)) return null;
		const seg = SEGS[s.seg];
		if (seg === 'TEXT') {
			if (ch === '"') return s.len > 0 ? mk(s.seg + 1, '', 0) : null;
			if (s.len >= TEXT_CAP || !TEXT_OK.test(ch) || (s.len === 0 && ch === ' ')) return null;
			return mk(s.seg, '', s.len + 1);
		}
		const p = s.p + ch;
		if (seg.includes(p) && !seg.some((a) => a.length > p.length && a.startsWith(p))) return mk(s.seg + 1, '', 0);
		return seg.some((a) => a.startsWith(p)) ? mk(s.seg, p, 0) : null;
	}
	const accept = (s, str) => {
		for (let k = 0; k < str.length && s; k++) s = step(s, str[k]);
		return s;
	};
	const textCache = new Map();
	function maskOf(s) {
		if (s.mask) return s.mask;
		let parts;
		if (done(s)) parts = [];
		else if (SEGS[s.seg] === 'TEXT') {
			const rem = Math.min(TEXT_CAP - s.len, TEXT_ROOM);
			const ck = `${rem}|${s.len === 0}`;
			let plain = textCache.get(ck);
			if (!plain) textCache.set(ck, (plain = Int32Array.from(vocab.plain.text.filter((id) => strs[id].length <= rem && !(s.len === 0 && strs[id][0] === ' ')))));
			parts = [plain, Int32Array.from(vocab.quoted.filter((id) => accept(s, strs[id])))];
		} else {
			const chars = new Set(SEGS[s.seg].filter((a) => a.length > s.p.length && a.startsWith(s.p)).map((a) => a[s.p.length]));
			const ids = [];
			for (const c of chars) for (const id of byFirst.get(c) ?? []) if (accept(s, strs[id])) ids.push(id);
			parts = [Int32Array.from(ids)];
		}
		return (s.mask = parts);
	}
	return (vocab.actG[orderName] = {
		runner() {
			let s = START;
			return {
				get done() { return !s || done(s); },
				get broken() { return !s; },
				mask: () => maskOf(s),
				advance(id) { s = accept(s, strs[id] ?? '\0'); },
			};
		},
	});
}
