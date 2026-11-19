// Grammar test: node tools/grammartest.mjs. Random walks over the real LFM tokenizer, constrained by src/dm/grammar.js;
// every finished output must parse and pass schema.validate() with no command dropped.
import assert from 'node:assert/strict';
import { env, AutoTokenizer } from '@huggingface/transformers';
import { buildVocab, grammarFor, tokenStrings } from '../src/dm/grammar.js';
import { validate, KINDS } from '../src/dm/schema.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;
const tok = await AutoTokenizer.from_pretrained('lfm2.5-350m');
const t0 = performance.now();
const vocab = buildVocab(tokenStrings(tok, 64400));
console.log('vocab', Math.round(performance.now() - t0), 'ms');

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const MIN = { plan: 2, populate: 5, react: 2 };
const cfgs = [
	{ kind: 'plan', rooms: 22, locked: [] },
	{ kind: 'populate', rooms: 14, locked: [0, 13] },
	{ kind: 'populate', rooms: 22, locked: [0, 21] },
	{ kind: 'react', rooms: 12, locked: [0, 11] },
	{ kind: 'react', rooms: 22, locked: [] },
];
let total = 0;
for (const cfg of cfgs) {
	const g = grammarFor(vocab, cfg);
	let cmds = 0;
	for (let run = 0; run < 150; run++) {
		const r = g.runner();
		const ids = [];
		while (!r.done && ids.length < 1500) {
			const parts = r.mask();
			const all = parts.flatMap((p) => [...p]);
			assert(all.length > 0, 'dead end after ' + (ids.length ? tok.decode(ids) : ''));
			// bias toward longer outputs half the time, so late commands are exercised
			const id = all[Math.floor(rnd() * all.length)];
			ids.push(id);
			r.advance(id);
			assert(!r.broken);
		}
		assert(r.done, 'did not finish: ' + tok.decode(ids).slice(0, 300));
		const text = '[' + tok.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
		const prog = JSON.parse(text);
		const v = validate(prog, { kind: cfg.kind, rooms: cfg.rooms, locked: new Set(cfg.locked) });
		assert.equal(v.length, prog.length, `dropped commands in ${text}`);
		assert(v.length >= MIN[cfg.kind] && v.length <= KINDS[cfg.kind].max, text);
		if (cfg.kind === 'populate') assert.equal(v[0].op, 'quest');
		if (cfg.kind === 'plan') assert.equal(v[0].op, 'floor');
		for (const c of prog) assert(Object.keys(c).length >= 1 && typeof c.op === 'string');
		cmds += v.length;
		total++;
	}
	console.log('ok  ' + cfg.kind + ' rooms=' + cfg.rooms + ' (avg ' + (cmds / 150).toFixed(1) + ' cmds)');
}
console.log('ok  ' + total + ' walks, all validate');
