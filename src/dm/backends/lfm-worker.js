// Liquid LFM2.5-350M on WebGPU, off the main thread. Weights and ONNX Runtime wasm are served from our own origin (Patch CSP: connect-src 'self').
import { env, AutoTokenizer, AutoModelForCausalLM, StoppingCriteria, StoppingCriteriaList } from '@huggingface/transformers';
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
	// compile shaders now, not on the first real request
	const warm = tok('warm', { add_special_tokens: false });
	await model.generate({ ...warm, max_new_tokens: 2, do_sample: false });
}

// Stops when the first top-level JSON array closes, or when aborted.
class StopAtClose extends StoppingCriteria {
	constructor(id, promptLen) {
		super();
		this.id = id;
		this.promptLen = promptLen;
		this.depth = 1; // the prompt ends with the opening '['
		this.inStr = false;
		this.esc = false;
		this.seen = 0;
	}
	_call(input_ids) {
		const row = input_ids[0];
		const out = [false];
		if (aborted.has(this.id)) return (out[0] = true), out;
		const total = Number(row.length ?? row.dims?.[0] ?? 0);
		if (total <= this.promptLen + this.seen) return out;
		const ids = Array.from(row, Number).slice(this.promptLen + this.seen);
		this.seen += ids.length;
		for (const ch of tok.decode(ids, { skip_special_tokens: true })) {
			if (this.inStr) {
				if (this.esc) this.esc = false;
				else if (ch === '\\') this.esc = true;
				else if (ch === '"') this.inStr = false;
			} else if (ch === '"') this.inStr = true;
			else if (ch === '[') this.depth++;
			else if (ch === ']' && --this.depth === 0) out[0] = true;
		}
		return out;
	}
}

async function gen({ id, system, prompt, maxTokens }) {
	const messages = [
		{ role: 'system', content: system },
		{ role: 'user', content: prompt },
	];
	const text = tok.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }) + '[';
	const inputs = tok(text, { add_special_tokens: false });
	const promptLen = inputs.input_ids.dims[1];
	const crit = new StoppingCriteriaList();
	crit.push(new StopAtClose(id, promptLen));
	const out = await model.generate({ ...inputs, max_new_tokens: maxTokens, do_sample: false, repetition_penalty: 1.05, stopping_criteria: crit });
	if (aborted.has(id)) return null;
	const all = Array.from(out.tolist()[0], Number).slice(promptLen);
	return '[' + tok.decode(all, { skip_special_tokens: true });
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
