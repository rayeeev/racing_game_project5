#!/usr/bin/env node
// Blocks until a workflow agent with the given label has finished (according to the workflow journal), then exits.
// Usage: node tools/wait-agent.mjs <journal.jsonl> <label> [pollSeconds=20] [timeoutMinutes=360]
// Exit code 0 = finished, 2 = timeout. Used to chain work on intermediate workflow milestones.

import { readFileSync } from 'node:fs';

const [ journal, label, pollArg, timeoutArg ] = process.argv.slice( 2 );
if ( ! journal || ! label ) {

	console.error( 'usage: node tools/wait-agent.mjs <journal.jsonl> <label> [pollSeconds] [timeoutMinutes]' );
	process.exit( 1 );

}

const poll = Number( pollArg || 20 ) * 1000;
const deadline = Date.now() + Number( timeoutArg || 360 ) * 60000;

function check() {

	let text = '';
	try {

		text = readFileSync( journal, 'utf8' );

	} catch {

		return null;

	}

	const entries = [];
	for ( const line of text.split( '\n' ) ) {

		if ( ! line.trim() ) continue;
		try {

			entries.push( JSON.parse( line ) );

		} catch { /* partial line while being written */ }

	}

	const started = entries.filter( ( e ) => e.type === 'started' && e.label === label );
	if ( started.length === 0 ) return null;
	const ids = new Set( started.map( ( e ) => e.agentId ) );
	const keys = new Set( started.map( ( e ) => e.key ) );
	return entries.find( ( e ) => e.type !== 'started' && ( ids.has( e.agentId ) || keys.has( e.key ) ) ) ?? null;

}

for ( ;; ) {

	const done = check();
	if ( done ) {

		console.log( `agent "${label}" finished: type=${done.type}` );
		console.log( JSON.stringify( done ).slice( 0, 3000 ) );
		process.exit( 0 );

	}

	if ( Date.now() > deadline ) {

		console.log( `timeout waiting for agent "${label}"` );
		process.exit( 2 );

	}

	await new Promise( ( r ) => setTimeout( r, poll ) );

}
