// Downloads Liquid LFM2.5-1.2B-Instruct (ONNX) into public/models/lfm2.5-1.2b/ so Patch can serve it from 'self'.
// Idempotent: files whose size and sha256 match are skipped. Usage: node tools/fetch-model.mjs [--q4]  (--q4 adds the no-shader-f16 fallback)
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'lfm2.5-1.2b');
const want = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'];
if (process.argv.includes('--q4')) want.push('onnx/model_q4.onnx', 'onnx/model_q4.onnx_data');

const sha256 = (file) =>
	new Promise((res, rej) => {
		const h = createHash('sha256');
		createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
	});

const tree = async (dir) => (await (await fetch(`https://huggingface.co/api/models/${REPO}/tree/main${dir ? '/' + dir : ''}`)).json());
const meta = new Map();
for (const e of [...(await tree('')), ...(await tree('onnx'))]) if (e.type === 'file') meta.set(e.path, { size: e.size, sha: e.lfs?.oid });

for (const path of want) {
	const m = meta.get(path);
	if (!m) throw new Error(`not in repo: ${path}`);
	const dest = join(OUT, path);
	await mkdir(dirname(dest), { recursive: true });
	const have = await stat(dest).catch(() => null);
	if (have?.size === m.size && (!m.sha || (await sha256(dest)) === m.sha)) {
		console.log(`ok    ${path}`);
		continue;
	}
	const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${path}`);
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	let got = 0;
	let last = 0;
	const tmp = dest + '.part';
	const body = Readable.fromWeb(res.body);
	body.on('data', (d) => {
		got += d.length;
		if (Date.now() - last > 500) {
			last = Date.now();
			process.stdout.write(`\r${path} ${(got / 1e6).toFixed(1)}/${(m.size / 1e6).toFixed(1)} MB`);
		}
	});
	await pipeline(body, createWriteStream(tmp));
	process.stdout.write('\n');
	if (m.sha && (await sha256(tmp)) !== m.sha) {
		await rm(tmp);
		throw new Error(`sha256 mismatch: ${path}`);
	}
	await rename(tmp, dest);
	console.log(`done  ${path}`);
}
