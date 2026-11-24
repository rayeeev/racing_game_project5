import globals from 'globals';

// Minimal correctness-oriented lint setup (no style rules): catches undefined identifiers, unused code and
// accidental globals across modules written by different authors.
const rules = {
	'no-undef': 'error',
	'no-unused-vars': [ 'warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true } ],
	'no-const-assign': 'error',
	'no-dupe-keys': 'error',
	'no-dupe-args': 'error',
	'no-dupe-class-members': 'error',
	'no-unreachable': 'warn',
	'no-self-assign': 'error',
	'no-redeclare': 'error',
	'no-import-assign': 'error',
	'no-cond-assign': [ 'error', 'except-parens' ],
	'no-constant-binary-expression': 'error',
	'no-unsafe-negation': 'error',
	'use-isnan': 'error',
	'valid-typeof': 'error',
	'no-fallthrough': 'warn',
	'no-empty': [ 'warn', { allowEmptyCatch: true } ],
	'getter-return': 'error',
	'no-async-promise-executor': 'error',
	'no-loss-of-precision': 'error',
	'no-shadow-restricted-names': 'error',
};

export default [
	{
		ignores: [ 'node_modules/**', 'dist/**', 'public/**', 'assets-src/**', 'dev/crib/**' ],
	},
	{
		files: [ 'src/**/*.js', 'dev/**/*.js' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: { ...globals.browser, ...globals.es2025 },
		},
		rules,
	},
	{
		// The simulation layer must also run in Node: only universal globals are allowed there.
		files: [ 'src/sim/**/*.js', 'src/core/math.js', 'src/core/rng.js', 'src/core/events.js' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: { ...globals.es2025, console: 'readonly', performance: 'readonly', fetch: 'readonly', atob: 'readonly', btoa: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly' },
		},
		rules,
	},
	{
		files: [ 'tools/**/*.mjs', 'tests/**/*.mjs', 'src/sim/**/*.node.js', '*.config.js' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: { ...globals.node, ...globals.es2025 },
		},
		rules,
	},
];
