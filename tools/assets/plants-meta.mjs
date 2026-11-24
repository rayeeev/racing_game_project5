import sharp from 'sharp';
for ( const f of process.argv.slice( 2 ) ) {
	const m = await sharp( f ).metadata();
	const st = await sharp( f ).stats();
	console.log( f.split( '/' ).pop(), m.format, m.width + 'x' + m.height, 'ch', m.channels, m.depth, m.space, 'hasAlpha', m.hasAlpha, 'means', st.channels.map( ( c ) => c.mean.toFixed( 1 ) ).join( '/' ), 'min', st.channels.map( ( c ) => c.min ).join( '/' ), 'max', st.channels.map( ( c ) => c.max ).join( '/' ) );
}
