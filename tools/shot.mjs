#!/usr/bin/env node
// Headless-Chrome driver for visual verification (WebGPU enabled).
//
// Simple usage:
//   node tools/shot.mjs --url http://127.0.0.1:5173/dev/foo.html --out /abs/path/foo.png \
//        [--wait-for "window.__ready === true"] [--delay 500] [--eval "window.__game.something()"]
//        [--width 1600] [--height 900] [--dpr 1] [--timeout 90000] [--headed] [--fail-on-error]
//
// Scripted usage (multiple shots / interaction):
//   node tools/shot.mjs --url <url> --script /abs/path/scenario.mjs [--out-dir /abs/dir]
//   where scenario.mjs has:  export default async function ({ page, shot, sleep, log, outDir }) { ... }
//   `shot(name)` saves <out-dir>/<name>.png and returns the path.
//
// Always prints a JSON summary as the LAST line of stdout:
//   {"ok":true,"shots":[...],"errors":[...],"warnings":[...],"webgpu":true|false|null}
// Console errors/warnings and uncaught page errors are echoed to stdout as they happen.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs( argv ) {

	const args = {};
	for ( let i = 0; i < argv.length; i ++ ) {

		const a = argv[ i ];
		if ( ! a.startsWith( '--' ) ) continue;
		const key = a.slice( 2 );
		const next = argv[ i + 1 ];
		if ( next === undefined || next.startsWith( '--' ) ) {

			args[ key ] = true;

		} else {

			args[ key ] = next;
			i ++;

		}

	}

	return args;

}

const args = parseArgs( process.argv.slice( 2 ) );

if ( ! args.url ) {

	console.error( 'usage: node tools/shot.mjs --url <url> (--out <png> | --script <scenario.mjs> [--out-dir <dir>]) [options]' );
	process.exit( 2 );

}

const width = Number( args.width || 1600 );
const height = Number( args.height || 900 );
const dpr = Number( args.dpr || 1 );
const timeout = Number( args.timeout || 90000 );
const delay = Number( args.delay || 0 );
const outDir = resolve( args[ 'out-dir' ] || ( args.out ? dirname( resolve( args.out ) ) : process.cwd() ) );
mkdirSync( outDir, { recursive: true } );

const errors = [];
const warnings = [];
const shots = [];
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
const log = ( ...a ) => console.log( '[shot]', ...a );

const browser = await chromium.launch( {
	channel: 'chrome',
	headless: ! args.headed,
	args: [
		'--enable-unsafe-webgpu',
		'--enable-features=WebGPU',
		'--use-angle=metal',
		'--ignore-gpu-blocklist',
		'--enable-gpu-rasterization',
		'--autoplay-policy=no-user-gesture-required',
		'--mute-audio',
		'--disable-background-timer-throttling',
		'--disable-renderer-backgrounding',
		'--disable-backgrounding-occluded-windows',
	],
} );

let exitCode = 0;
let webgpu = null;

try {

	const context = await browser.newContext( {
		viewport: { width, height },
		deviceScaleFactor: dpr,
	} );
	const page = await context.newPage();
	page.setDefaultTimeout( timeout );

	page.on( 'console', ( msg ) => {

		const type = msg.type();
		const text = msg.text();
		if ( type === 'error' ) {

			errors.push( text );
			console.log( '[console.error]', text );

		} else if ( type === 'warning' ) {

			warnings.push( text );
			if ( ! args.quiet ) console.log( '[console.warn]', text );

		} else if ( args.verbose ) {

			console.log( `[console.${type}]`, text );

		}

	} );
	page.on( 'pageerror', ( err ) => {

		const text = String( err && err.stack ? err.stack : err );
		errors.push( 'pageerror: ' + text );
		console.log( '[pageerror]', text );

	} );
	page.on( 'requestfailed', ( req ) => {

		const text = `requestfailed: ${req.url()} (${req.failure()?.errorText})`;
		// Aborted requests during navigation are normal noise.
		if ( /ERR_ABORTED/.test( text ) ) return;
		errors.push( text );
		console.log( '[requestfailed]', text );

	} );
	page.on( 'response', ( res ) => {

		if ( res.status() >= 400 ) {

			const text = `http ${res.status()}: ${res.url()}`;
			errors.push( text );
			console.log( '[http]', text );

		}

	} );

	const shot = async ( name, opts = {} ) => {

		const file = name.endsWith( '.png' ) || name.endsWith( '.jpg' ) ? resolve( outDir, name ) : join( outDir, name + '.png' );
		mkdirSync( dirname( file ), { recursive: true } );
		await page.screenshot( { path: file, ...opts } );
		shots.push( file );
		log( 'saved', file );
		return file;

	};

	await page.goto( args.url, { waitUntil: 'load', timeout } );

	webgpu = await page.evaluate( async () => {

		try {

			if ( ! navigator.gpu ) return false;
			const adapter = await navigator.gpu.requestAdapter();
			return !! adapter;

		} catch ( e ) {

			return false;

		}

	} );

	if ( args[ 'wait-for' ] ) {

		await page.waitForFunction( args[ 'wait-for' ], null, { timeout, polling: 100 } );

	}

	if ( args.script ) {

		const mod = await import( pathToFileURL( resolve( args.script ) ).href );
		const run = mod.default || mod.run;
		await run( { page, shot, sleep, log, outDir, args } );

	} else {

		if ( args.eval ) {

			const result = await page.evaluate( args.eval );
			if ( result !== undefined ) log( 'eval result:', JSON.stringify( result ) );

		}

		if ( delay > 0 ) await sleep( delay );
		if ( args.out ) await shot( resolve( args.out ) );

	}

} catch ( err ) {

	errors.push( 'driver: ' + String( err && err.stack ? err.stack : err ) );
	console.log( '[driver-error]', err );
	exitCode = 1;

} finally {

	await browser.close();

}

if ( args[ 'fail-on-error' ] && errors.length > 0 ) exitCode = 1;

console.log( JSON.stringify( { ok: exitCode === 0, shots, errors, warnings: warnings.slice( 0, 50 ), webgpu } ) );
process.exit( exitCode );
