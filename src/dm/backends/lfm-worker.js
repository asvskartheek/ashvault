// Liquid LFM2.5-350M on WebGPU, off the main thread. Weights and ONNX Runtime wasm are served from our own origin (Patch CSP: connect-src 'self').
import { env, AutoTokenizer, AutoModelForCausalLM, StoppingCriteria, StoppingCriteriaList, LogitsProcessor } from '@huggingface/transformers';
import { shotsFor } from '../prompt.js';
import { buildVocab, grammarFor, tokenStrings, applyMask } from '../grammar.js';
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

const MODEL = 'lfm2.5-350m';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href, mjs: new URL(mjsUrl, self.location.href).href };
env.backends.onnx.wasm.numThreads = 1;

let tok = null;
let model = null;
let dtype = null;
let vocab = null;
let loading = null;
const aborted = new Set();

const post = (m) => self.postMessage(m);

async function hasFile(url) {
	try {
		return (await fetch(url, { method: 'HEAD' })).ok;
	} catch {
		return false;
	}
}

async function load(base) {
	// transformers.js only treats non-URL paths as local, so give it a root-relative path (same origin, any sub-folder).
	env.localModelPath = new URL('models/', base).pathname;
	const adapter = await navigator.gpu?.requestAdapter();
	if (!adapter) throw new Error('no WebGPU adapter');
	dtype = adapter.features.has('shader-f16') ? 'q4f16' : 'q4';
	if (!(await hasFile(`${env.localModelPath}${MODEL}/onnx/model_${dtype}.onnx_data`))) throw new Error(`missing model_${dtype}`);
	const progress_callback = (p) => p.status === 'progress_total' && post({ type: 'progress', loaded: p.loaded, total: p.total });
	tok = await AutoTokenizer.from_pretrained(MODEL, { progress_callback });
	model = await AutoModelForCausalLM.from_pretrained(MODEL, { device: 'webgpu', dtype, progress_callback });
	vocab = buildVocab(tokenStrings(tok, 64400));
	// compile shaders now, not on the first real request
	const warm = tok('warm', { add_special_tokens: false });
	await model.generate({ ...warm, max_new_tokens: 2, do_sample: false });
}

// Grammar-constrained greedy decoding: only tokens that keep the output a program schema.validate() accepts stay finite.
// One shared runner follows the generated ids; the processor masks logits, the criteria stops when the program closes (or on abort).
class Walk {
	constructor(id, promptLen, g) {
		this.id = id;
		this.promptLen = promptLen;
		this.r = g.runner();
		this.seen = 0;
	}
	sync(row) {
		const total = Number(row.length ?? row.dims?.[0] ?? 0);
		while (this.promptLen + this.seen < total) this.r.advance(Number(row[this.promptLen + this.seen++]));
	}
}
class GrammarMask extends LogitsProcessor {
	constructor(w) {
		super();
		this.w = w;
	}
	_call(input_ids, logits) {
		this.w.sync(input_ids[0]);
		const parts = this.w.r.mask();
		if (parts.length) applyMask(logits.data, parts);
		return logits;
	}
}
class StopWhenDone extends StoppingCriteria {
	constructor(w) {
		super();
		this.w = w;
	}
	_call(input_ids) {
		this.w.sync(input_ids[0]);
		return [aborted.has(this.w.id) || this.w.r.done];
	}
}

async function gen({ id, system, prompt, maxTokens, kind, rooms, locked }) {
	const messages = [
		{ role: 'system', content: system },
		...shotsFor(kind).flatMap(([u, a]) => [
			{ role: 'user', content: u },
			{ role: 'assistant', content: a },
		]),
		{ role: 'user', content: prompt },
	];
	const text = tok.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }) + '[';
	const inputs = tok(text, { add_special_tokens: false });
	const promptLen = inputs.input_ids.dims[1];
	const w = new Walk(id, promptLen, grammarFor(vocab, { kind, rooms, locked }));
	const crit = new StoppingCriteriaList();
	crit.push(new StopWhenDone(w));
	const out = await model.generate({
		...inputs,
		max_new_tokens: maxTokens,
		do_sample: false,
		logits_processor: [new GrammarMask(w)],
		stopping_criteria: crit,
	});
	if (aborted.has(id)) return null;
	const all = Array.from(out.tolist()[0], Number).slice(promptLen);
	return '[' + tok.decode(all, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
}

self.onmessage = async ({ data: m }) => {
	try {
		if (m.type === 'init') {
			loading ??= load(m.base);
			await loading;
			post({ type: 'ready', dtype });
		} else if (m.type === 'abort') {
			aborted.add(m.id);
		} else if (m.type === 'gen') {
			await (loading ??= load(m.base));
			const text = await gen(m);
			aborted.delete(m.id);
			post(text === null ? { type: 'aborted', id: m.id } : { type: 'done', id: m.id, text });
		}
	} catch (e) {
		loading = m.type === 'init' ? null : loading;
		post({ type: 'error', id: m.id, error: String(e?.message ?? e) + ' @ ' + String(e?.stack ?? '').split('\n').slice(1, 4).join(' | ') });
	}
};
