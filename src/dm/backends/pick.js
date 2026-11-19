// Chooses the DM's brain: Chrome's built-in model, then Liquid LFM in WebGPU, then the scripted DM.
// ?dm=scripted|prompt|lfm forces one; ?patch-test=1 is always scripted.
import { createPromptApiBackend, promptApiAvailability } from './prompt-api.js';
import { createLfmBackend } from './lfm.js';
import { createScriptedBackend } from './scripted.js';

const MODEL_URL = './models/lfm2.5-350m/onnx/model_q4f16.onnx_data';

async function lfmPresent() {
	if (!navigator.gpu) return false;
	try {
		const r = await fetch(MODEL_URL, { method: 'HEAD' });
		// A dev server may answer 200 with index.html for a missing file.
		return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
	} catch {
		return false;
	}
}

export async function pickBackend() {
	const q = new URLSearchParams(location.search);
	if (q.get('patch-test') === '1') return createScriptedBackend();
	const want = q.get('dm');
	if (want === 'scripted') return createScriptedBackend();
	if (want === 'prompt') return createPromptApiBackend();
	if (want === 'lfm') return createLfmBackend();
	if ((await promptApiAvailability()) === 'available') return createPromptApiBackend();
	if (await lfmPresent()) return createLfmBackend();
	return createScriptedBackend();
}
