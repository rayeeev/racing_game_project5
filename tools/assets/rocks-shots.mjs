// Scenario for tools/shot.mjs: several camera views of dev/preview-rocks.html (or dev/viewer.html) in one page load.
//   node tools/shot.mjs --url "<preview url>" --wait-for "window.__ready === true" --script tools/assets/rocks-shots.mjs --out-dir <dir> \
//        --views "name|az|el|dist|focus;name2|az|el|dist|focus" [--prefix foo_]
// focus = variant-name substring for preview-rocks.html (empty = everything); for viewer.html it is the model index.
export default async function ( { page, shot, sleep, args } ) {

	const views = String( args.views || '' ).split( ';' ).filter( Boolean );
	const prefix = typeof args.prefix === 'string' ? args.prefix : '';
	for ( const v of views ) {

		const [ name, az, el, dist, focus ] = v.split( '|' );
		await page.evaluate( ( [ a, e, d, f ] ) => {

			const focusArg = f === undefined || f === '' ? null : ( /^\d+$/.test( f ) && ! window.__info.variants ? Number( f ) : f );
			window.__setCamera( Number( a ), Number( e ), Number( d ), focusArg );

		}, [ az, el, dist, focus ] );
		await sleep( 350 );
		await shot( prefix + name );

	}

}
