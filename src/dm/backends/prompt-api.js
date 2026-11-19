// Backend: Chrome's built-in Prompt API (Gemini Nano, `LanguageModel`). Never downloads the model during play: call download() from a menu.
const LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

export async function promptApiAvailability() {
	if (typeof self === 'undefined' || !('LanguageModel' in self)) return 'unavailable';
	try {
		return await self.LanguageModel.availability(LANG);
	} catch {
		return 'unavailable';
	}
}

export function createPromptApiBackend() {
	const bases = new Map(); // kind -> Promise<session> holding only the static system prompt
	const base = (kind, system) => {
		if (!bases.has(kind)) {
			const p = self.LanguageModel.create({ ...LANG, initialPrompts: [{ role: 'system', content: system }], temperature: 0.4, topK: 20 });
			p.catch(() => bases.delete(kind));
			bases.set(kind, p);
		}
		return bases.get(kind);
	};

	return {
		name: 'prompt-api',
		availability: promptApiAvailability,
		async ready() {
			return (await promptApiAvailability()) === 'available';
		},
		// For a menu button when availability() is 'downloadable'. onProgress gets 0..1.
		async download(onProgress) {
			const s = await self.LanguageModel.create({
				...LANG,
				monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)),
			});
			s.destroy();
		},
		async warm(kind, system) {
			if ((await promptApiAvailability()) !== 'available') return;
			await base(kind, system);
		},
		async generate(req, { signal } = {}) {
			if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
			const session = await (await base(req.kind, req.system)).clone({ signal });
			try {
				return await session.prompt(req.prompt, { responseConstraint: req.schema, omitResponseConstraintInput: true, signal });
			} finally {
				session.destroy();
			}
		},
		close() {
			for (const p of bases.values()) p.then((s) => s.destroy()).catch(() => {});
			bases.clear();
		},
	};
}
