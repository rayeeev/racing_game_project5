// Scenario for tools/shot.mjs: takes several camera views of a dev/preview-props.html (or dev/viewer.html) page.
//   node tools/shot.mjs --url "<preview url>" --wait-for "window.__ready === true" --script tools/assets/props-scenario.mjs \
//        --out-dir <dir> --views "name:az:el:dist[:focusIndex];name2:az:el:dist;name3:look:ex,ey,ez,tx,ty,tz[,fov]"  [--info 1]
export default async function ( { page, shot, sleep, log, args } ) {

	const views = String( args.views || 'view:35:18:1' ).split( ';' ).filter( Boolean );
	if ( args.info ) {

		const info = await page.evaluate( () => JSON.stringify( { errors: window.__info.errors, items: ( window.__info.items || [] ).map( ( i ) => `${i.asset}/${i.variant}/LOD${i.lod} ${i.triangles}t ${i.size.join( 'x' )} minY ${i.min[ 1 ]}` ) } ) );
		log( 'info', info );

	}

	for ( const v of views ) {

		const [ name, az, el, dist, focus ] = v.split( ':' );
		if ( az === 'look' ) {

			// name:look:ex,ey,ez,tx,ty,tz[,fov]
			await page.evaluate( ( a ) => window.__look( ...a ), el.split( ',' ).map( Number ) );
			await sleep( 350 );
			await shot( name );
			continue;

		}

		await page.evaluate( ( [ az, el, dist, focus ] ) => window.__setCamera( az, el, dist, focus ), [ Number( az ), Number( el ), Number( dist ), focus === undefined || focus === '' ? null : Number( focus ) ] );
		await sleep( 350 );
		await shot( name );

	}

}
