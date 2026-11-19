export default {
	base: './',
	resolve: { dedupe: ['three'] },
	// The generator and the light bake run in a module worker.
	worker: { format: 'es' },
	build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000, modulePreload: { polyfill: false }, license: { fileName: 'THIRD-PARTY-NOTICES.md' } },
};
