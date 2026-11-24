#!/usr/bin/env node
// Review helper: crop a region of an image (fractions 0..1 of width/height) and optionally scale it.
//   node tools/assets/trees-crop.mjs <in> <out.png> <x0> <y0> <x1> <y1> [maxSize]
import sharp from 'sharp';
const [ inp, out, x0, y0, x1, y1, maxSize ] = process.argv.slice( 2 );
const meta = await sharp( inp ).metadata();
const left = Math.round( Number( x0 ) * meta.width ), top = Math.round( Number( y0 ) * meta.height );
const width = Math.round( ( Number( x1 ) - Number( x0 ) ) * meta.width ), height = Math.round( ( Number( y1 ) - Number( y0 ) ) * meta.height );
let img = sharp( inp ).extract( { left, top, width, height } );
if ( maxSize ) img = img.resize( Number( maxSize ), Number( maxSize ), { fit: 'inside', kernel: 'nearest' } );
await img.flatten( { background: '#ff00ff' } ).png().toFile( out );
console.log( 'wrote', out, `${width}x${height} of ${meta.width}x${meta.height} channels=${meta.channels}` );
