// Entry point of the game.

import { Game } from './game/game.js';
import { installDebugApi } from './game/debugApi.js';

const canvas = document.getElementById( 'view' );
const uiRoot = document.getElementById( 'ui' );
const boot = document.getElementById( 'boot' );
const bootBar = document.getElementById( 'boot-bar' );
const bootLabel = document.getElementById( 'boot-label' );

function showFatal( title, detail ) {

	boot.classList.remove( 'done' );
	boot.classList.add( 'error' );
	boot.querySelector( '.boot-title' ).textContent = title;
	bootLabel.textContent = detail;
	bootBar.style.width = '0%';

}

async function main() {

	if ( ! ( 'gpu' in navigator ) ) console.warn( '[project5] WebGPU is not available - falling back to WebGL 2 (reduced visual quality).' );

	const params = new URLSearchParams( location.search );
	const game = new Game( {
		canvas,
		uiRoot,
		startPhase: params.get( 'start' ) === 'drive' ? 'drive' : 'menu',
		onProgress: ( { fraction, label } ) => {

			bootBar.style.width = `${Math.round( fraction * 100 )}%`;
			bootLabel.textContent = label;

		},
	} );
	installDebugApi( game );

	await game.boot();
	boot.classList.add( 'done' );

}

main().catch( ( err ) => {

	console.error( err );
	showFatal( 'Something went wrong while starting', String( err?.message ?? err ) );

} );
