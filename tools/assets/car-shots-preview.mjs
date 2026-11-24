// Scenario for tools/shot.mjs driving dev/preview-car.html: several views / paints / light states in one browser session.
//   VIEWS=front34,rear34 PAINTS=rosso,blu LIGHTS="drl" PREFIX=day node tools/shot.mjs --url "http://127.0.0.1:5173/dev/preview-car.html?hdr=day" \
//        --wait-for "window.__ready === true" --script tools/assets/car-shots-preview.mjs --out-dir <dir>
// env: VIEWS (comma list, default front34), PAINTS (comma list, default: current), LIGHTS (';' separated light-state lists, default: current),
//      POSES (';' separated "steer:spin:sw" triples), PREFIX (file name prefix), CUSTOM_VIEWS (JSON {name:{pos,target,fov}})
export default async function ( { page, shot, sleep, log } ) {

	const views = ( process.env.VIEWS || 'front34' ).split( ',' );
	const paints = process.env.PAINTS ? process.env.PAINTS.split( ',' ) : [ null ];
	const lights = process.env.LIGHTS !== undefined ? process.env.LIGHTS.split( ';' ) : [ null ];
	const poses = process.env.POSES ? process.env.POSES.split( ';' ) : [ null ];
	const prefix = process.env.PREFIX ? process.env.PREFIX + '_' : '';
	const custom = process.env.CUSTOM_VIEWS ? JSON.parse( process.env.CUSTOM_VIEWS ) : {};
	for ( const paint of paints ) {

		if ( paint ) await page.evaluate( ( p ) => window.__setPaint( p ), paint );
		for ( const l of lights ) {

			if ( l !== null ) await page.evaluate( ( s ) => window.__setLights( s ), l );
			for ( const pose of poses ) {

				if ( pose !== null ) { const [ steer, spin, sw ] = pose.split( ':' ).map( Number ); await page.evaluate( ( p ) => window.__setPose( p ), { steer: steer || 0, spin: spin || 0, sw: Number.isFinite( sw ) ? sw : null } ); }
				for ( const v of views ) {

					await page.evaluate( ( view ) => window.__setView( view ), custom[ v ] || v );
					await sleep( 350 );
					const name = prefix + v + ( paint ? '_' + paint : '' ) + ( l !== null && lights.length > 1 ? '_' + ( l.replace( /,/g, '+' ) || 'off' ) : '' ) + ( pose !== null ? '_pose' + pose.replace( /[:.-]/g, '_' ) : '' );
					await shot( name );

				}

			}

		}

	}

	log( 'info', JSON.stringify( await page.evaluate( () => ( { tris: window.__info.triangles, meshes: window.__info.meshes, missing: window.__info.missingMaterials, sun: window.__info.sunDir, sunE: window.__info.sunIrradiance, skyE: window.__info.skyIrradiance } ) ) ) );

}
