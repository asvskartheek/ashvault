// Backend: Liquid LFM2.5-350M (q4f16 ONNX) in a module Worker on WebGPU. The model loads only when this backend is picked.
// Room count the program may address: the state's rooms, else what the JSON schema allows.
const roomsOf = (req) => req.state?.rooms?.length || (req.schema?.items?.anyOf?.map((a) => a.properties?.room?.maximum).find((m) => m !== undefined) ?? 21) + 1;

export function createLfmBackend({ base: root } = {}) {
	const base = () => new URL(root ?? './', document.baseURI).href; // folder that holds models/
	let worker = null;
	let ready = null;
	let seq = 0;
	const pending = new Map();
	const progress = new Set();

	function start() {
		worker = new Worker(new URL('./lfm-worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = ({ data: m }) => {
			if (m.type === 'progress') progress.forEach((f) => f(m.loaded, m.total));
			else if (m.type === 'ready') pending.get('init')?.res(m.dtype), pending.delete('init');
			else if (m.type === 'done' || m.type === 'aborted') pending.get(m.id)?.res(m.type === 'done' ? m.text : null), pending.delete(m.id);
			else if (m.type === 'error') pending.get(m.id ?? 'init')?.rej(new Error(m.error)), pending.delete(m.id ?? 'init');
		};
		worker.onerror = (e) => {
			for (const p of pending.values()) p.rej(new Error(e.message || 'lfm worker failed'));
			pending.clear();
			worker = ready = null;
		};
	}
	const call = (key, msg) => new Promise((res, rej) => (pending.set(key, { res, rej }), worker.postMessage(msg)));

	return {
		name: 'lfm',
		onProgress: (f) => (progress.add(f), () => progress.delete(f)),
		ready() {
			if (!ready) {
				start();
				ready = call('init', { type: 'init', base: base() }).catch((e) => {
					worker?.terminate();
					worker = ready = null;
					throw e;
				});
			}
			return ready;
		},
		async warm() {
			await this.ready();
		},
		async generate(req, { signal } = {}) {
			await this.ready();
			if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
			const id = ++seq;
			const onAbort = () => worker?.postMessage({ type: 'abort', id });
			signal?.addEventListener('abort', onAbort, { once: true });
			try {
				const text = await call(id, { type: 'gen', id, base: base(), system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? 128, kind: req.kind ?? 'react', rooms: roomsOf(req), locked: [...(req.state?.locked ?? [])] });
				if (text === null) throw new DOMException('aborted', 'AbortError');
				return text;
			} finally {
				signal?.removeEventListener('abort', onAbort);
			}
		},
		close() {
			worker?.terminate();
			worker = ready = null;
		},
	};
}
