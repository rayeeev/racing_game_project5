import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		host: '127.0.0.1',
		port: 5173,
		// No hot-module reloading: a game keeps too much GPU/physics state for HMR to be meaningful,
		// and automated screenshot runs must never be interrupted by a reload. Just refresh the page.
		hmr: false,
	},
	preview: {
		host: '127.0.0.1',
		port: 4173,
	},
	build: {
		target: 'esnext',
		chunkSizeWarningLimit: 6000,
	},
	optimizeDeps: {
		// All browser dependencies (three, rapier) are native ES modules, so dependency pre-bundling is not needed.
		// Disabling discovery also guarantees the dev server never triggers a "deps changed -> full reload"
		// while a page is running (important for automated screenshot runs).
		noDiscovery: true,
		include: [],
	},
});
