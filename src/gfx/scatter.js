// Scatter system: the forest and the rocks. Tens of thousands of instances drawn through a handful of InstancedMeshes.
//
//   near ..... real meshes in three LODs, chosen per instance by distance, per 48 m cell with frustum culling
//   far ...... trees become two crossed billboards whose texture is rendered from the tree itself at load time
//   shadows .. cast by a low-detail invisible proxy of the nearby trees only (full-detail trees in four cascades would
//              cost millions of triangles per frame)
// Instance matrices are computed once; per frame the buckets are refilled by copying those matrices.

import * as THREE from 'three/webgpu';
import { placeRocks, placeTrees } from '../sim/scatterPlacement.js';

const QUALITY = {
	low: { density: 0.45, lod: [ 14, 45, 130 ], far: 700, shadow: 0, rockFar: 160 },
	medium: { density: 0.7, lod: [ 18, 58, 180 ], far: 1000, shadow: 90, rockFar: 260 },
	high: { density: 1, lod: [ 20, 62, 175 ], far: 1500, shadow: 105, rockFar: 320 },
	ultra: { density: 1, lod: [ 30, 95, 300 ], far: 2200, shadow: 200, rockFar: 520 },
};

const ROCK_ASSETS = [ 'rock_moss_set_01', 'rock_moss_set_02', 'boulder_01', 'namaqualand_boulder_04', 'namaqualand_boulder_05', 'namaqualand_boulder_06' ];
const CAPACITY = [ 96, 640, 6000 ]; // instances per variant in LOD 0 / 1 / 2

/** The drawable parts ( geometry + material ) of a named node, which is a Mesh or a Group of Meshes. */
function partsOf( root, name ) {

	const node = root.getObjectByName( name );
	if ( ! node ) throw new Error( `scatter: node "${name}" not found` );
	const parts = [];
	node.traverse( ( o ) => {

		if ( o.isMesh ) parts.push( { geometry: o.geometry, material: o.material } );

	} );
	return parts;

}

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createScatter( ctx ) {

	const { world, worldTex, scene, camera, renderer, assets } = ctx;
	const quality = QUALITY[ ctx.quality.tier ] ?? QUALITY.high;
	const group = new THREE.Group();
	group.name = 'scatter';
	const allowed = ( x, z ) => worldTex.maskValue( x, z ) > 0.5;
	const sets = [];

	// ───────────────────────────── loading ─────────────────────────────
	const treeAsset = assets.index.trees?.assets?.[ 0 ] ?? null;
	const rockAssets = ( assets.index.rocks?.assets ?? [] ).filter( ( a ) => ROCK_ASSETS.includes( a.id ) );
	const [ treeGltf, ...rockGltfs ] = await Promise.all( [ treeAsset ? assets.gltf( treeAsset.file ) : null, ...rockAssets.map( ( a ) => assets.gltf( a.file ) ) ] );

	/** Builds the LOD buckets of one kind of object from its variants and placement. */
	function createSet( kind, variants, roots, placement, { billboards } ) {

		const matrices = new Float32Array( placement.count * 16 );
		const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3( 0, 1, 0 ), p = new THREE.Vector3(), s = new THREE.Vector3();
		for ( let i = 0; i < placement.count; i ++ ) {

			m.compose( p.set( placement.x[ i ], placement.y[ i ], placement.z[ i ] ), q.setFromAxisAngle( up, placement.yaw[ i ] ), s.setScalar( placement.scale[ i ] ) );
			m.toArray( matrices, i * 16 );

		}

		const buckets = variants.map( ( variant, v ) => {

			const lods = variant.lods.map( ( lod, level ) => partsOf( roots[ v ], lod.node ).map( ( part ) => {

				const mesh = new THREE.InstancedMesh( part.geometry, part.material, CAPACITY[ Math.min( level, 2 ) ] );
				mesh.name = `${variant.name}-lod${level}`;
				mesh.frustumCulled = false; // culled per cell
				mesh.castShadow = kind === 'rocks' && level === Math.min( 1, variant.lods.length - 1 );
				mesh.receiveShadow = true;
				mesh.count = 0;
				mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
				group.add( mesh );
				return mesh;

			} ) );
			return { variant, lods, counts: [ 0, 0, 0 ], shadow: [], shadowCount: 0, billboard: null, billboardCount: 0 };

		} );

		return { kind, variants, placement, matrices, buckets, billboards };

	}

	if ( treeAsset && treeGltf ) {

		const variants = treeAsset.variants;
		const placement = placeTrees( world, variants, { density: quality.density, allowed } );
		const set = createSet( 'trees', variants, variants.map( () => treeGltf.scene ), placement, { billboards: true } );
		sets.push( set );

		for ( const bucket of set.buckets ) {

			const variant = bucket.variant;
			const coarse = partsOf( treeGltf.scene, variant.lods[ variant.lods.length - 1 ].node );

			// shadow proxy: the coarsest LOD, invisible in the main pass, casting into the sun cascades
			if ( quality.shadow > 0 ) {

				bucket.shadow = coarse.map( ( part ) => {

					const material = part.material.clone();
					material.colorWrite = false;
					material.depthWrite = false;
					const mesh = new THREE.InstancedMesh( part.geometry, material, 1400 );
					mesh.name = `${variant.name}-shadow`;
					mesh.frustumCulled = false;
					mesh.castShadow = true;
					mesh.count = 0;
					mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
					group.add( mesh );
					return mesh;

				} );

			}

			// far billboard: render the tree once from the side (unlit albedo + alpha) and map it on two crossed quads
			const width = variant.crownRadius * 2.1, height = variant.size[ 1 ];
			const target = new THREE.RenderTarget( 192, Math.round( 192 * Math.min( 3, height / width ) ), { depthBuffer: true } );
			const bake = new THREE.Scene();
			for ( const part of partsOf( treeGltf.scene, variant.lods[ Math.min( 1, variant.lods.length - 1 ) ].node ) ) {

				const material = new THREE.MeshBasicMaterial( { map: part.material.map, alphaTest: part.material.alphaTest || 0, side: THREE.DoubleSide, vertexColors: part.material.vertexColors } );
				bake.add( new THREE.Mesh( part.geometry, material ) );

			}

			const lens = new THREE.OrthographicCamera( - width / 2, width / 2, height, 0, 0.1, 60 );
			lens.position.set( 0, 0, 30 );
			const previousColor = renderer.getClearColor( new THREE.Color() ), previousAlpha = renderer.getClearAlpha();
			renderer.setClearColor( 0x0c1a0c, 0 );
			renderer.setRenderTarget( target );
			renderer.render( bake, lens );
			renderer.setRenderTarget( null );
			renderer.setClearColor( previousColor, previousAlpha );

			const card = new THREE.PlaneGeometry( width, height ).translate( 0, height / 2, 0 );
			const cross = card.clone().rotateY( Math.PI / 2 );
			const positions = new Float32Array( [ ...card.attributes.position.array, ...cross.attributes.position.array ] );
			const uvs = new Float32Array( [ ...card.attributes.uv.array, ...cross.attributes.uv.array ] );
			// lighting normals of a rough cone rather than of flat cards, so both quads shade alike
			const normals = new Float32Array( positions.length );
			for ( let i = 0; i < positions.length; i += 3 ) {

				const len = Math.hypot( positions[ i ], positions[ i + 2 ] ) || 1;
				normals.set( new THREE.Vector3( positions[ i ] / len * 0.55, 0.75, positions[ i + 2 ] / len * 0.55 ).normalize().toArray(), i );

			}

			const index = [ ...card.index.array, ...Array.from( cross.index.array, ( k ) => k + 4 ) ];
			const billboardGeometry = new THREE.BufferGeometry();
			billboardGeometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
			billboardGeometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
			billboardGeometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
			billboardGeometry.setIndex( index );
			const billboardMaterial = new THREE.MeshStandardMaterial( { map: target.texture, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.95, metalness: 0, color: 0xd8d8d8 } );
			const billboard = new THREE.InstancedMesh( billboardGeometry, billboardMaterial, Math.max( 16, set.placement.count ) );
			billboard.name = `${variant.name}-billboard`;
			billboard.frustumCulled = false;
			billboard.count = 0;
			group.add( billboard );
			bucket.billboard = billboard;

		}

		// trunks near the road are solid
		const colliders = [];
		const f = {};
		for ( let i = 0; i < placement.count; i ++ ) {

			const variant = variants[ placement.variant[ i ] ];
			if ( variant.collider?.type !== 'cylinder' ) continue;
			if ( world.fieldsAt( placement.x[ i ], placement.z[ i ], f ).roadDistance > 45 ) continue;
			colliders.push( { type: 'cylinder', kind: 'tree', position: [ placement.x[ i ], placement.y[ i ] + 2, placement.z[ i ] ], radius: Math.max( 0.14, variant.collider.radius * placement.scale[ i ] * 1.2 ), halfHeight: 2.2 } );
			worldTex.stampCircle( placement.x[ i ], placement.z[ i ], 0.5, 0.2, 1.2 );

		}

		ctx.addObstacles( colliders );

	}

	if ( rockAssets.length ) {

		const variants = [], roots = [];
		rockAssets.forEach( ( asset, a ) => {

			for ( const variant of asset.variants ) {

				variants.push( variant );
				roots.push( rockGltfs[ a ].scene );

			}

		} );
		const placement = placeRocks( world, variants, { density: quality.density, allowed } );
		sets.push( createSet( 'rocks', variants, roots, placement, { billboards: false } ) );

		const colliders = [];
		const f = {};
		for ( let i = 0; i < placement.count; i ++ ) {

			const variant = variants[ placement.variant[ i ] ], scale = placement.scale[ i ];
			const reach = Math.max( variant.size[ 0 ], variant.size[ 2 ] ) * scale * 0.5;
			if ( reach > 0.6 ) worldTex.stampCircle( placement.x[ i ], placement.z[ i ], reach * 0.8, 0, 0.6 );
			if ( reach < 0.45 || world.fieldsAt( placement.x[ i ], placement.z[ i ], f ).roadDistance > 40 ) continue;
			const height = variant.size[ 1 ] * scale;
			colliders.push( { type: 'cylinder', kind: 'rock', position: [ placement.x[ i ], placement.y[ i ] + height * 0.4, placement.z[ i ] ], radius: reach * 0.8, halfHeight: Math.max( 0.2, height * 0.45 ) } );

		}

		ctx.addObstacles( colliders );

	}

	scene.add( group );

	// ───────────────────────────── per-frame bucket selection ─────────────────────────────
	const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4(), box = new THREE.Box3(), last = new THREE.Vector3( Infinity, 0, 0 ), lastFar = new THREE.Vector3( Infinity, 0, 0 );
	const lod2 = quality.lod[ 0 ] ** 2, lod1 = quality.lod[ 1 ] ** 2; // squared switch distances LOD0→1 and LOD1→2
	let frameCount = 0;

	function fillNear( set ) {

		const { placement, matrices, buckets } = set;
		const V = set.variants.length, cellSize = placement.cellSize, side = placement.cellsPerSide;
		const reach = set.kind === 'trees' ? quality.lod[ 2 ] : quality.rockFar;
		const reach2 = reach * reach;
		const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
		for ( const b of buckets ) {

			b.counts[ 0 ] = b.counts[ 1 ] = b.counts[ 2 ] = 0;
			b.shadowCount = 0;

		}

		const c0x = Math.max( 0, Math.floor( ( cx - reach - world.minX ) / cellSize ) ), c1x = Math.min( side - 1, Math.floor( ( cx + reach - world.minX ) / cellSize ) );
		const c0z = Math.max( 0, Math.floor( ( cz - reach - world.minZ ) / cellSize ) ), c1z = Math.min( side - 1, Math.floor( ( cz + reach - world.minZ ) / cellSize ) );
		const shadow2 = quality.shadow * quality.shadow;
		for ( let iz = c0z; iz <= c1z; iz ++ ) {

			for ( let ix = c0x; ix <= c1x; ix ++ ) {

				const cell = iz * side + ix;
				const from = placement.cellStart[ cell * V ], to = placement.cellStart[ ( cell + 1 ) * V ];
				if ( from === to ) continue;
				const x0 = world.minX + ix * cellSize, z0 = world.minZ + iz * cellSize;
				box.min.set( x0 - 4, cy - 400, z0 - 4 );
				box.max.set( x0 + cellSize + 4, cy + 400, z0 + cellSize + 4 );
				const visible = frustum.intersectsBox( box );
				for ( let i = from; i < to; i ++ ) {

					const dx = placement.x[ i ] - cx, dz = placement.z[ i ] - cz;
					const d2 = dx * dx + dz * dz;
					if ( d2 > reach2 ) continue;
					const b = buckets[ placement.variant[ i ] ];
					if ( b.shadow.length && d2 < shadow2 && b.shadowCount < 1400 ) {

						for ( const mesh of b.shadow ) mesh.instanceMatrix.array.set( matrices.subarray( i * 16, i * 16 + 16 ), b.shadowCount * 16 );
						b.shadowCount ++;

					}

					if ( ! visible ) continue;
					const levels = b.lods.length;
					let level = set.kind === 'trees' ? ( d2 < lod2 ? 0 : d2 < lod1 ? 1 : 2 ) : ( d2 < 900 ? 0 : d2 < 8100 ? 1 : 2 );
					if ( level >= levels ) level = levels - 1;
					const n = b.counts[ level ];
					if ( n >= CAPACITY[ level ] ) continue;
					for ( const mesh of b.lods[ level ] ) mesh.instanceMatrix.array.set( matrices.subarray( i * 16, i * 16 + 16 ), n * 16 );
					b.counts[ level ] = n + 1;

				}

			}

		}

		for ( const b of buckets ) {

			b.lods.forEach( ( meshes, level ) => {

				for ( const mesh of meshes ) {

					mesh.count = b.counts[ level ];
					mesh.instanceMatrix.needsUpdate = true;

				}

			} );
			for ( const mesh of b.shadow ) {

				mesh.count = b.shadowCount;
				mesh.instanceMatrix.needsUpdate = true;

			}

		}

	}

	/** Far trees: whole cells between the LOD range and the far limit, copied as blocks (no per-instance test). */
	function fillFar( set ) {

		const { placement, matrices, buckets } = set;
		const V = set.variants.length, cellSize = placement.cellSize, side = placement.cellsPerSide;
		const cx = camera.position.x, cz = camera.position.z;
		const inner = Math.max( 0, quality.lod[ 2 ] - cellSize * 0.75 ), inner2 = inner * inner, far2 = quality.far * quality.far;
		for ( const b of buckets ) b.billboardCount = 0;
		for ( let iz = 0; iz < side; iz ++ ) {

			const dz = world.minZ + ( iz + 0.5 ) * cellSize - cz;
			for ( let ix = 0; ix < side; ix ++ ) {

				const dx = world.minX + ( ix + 0.5 ) * cellSize - cx;
				const d2 = dx * dx + dz * dz;
				if ( d2 < inner2 || d2 > far2 ) continue;
				const cell = iz * side + ix;
				for ( let v = 0; v < V; v ++ ) {

					const from = placement.cellStart[ cell * V + v ], to = placement.cellStart[ cell * V + v + 1 ];
					if ( from === to ) continue;
					const b = buckets[ v ];
					b.billboard.instanceMatrix.array.set( matrices.subarray( from * 16, to * 16 ), b.billboardCount * 16 );
					b.billboardCount += to - from;

				}

			}

		}

		for ( const b of buckets ) {

			b.billboard.count = b.billboardCount;
			b.billboard.instanceMatrix.needsUpdate = true;

		}

	}

	function update() {

		frameCount ++;
		const moved = camera.position.distanceToSquared( last );
		// refill when the camera has moved a little, and at least a few times per second (it may only have turned)
		if ( moved < 4 && frameCount % 8 !== 0 ) return;
		last.copy( camera.position );
		viewProjection.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		frustum.setFromProjectionMatrix( viewProjection, camera.coordinateSystem, camera.reversedDepth );
		for ( const set of sets ) fillNear( set );
		if ( camera.position.distanceToSquared( lastFar ) > 576 ) {

			lastFar.copy( camera.position );
			for ( const set of sets ) if ( set.billboards ) fillFar( set );

		}

	}

	update();
	console.info( `[scatter] ${sets.map( ( s ) => `${s.placement.count} ${s.kind}` ).join( ', ' )}` );

	return {
		update,
		/** Placement data per kind, for debugging. */
		placement: Object.fromEntries( sets.map( ( s ) => [ s.kind, s.placement ] ) ),
		dispose() {

			scene.remove( group );

		},
	};

}
