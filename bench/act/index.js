// Action-ruling bench. ?model=350m (default) | 1.2b ; ?n=5 limits cases. Muted (no audio at all). Results on window.RESULT / window.PROGRESS.
import { env, AutoTokenizer, AutoModelForCausalLM, StoppingCriteria, StoppingCriteriaList, LogitsProcessor } from '@huggingface/transformers';
import { buildVocab, tokenStrings, applyMask, ruleGrammar, ORDERS } from './grammar.js';
import { CASES } from './cases.js';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

const q = new URLSearchParams(location.search);
const MODEL = q.get('model') === '1.2b' ? 'lfm2.5-1.2b' : 'lfm2.5-350m';
const N = +q.get('n') || CASES.length;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = { wasm: new URL(wasmUrl, location.href).href, mjs: new URL(mjsUrl, location.href).href };
env.backends.onnx.wasm.numThreads = 1;

const out = document.getElementById('out');
const log = (s) => ((out.textContent += '\n' + s), (window.PROGRESS = s));
window.RESULT = null;

const V = +q.get('p') || 2;
const ORDER = q.get('o') || 'std';
const GUIDE = 'Stats: str=force, smashing, shoving, toppling. dex=aim, throwing, kicking, stealth, agility. int=runes, lore, magic. wis=faith, healing, calm, ward. con=endurance. cha=voice, taunts, threats, rallying.\nEffects: push=knock back. stun=daze. burn=fire. freeze=ice. fear=scare. lure=draw attention. blind=cover eyes or darkness. collapse=bring something down. heal=mend allies. ward=protect. hide=vanish. smite=holy or heavy blow. none=nothing.';
const SYSTEM = [
	'You are the Dungeon Master of a dark crypt game. A player describes an action. Rule on it with ONE JSON object, no prose.',
	'{"stat":str|dex|int|wis|con|cha,"dc":8|10|12|14|16|18,"effect":push|stun|burn|freeze|fear|lure|blind|collapse|heal|ward|hide|smite|none,"target":aimed|nearest|group|self|ally,"power":1-3,"pass":text<=90,"fail":text<=90}',
	'stat = the ability the action tests. dc = difficulty (8 easy, 18 near impossible). effect = what happens to the target on success. target = who it hits. pass/fail = one short line narrating each outcome.',
].concat(V >= 2 ? [GUIDE] : []).join('\n');
const ctx = (actor, aimed, enemies, props, text) => `Actor: ${actor}\nAimed at: ${aimed}\nEnemies: ${enemies}\nProps: ${props}\nAction: ${text}`;
const SHOTS = [
	[ctx('Kael warrior STR 16 DEX 10 INT 8 WIS 9 CON 14 CHA 10', 'hollow 4m', 'hollow 4m, hollow 5m', 'bone pile 1m', 'I hurl the bone pile at the hollows', ''), '{"stat":"str","dc":10,"effect":"push","target":"group","power":1,"pass":"Bones clatter and the hollows stagger back.","fail":"The bones scatter harmlessly."}'],
	[ctx('Sela cleric STR 11 DEX 9 INT 10 WIS 16 CON 13 CHA 12', 'none', 'none', 'ally Dren 2m (wounded)', 'I lay my hands on Dren and pray', ''), '{"stat":"wis","dc":10,"effect":"heal","target":"ally","power":2,"pass":"Warm light closes Dren\'s wounds.","fail":"The prayer fades unanswered."}'],
	[ctx('Mira rogue STR 9 DEX 16 INT 11 WIS 10 CON 10 CHA 13', 'knight 5m', 'knight 5m, wisp 12m', 'candle stand 2m, banner 6m', 'I yank the banner down over the knight', ''), '{"stat":"dex","dc":12,"effect":"blind","target":"aimed","power":2,"pass":"The cloth drapes the knight, who flails blindly.","fail":"The banner tears free and falls short."}'],
	...(V >= 2 ? [
	[ctx('Orin mage STR 7 DEX 11 INT 16 WIS 13 CON 9 CHA 10', 'wisp 6m', 'wisp 6m, hollow 9m', 'ember basin 3m', 'I hurl a fireball of embers at the wisp', ''), '{"stat":"dex","dc":12,"effect":"burn","target":"aimed","power":2,"pass":"Embers engulf the wisp.","fail":"The embers fizzle out."}'],
	[ctx('Kael warrior STR 16 DEX 10 INT 8 WIS 9 CON 14 CHA 10', 'none', 'hollow 6m, hollow 7m, hollow 8m', 'bones 2m', 'I bellow that I fear nothing and dare them to come', ''), '{"stat":"cha","dc":12,"effect":"lure","target":"group","power":1,"pass":"The hollows turn toward your roar.","fail":"They ignore your shouting."}'],
	[ctx('Mira rogue STR 9 DEX 16 INT 11 WIS 10 CON 10 CHA 13', 'none', 'ogre 9m', 'rubble 2m, pillar 4m', 'I slip into the dark behind the rubble', ''), '{"stat":"dex","dc":10,"effect":"hide","target":"self","power":2,"pass":"The ogre loses sight of you.","fail":"Your boot scrapes the stone."}'],
	[ctx('Sela cleric STR 11 DEX 9 INT 10 WIS 16 CON 13 CHA 12', 'knight 3m', 'knight 3m, knight 5m', 'pillar 3m', 'I cut the old support strut so the beam falls on the knights', ''), '{"stat":"str","dc":14,"effect":"collapse","target":"group","power":3,"pass":"The beam crashes down on the knights.","fail":"The strut holds."}'],
	] : []),
];
const reorder = (a) => { const o = JSON.parse(a); return JSON.stringify(Object.fromEntries(ORDERS[ORDER].map((k) => [k, o[k]]))); };
const userMsg = (c) => ctx(...[c.ctx.match(/Actor: (.*)/)[1], c.ctx.match(/Aimed at: (.*)/)[1], c.ctx.match(/Enemies: (.*)/)[1], c.ctx.match(/Props: (.*)/)[1], c.text]);

class Walk {
	constructor(promptLen, g) { this.promptLen = promptLen; this.r = g.runner(); this.seen = 0; }
	sync(row) {
		const total = Number(row.length ?? row.dims?.[0] ?? 0);
		while (this.promptLen + this.seen < total) this.r.advance(Number(row[this.promptLen + this.seen++]));
	}
}
class Mask extends LogitsProcessor {
	constructor(w) { super(); this.w = w; }
	_call(ids, logits) { this.w.sync(ids[0]); const p = this.w.r.mask(); if (p.length) applyMask(logits.data, p); return logits; }
}
class Stop extends StoppingCriteria {
	constructor(w) { super(); this.w = w; }
	_call(ids) { this.w.sync(ids[0]); return [this.w.r.done]; }
}

async function main() {
	const info = { model: MODEL, prompt: V, order: ORDER, languageModel: typeof LanguageModel !== 'undefined' ? await LanguageModel.availability().catch((e) => 'err ' + e) : 'undefined' };
	log(`LanguageModel: ${info.languageModel}`);
	const adapter = await navigator.gpu?.requestAdapter();
	if (!adapter) throw new Error('no WebGPU adapter');
	const dtype = adapter.features.has('shader-f16') ? 'q4f16' : 'q4';
	const t0 = performance.now();
	const tok = await AutoTokenizer.from_pretrained(MODEL);
	const model = await AutoModelForCausalLM.from_pretrained(MODEL, { device: 'webgpu', dtype, progress_callback: (p) => p.status === 'progress_total' && (window.PROGRESS = `load ${(p.loaded / 1e6) | 0}/${(p.total / 1e6) | 0} MB`) });
	const cfg = await (await fetch(`/models/${MODEL}/config.json`)).json();
	const vocab = buildVocab(tokenStrings(tok, cfg.vocab_size ?? 64400));
	const g = ruleGrammar(vocab, ORDER);
	const warm = tok('warm', { add_special_tokens: false });
	await model.generate({ ...warm, max_new_tokens: 2, do_sample: false });
	info.loadMs = Math.round(performance.now() - t0);
	info.dtype = dtype;
	log(`loaded ${MODEL} ${dtype} in ${info.loadMs} ms`);

	const base = [{ role: 'system', content: SYSTEM }, ...SHOTS.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: reorder(a) }])];
	const rows = [];
	for (const [i, c] of CASES.slice(0, N).entries()) {
		const text = tok.apply_chat_template([...base, { role: 'user', content: userMsg(c) }], { tokenize: false, add_generation_prompt: true });
		const inputs = tok(text, { add_special_tokens: false });
		const promptLen = inputs.input_ids.dims[1];
		const w = new Walk(promptLen, g);
		const sc = new StoppingCriteriaList();
		sc.push(new Stop(w));
		const t = performance.now();
		const res = await model.generate({ ...inputs, max_new_tokens: 140, do_sample: false, logits_processor: [new Mask(w)], stopping_criteria: sc });
		const ms = Math.round(performance.now() - t);
		const ids = Array.from(res.tolist()[0], Number).slice(promptLen);
		const raw = tok.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
		let j = null;
		try { j = JSON.parse(raw); } catch {}
		const row = { i: i + 1, text: c.text, expStat: c.stat, expEffect: c.effect, raw, j, ms, tokens: ids.length, promptLen, statOk: j?.stat === c.stat, effOk: !!j && c.effect.includes(j.effect), valid: !!j };
		rows.push(row);
		log(`${i + 1}/${CASES.length} ${ms}ms ${row.statOk ? 'S' : 's'}${row.effOk ? 'E' : 'e'} ${raw.slice(0, 100)}`);
	}
	const pct = (f) => Math.round((100 * rows.filter(f).length) / rows.length);
	const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
	const sum = { ...info, n: rows.length, valid: pct((r) => r.valid), statPct: pct((r) => r.statOk), effPct: pct((r) => r.effOk), bothPct: pct((r) => r.statOk && r.effOk), msMean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), msMedian: ms[ms.length >> 1], msMax: ms[ms.length - 1], promptTokens: rows[0]?.promptLen };
	window.RESULT = { sum, rows };
	out.textContent = JSON.stringify(sum, null, 1);
	document.getElementById('tbl').innerHTML = '<table><tr><th>#<th>action<th>exp<th>got<th>ms<th>pass line</tr>' + rows.map((r) => `<tr><td>${r.i}<td>${r.text}<td>${r.expStat}/${r.expEffect.join('|')}<td class="${r.statOk && r.effOk ? 'ok' : 'no'}">${r.j ? `${r.j.stat}/${r.j.effect}/${r.j.target}/dc${r.j.dc}/p${r.j.power}` : 'INVALID'}<td>${r.ms}<td>${r.j?.pass ?? ''}`).join('') + '</table>';
}
main().catch((e) => { window.RESULT = { error: String(e?.stack ?? e) }; log('ERROR ' + e); });
