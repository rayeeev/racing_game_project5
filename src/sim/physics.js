// Thin wrapper around the Rapier rigid-body engine: static world geometry (terrain heightfield, road mesh, rails,
// rocks ...), knock-over props, ray casts that report the ground surface, and chassis impact events.
//
// Rapier facts this module relies on (verified against @dimforge/rapier3d-compat 0.21.0, see tests/sim/physics.test.mjs):
//  - ColliderDesc.heightfield( nrows, ncols, heights, scale ): nrows / ncols count CELLS (so the matrix holds
//    (nrows + 1) x (ncols + 1) samples), rows run along +Z, columns along +X, storage is column-major
//    (index = ix * (nrows + 1) + iz), and the field is centred on the collider origin spanning scale.x by scale.z.
//  - Scene queries (world.castRay ...) only see colliders after the next world.step(); colliders added since the last
//    step are therefore ray-tested individually (see raycast()).
//  - Contact-force events are NOT used: against heightfields / triangle meshes their magnitude includes stale
//    warm-start impulses of manifolds that no longer carry load (a resting 1200 kg body reported 55x its weight).
//    Impacts are derived from the measured momentum change of the body instead (see step()).
//  - world.contactPair( a, b, f ) hands f( manifold, flipped ); with `flipped` true manifold.normal() points from b
//    toward a, otherwise from a toward b. Local contact points 1 / 2 swap likewise.
//  - Ray time-of-impact is measured in units of the direction's length; triangle meshes and heightfields are hit from
//    both sides and the reported normal always faces the ray origin.

import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY, PHYSICS_DT, Surface } from './constants.js';

/** @typedef {import('./types.js').ImpactEvent} ImpactEvent */

/**
 * Result of PhysicsWorld.raycast(). The SAME object is returned by every call: copy what you need to keep.
 * @typedef {Object} RayHit
 * @property {number} distance  distance from the ray origin to the hit point in meters
 * @property {number[]} point   [x,y,z] world position of the hit
 * @property {number[]} normal  [x,y,z] unit surface normal at the hit, facing the ray origin
 * @property {string} kind      kind of the collider that was hit ('terrain', 'road', 'rail', 'rock', 'prop' ...)
 * @property {number} surface   Surface id at the hit (see constants.js)
 * @property {object} collider  the Rapier collider that was hit
 */

/**
 * Handle of a dynamic prop created by PhysicsWorld.addDynamicBody().
 * @typedef {Object} DynamicBodyHandle
 * @property {object} body      Rapier rigid body (read translation() / rotation() to place the visual)
 * @property {object} collider  Rapier collider attached to the body
 * @property {string} kind      collider kind, reported in ray hits and impact events
 * @property {*} userData       whatever was passed to addDynamicBody()
 */

/**
 * Handle of a chassis body created by PhysicsWorld.addVehicleBody().
 * @typedef {Object} VehicleBodyHandle
 * @property {object} body        Rapier rigid body
 * @property {object[]} colliders Rapier colliders of the body shell
 * @property {string} kind        collider kind
 */

const DEFAULT_STATIC_FRICTION = 0.9;
const MAX_PENDING_IMPACTS = 16;
const CONTACT_MARGIN = 0.02; // m; manifold points farther apart than this are predictive, not touching

/** Surface reported for ray hits, by collider kind. Kinds not listed are treated as asphalt; 'terrain' asks the surface query. */
const KIND_SURFACE = Object.freeze( { road: Surface.ASPHALT, rock: Surface.ROCK } );

let rapierPromise = null;

/**
 * Initialises the Rapier WebAssembly module (idempotent: every call returns the same promise).
 * @returns {Promise<typeof RAPIER>} the ready-to-use RAPIER namespace
 */
export function loadRapier() {

	rapierPromise ??= RAPIER.init().then( () => RAPIER );
	return rapierPromise;

}

/**
 * The physics world of one session: owns the Rapier world and everything inside it.
 */
export class PhysicsWorld {

	/**
	 * @param {typeof RAPIER} rapier  the initialised RAPIER namespace (see loadRapier)
	 * @param {Object} [options]
	 * @param {number} [options.dt]       fixed time step in seconds
	 * @param {number} [options.gravity]  gravitational acceleration along +Y in m/s^2 (negative = down)
	 */
	constructor( rapier, { dt = PHYSICS_DT, gravity = - GRAVITY } = {} ) {

		/** The RAPIER namespace this world was built with. */
		this.RAPIER = rapier;

		/** Fixed time step in seconds. */
		this.dt = dt;

		/** The underlying Rapier world (for advanced use; prefer the methods of this class). */
		this.world = new rapier.World( { x: 0, y: gravity, z: 0 } );
		this.world.timestep = dt;

		/**
		 * Handles of all bodies created with addDynamicBody(), in creation order.
		 * @type {DynamicBodyHandle[]}
		 */
		this.dynamicBodies = [];

		/** Number of step() calls so far. */
		this.stepCount = 0;

		this._gravity = gravity;
		this._colliderMeta = new Map(); // collider handle -> { kind, surface, record }
		this._tracked = new Map(); // rigid-body handle -> impact record
		this._trackedList = [];
		this._pending = []; // colliders created since the last step (invisible to scene queries until then)
		this._surfaceQuery = null;

		this._ray = new rapier.Ray( { x: 0, y: 0, z: 0 }, { x: 0, y: - 1, z: 0 } );
		this._sceneHit = new rapier.RayColliderIntersection( null, 0, { x: 0, y: 0, z: 0 } );
		this._shapeHit = new rapier.RayIntersection( 0, { x: 0, y: 0, z: 0 } );
		this._hit = { distance: 0, point: [ 0, 0, 0 ], normal: [ 0, 1, 0 ], kind: 'other', surface: Surface.ASPHALT, collider: null };

		this._vec = { x: 0, y: 0, z: 0 };
		this._quat = { x: 0, y: 0, z: 0, w: 1 };

		// Scratch state of the contact enumeration (see _collectImpacts).
		this._impulse = [ 0, 0, 0 ]; // contact impulse received by the record being processed, N s
		this._record = null;
		this._ownCollider = null;
		this._otherCollider = null;
		this._pairNormal = [ 0, 0, 0 ];
		this._pairPoint = [ 0, 0, 0 ];
		this._pairCount = 0;

		this._capturePreStep = ( body ) => {

			const record = body.userData;
			if ( record === undefined || record === null || record.preLinvel === undefined ) return;
			body.linvel( record.preLinvel );
			body.angvel( record.preAngvel );
			record.stamp = this.stepCount;

		};

		this._onManifold = ( manifold, flipped ) => {

			// Geometric contact points in the local space of the vehicle collider; the normal is turned so that it
			// points from the other collider toward the vehicle. (Solver contacts and per-contact impulses are not
			// exposed for heightfield / triangle-mesh pairs.)
			const count = manifold.numContacts();
			let touching = 0;
			for ( let i = 0; i < count; i ++ ) {

				if ( manifold.contactDist( i ) > CONTACT_MARGIN ) continue;
				const p = flipped ? manifold.localContactPoint2( i, this._vec ) : manifold.localContactPoint1( i, this._vec );
				if ( p === null ) continue;
				this._pairPoint[ 0 ] += p.x;
				this._pairPoint[ 1 ] += p.y;
				this._pairPoint[ 2 ] += p.z;
				touching ++;

			}

			if ( touching === 0 ) return;
			const n = manifold.normal( this._vec );
			const sign = flipped ? touching : - touching;
			this._pairNormal[ 0 ] += n.x * sign;
			this._pairNormal[ 1 ] += n.y * sign;
			this._pairNormal[ 2 ] += n.z * sign;
			this._pairCount += touching;

		};

		this._onContactPair = ( other ) => {

			this._otherCollider = other;
			this._pairNormal[ 0 ] = this._pairNormal[ 1 ] = this._pairNormal[ 2 ] = 0;
			this._pairPoint[ 0 ] = this._pairPoint[ 1 ] = this._pairPoint[ 2 ] = 0;
			this._pairCount = 0;
			this.world.contactPair( this._ownCollider, other, this._onManifold );
			if ( this._pairCount > 0 ) this._recordImpact();

		};

	}

	/**
	 * Adds a static square heightfield.
	 * @param {Object} params
	 * @param {Float32Array} params.heights  n * n heights, row-major with z as the row: index = iz * n + ix
	 * @param {number} params.n              samples per side
	 * @param {number} params.cell           sample spacing in meters
	 * @param {number} params.minX           world x of sample ix = 0
	 * @param {number} params.minZ           world z of sample iz = 0
	 * @param {string} [params.kind]         collider kind ('terrain' hits ask the surface query, 'road' hits are asphalt)
	 * @param {number} [params.friction]     friction coefficient against rigid bodies
	 * @returns {object} the Rapier collider
	 */
	addHeightfield( { heights, n, cell, minX, minZ, kind = 'terrain', friction = DEFAULT_STATIC_FRICTION } ) {

		if ( heights.length !== n * n ) throw new Error( `addHeightfield: expected ${n * n} heights, got ${heights.length}` );

		// Rapier wants column-major storage with z along the rows: index = ix * n + iz.
		const columnMajor = new Float32Array( n * n );
		for ( let iz = 0; iz < n; iz ++ ) {

			for ( let ix = 0; ix < n; ix ++ ) columnMajor[ ix * n + iz ] = heights[ iz * n + ix ];

		}

		const size = ( n - 1 ) * cell;
		const R = this.RAPIER;
		const desc = R.ColliderDesc.heightfield( n - 1, n - 1, columnMajor, { x: size, y: 1, z: size }, R.HeightFieldFlags.FIX_INTERNAL_EDGES )
			.setTranslation( minX + size / 2, 0, minZ + size / 2 )
			.setFriction( friction );
		const collider = this._addStatic( desc, kind );
		collider.clearShapeCache(); // drop the JS-side copy of the height matrix
		return collider;

	}

	/**
	 * Adds a static triangle mesh (in world coordinates).
	 * @param {Object} params
	 * @param {Float32Array|number[]} params.positions  xyz triples
	 * @param {Uint32Array|number[]} params.indices     triangle vertex indices
	 * @param {string} [params.kind]                    collider kind ('road' hits are asphalt)
	 * @param {number} [params.friction]                friction coefficient against rigid bodies
	 * @returns {object} the Rapier collider
	 */
	addTriMesh( { positions, indices, kind = 'road', friction = DEFAULT_STATIC_FRICTION } ) {

		const R = this.RAPIER;
		const vertices = positions instanceof Float32Array ? positions : new Float32Array( positions );
		const triangles = indices instanceof Uint32Array ? indices : new Uint32Array( indices );
		// Two-sided internal-edge repair keeps contacts sane whatever the winding of the source mesh is.
		const desc = R.ColliderDesc.trimesh( vertices, triangles, R.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED ).setFriction( friction );
		const collider = this._addStatic( desc, kind );
		collider.clearShapeCache();
		return collider;

	}

	/**
	 * Adds a static box.
	 * @param {Object} params
	 * @param {number[]} params.center        [x,y,z] world position of the box centre
	 * @param {number[]} params.halfExtents   [hx,hy,hz]
	 * @param {number[]} [params.quaternion]  [x,y,z,w] orientation
	 * @param {string} [params.kind]          collider kind
	 * @param {number} [params.friction]      friction coefficient against rigid bodies
	 * @returns {object} the Rapier collider
	 */
	addStaticBox( { center, halfExtents, quaternion, kind = 'other', friction = DEFAULT_STATIC_FRICTION } ) {

		const desc = this.RAPIER.ColliderDesc.cuboid( halfExtents[ 0 ], halfExtents[ 1 ], halfExtents[ 2 ] ).setFriction( friction );
		return this._addStatic( placeDesc( desc, center, quaternion ), kind );

	}

	/**
	 * Adds a static cylinder whose axis is its local Y axis.
	 * @param {Object} params
	 * @param {number[]} params.center        [x,y,z] world position of the cylinder centre
	 * @param {number} params.radius
	 * @param {number} params.halfHeight
	 * @param {number[]} [params.quaternion]  [x,y,z,w] orientation
	 * @param {string} [params.kind]          collider kind
	 * @param {number} [params.friction]      friction coefficient against rigid bodies
	 * @returns {object} the Rapier collider
	 */
	addStaticCylinder( { center, radius, halfHeight, quaternion, kind = 'other', friction = DEFAULT_STATIC_FRICTION } ) {

		const desc = this.RAPIER.ColliderDesc.cylinder( halfHeight, radius ).setFriction( friction );
		return this._addStatic( placeDesc( desc, center, quaternion ), kind );

	}

	/**
	 * Adds a static convex hull.
	 * @param {Object} params
	 * @param {Float32Array|number[]} params.points   xyz triples in the hull's local space
	 * @param {number[]} [params.position]            [x,y,z] world position of the local origin
	 * @param {number[]} [params.quaternion]          [x,y,z,w] orientation
	 * @param {number|number[]} [params.scale]        uniform or per-axis scale applied to the points
	 * @param {string} [params.kind]                  collider kind ('rock' hits report Surface.ROCK)
	 * @param {number} [params.friction]              friction coefficient against rigid bodies
	 * @returns {object} the Rapier collider
	 */
	addStaticHull( { points, position, quaternion, scale = 1, kind = 'rock', friction = DEFAULT_STATIC_FRICTION } ) {

		const desc = this.RAPIER.ColliderDesc.convexHull( scalePoints( points, scale ) );
		if ( desc === null ) throw new Error( 'addStaticHull: the points do not span a convex hull' );
		return this._addStatic( placeDesc( desc.setFriction( friction ), position, quaternion ), kind );

	}

	/**
	 * Adds a dynamic rigid body with a single collider (cones, signs, barriers ... anything the car can knock over).
	 * Ray casts made with `staticOnly` (the wheels) ignore these bodies; the chassis shell collides with them.
	 * @param {Object} params
	 * @param {Object} params.shape  { type: 'box', halfExtents: [hx,hy,hz] } | { type: 'cylinder', radius, halfHeight }
	 *                               (axis = local Y) | { type: 'hull', points, scale? }
	 * @param {number[]} params.position        [x,y,z] world position of the body origin (= shape centre / hull origin)
	 * @param {number[]} [params.quaternion]    [x,y,z,w] orientation
	 * @param {number} params.mass              kg (the inertia follows from the shape)
	 * @param {number} [params.friction]
	 * @param {number} [params.restitution]
	 * @param {string} [params.kind]            collider kind
	 * @param {*} [params.userData]             stored on the returned handle
	 * @param {number} [params.linearDamping]   1/s
	 * @param {number} [params.angularDamping]  1/s
	 * @param {boolean} [params.sleeping]       create the body asleep (it wakes up when something touches it)
	 * @returns {DynamicBodyHandle}
	 */
	addDynamicBody( { shape, position, quaternion, mass, friction = 0.6, restitution = 0.1, kind = 'prop', userData, linearDamping = 0.05, angularDamping = 0.3, sleeping = false } ) {

		const R = this.RAPIER;
		const bodyDesc = R.RigidBodyDesc.dynamic()
			.setTranslation( position[ 0 ], position[ 1 ], position[ 2 ] )
			.setLinearDamping( linearDamping )
			.setAngularDamping( angularDamping )
			.setSleeping( sleeping );
		if ( quaternion ) bodyDesc.setRotation( toRotation( quaternion ) );
		const body = this.world.createRigidBody( bodyDesc );

		const colliderDesc = this._shapeDesc( shape ).setMass( mass ).setFriction( friction ).setRestitution( restitution );
		const collider = this.world.createCollider( colliderDesc, body );
		body.recomputeMassPropertiesFromColliders();

		const handle = { body, collider, kind, userData, preLinvel: { x: 0, y: 0, z: 0 }, preAngvel: { x: 0, y: 0, z: 0 }, stamp: - 1 };
		body.userData = handle;
		this._register( collider, kind, handle );
		this.dynamicBodies.push( handle );
		return handle;

	}

	/**
	 * Adds the dynamic body of a vehicle chassis: explicit mass properties (the colliders carry no mass) and a body
	 * shell made of convex hulls. The body never sleeps and its impacts are recorded (see drainImpacts). It is not
	 * listed in `dynamicBodies`.
	 * @param {Object} params
	 * @param {Array<Float32Array|number[]>} params.hulls  point clouds (xyz triples, body space), one convex hull each
	 * @param {number[]} [params.position]           [x,y,z] initial world position of the body origin
	 * @param {number[]} [params.quaternion]         [x,y,z,w] initial orientation
	 * @param {number} params.mass                   kg
	 * @param {number[]} params.centerOfMass         [x,y,z] in body space
	 * @param {number[]} params.principalInertia     [Ixx, Iyy, Izz] about the body axes through the centre of mass, kg m^2
	 * @param {number} [params.friction]             shell friction (combined with the other collider by taking the minimum)
	 * @param {number} [params.restitution]          shell restitution
	 * @param {string} [params.kind]                 collider kind
	 * @param {number} [params.impactForceThreshold] contact force in N (averaged over one step) above which impacts are recorded
	 * @param {boolean} [params.ccd]                 continuous collision detection (prevents tunnelling at top speed)
	 * @returns {VehicleBodyHandle}
	 */
	addVehicleBody( { hulls, position = [ 0, 0, 0 ], quaternion, mass, centerOfMass, principalInertia, friction = 0.25, restitution = 0.1, kind = 'vehicle', impactForceThreshold = 0.25 * mass * GRAVITY, ccd = true } ) {

		const R = this.RAPIER;
		const bodyDesc = R.RigidBodyDesc.dynamic()
			.setTranslation( position[ 0 ], position[ 1 ], position[ 2 ] )
			.setAdditionalMassProperties(
				mass,
				{ x: centerOfMass[ 0 ], y: centerOfMass[ 1 ], z: centerOfMass[ 2 ] },
				{ x: principalInertia[ 0 ], y: principalInertia[ 1 ], z: principalInertia[ 2 ] },
				{ x: 0, y: 0, z: 0, w: 1 } )
			.setCanSleep( false )
			.setCcdEnabled( ccd );
		if ( quaternion ) bodyDesc.setRotation( toRotation( quaternion ) );
		const body = this.world.createRigidBody( bodyDesc );

		const record = {
			body, colliders: [], kind, mass, impacts: [], impactCount: 0, impulseThreshold: impactForceThreshold * this.dt,
			preLinvel: { x: 0, y: 0, z: 0 }, preAngvel: { x: 0, y: 0, z: 0 }, userForce: { x: 0, y: 0, z: 0 }, stamp: - 1,
		};
		for ( const points of hulls ) {

			const desc = R.ColliderDesc.convexHull( points instanceof Float32Array ? points : new Float32Array( points ) );
			if ( desc === null ) throw new Error( 'addVehicleBody: a hull point cloud does not span a convex hull' );
			desc.setDensity( 0 )
				.setFriction( friction )
				.setFrictionCombineRule( R.CoefficientCombineRule.Min )
				.setRestitution( restitution );
			const collider = this.world.createCollider( desc, body );
			this._register( collider, kind, record );
			record.colliders.push( collider );

		}

		body.recomputeMassPropertiesFromColliders();
		body.userData = record;
		this._tracked.set( body.handle, record );
		this._trackedList.push( record );
		return record;

	}

	/**
	 * Installs the function that tells which ground surface lies at a world position. It is consulted for ray hits
	 * on 'terrain' colliders; without one such hits report asphalt.
	 * @param {((x: number, z: number) => number)|null} fn  returns a Surface id
	 */
	setSurfaceQuery( fn ) {

		this._surfaceQuery = fn;

	}

	/**
	 * Casts a ray and returns the closest hit, or null. The direction does not have to be normalised.
	 * The returned object is REUSED by the next call.
	 * @param {number} ox  ray origin
	 * @param {number} oy
	 * @param {number} oz
	 * @param {number} dx  ray direction
	 * @param {number} dy
	 * @param {number} dz
	 * @param {number} maxDist             maximum hit distance in meters
	 * @param {object|null} [excludeBody]  Rapier rigid body whose colliders are ignored
	 * @param {boolean} [staticOnly]       ignore colliders attached to dynamic / kinematic bodies (used by wheels)
	 * @returns {RayHit|null}
	 */
	raycast( ox, oy, oz, dx, dy, dz, maxDist, excludeBody = null, staticOnly = false ) {

		const length = Math.sqrt( dx * dx + dy * dy + dz * dz );
		if ( ! ( length > 0 ) ) return null;
		const ux = dx / length, uy = dy / length, uz = dz / length;

		const R = this.RAPIER, world = this.world, ray = this._ray;
		ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
		ray.dir.x = ux; ray.dir.y = uy; ray.dir.z = uz;

		const flags = staticOnly ? ( R.QueryFilterFlags.ONLY_FIXED | R.QueryFilterFlags.EXCLUDE_SENSORS ) : R.QueryFilterFlags.EXCLUDE_SENSORS;
		const sceneHit = world.broadPhase.castRayAndGetNormal( world.narrowPhase, world.bodies, world.colliders, ray, maxDist, true, flags, undefined, null, excludeBody !== null ? excludeBody.handle : null, undefined, this._sceneHit );

		let distance = Infinity, collider = null, nx = 0, ny = 1, nz = 0;
		if ( sceneHit !== null ) {

			distance = sceneHit.timeOfImpact;
			collider = sceneHit.collider;
			nx = sceneHit.normal.x; ny = sceneHit.normal.y; nz = sceneHit.normal.z;

		}

		// Colliders created since the last step are not in the scene-query structure yet: test them one by one.
		for ( let i = 0; i < this._pending.length; i ++ ) {

			const candidate = this._pending[ i ];
			const parent = candidate.parent();
			if ( parent !== null ) {

				if ( excludeBody !== null && parent.handle === excludeBody.handle ) continue;
				if ( staticOnly && ! parent.isFixed() ) continue;

			}

			const shapeHit = candidate.castRayAndGetNormal( ray, maxDist, true, this._shapeHit );
			if ( shapeHit !== null && shapeHit.timeOfImpact < distance ) {

				distance = shapeHit.timeOfImpact;
				collider = candidate;
				nx = shapeHit.normal.x; ny = shapeHit.normal.y; nz = shapeHit.normal.z;

			}

		}

		if ( collider === null ) return null;

		const hit = this._hit;
		const px = ox + ux * distance, py = oy + uy * distance, pz = oz + uz * distance;
		hit.distance = distance;
		hit.point[ 0 ] = px; hit.point[ 1 ] = py; hit.point[ 2 ] = pz;
		hit.normal[ 0 ] = nx; hit.normal[ 1 ] = ny; hit.normal[ 2 ] = nz;
		hit.collider = collider;

		const meta = this._colliderMeta.get( collider.handle );
		if ( meta === undefined ) {

			hit.kind = 'other';
			hit.surface = Surface.ASPHALT;

		} else {

			hit.kind = meta.kind;
			hit.surface = meta.surface >= 0 ? meta.surface : ( this._surfaceQuery !== null ? this._surfaceQuery( px, pz ) : Surface.ASPHALT );

		}

		return hit;

	}

	/**
	 * Advances the simulation by `dt` and gathers the impacts of vehicle bodies. The contact impulse a vehicle body
	 * received is measured as its momentum change minus what gravity and the forces added with body.addForce() /
	 * addForceAtPoint() explain, then attributed to the touching collider pairs by their contact normals.
	 */
	step() {

		this.stepCount ++;

		// Remember pre-step velocities: after the step the solver has already removed the approach speed.
		const tracked = this._trackedList;
		for ( let i = 0; i < tracked.length; i ++ ) {

			const record = tracked[ i ];
			this._capturePreStep( record.body );
			record.body.userForce( record.userForce );

		}

		this.world.forEachActiveRigidBody( this._capturePreStep );

		this.world.step();
		this._pending.length = 0;

		for ( let i = 0; i < tracked.length; i ++ ) this._collectImpacts( tracked[ i ] );

	}

	/**
	 * Moves the impacts recorded for a vehicle body since the last drain into `out` (which is cleared first).
	 * The event objects stored in `out` are reused by later calls with the same array.
	 * @param {object} body          Rapier rigid body created by addVehicleBody()
	 * @param {ImpactEvent[]} [out]  array to fill
	 * @returns {ImpactEvent[]} `out`
	 */
	drainImpacts( body, out = [] ) {

		const record = this._tracked.get( body.handle );
		const count = record === undefined ? 0 : record.impactCount;
		for ( let i = 0; i < count; i ++ ) {

			const source = record.impacts[ i ];
			const target = out[ i ] ?? ( out[ i ] = createImpact() );
			target.impulse = source.impulse;
			target.speed = source.speed;
			target.kind = source.kind;
			target.point[ 0 ] = source.point[ 0 ]; target.point[ 1 ] = source.point[ 1 ]; target.point[ 2 ] = source.point[ 2 ];
			target.normal[ 0 ] = source.normal[ 0 ]; target.normal[ 1 ] = source.normal[ 1 ]; target.normal[ 2 ] = source.normal[ 2 ];

		}

		out.length = count;
		if ( record !== undefined ) record.impactCount = 0;
		return out;

	}

	/**
	 * Frees the WebAssembly memory of this world. The instance must not be used afterwards.
	 */
	dispose() {

		this.world.free();
		this.dynamicBodies.length = 0;
		this._colliderMeta.clear();
		this._tracked.clear();
		this._trackedList.length = 0;
		this._pending.length = 0;
		this._surfaceQuery = null;

	}

	_addStatic( desc, kind ) {

		const collider = this.world.createCollider( desc );
		this._register( collider, kind, null );
		return collider;

	}

	_register( collider, kind, record ) {

		const surface = kind === 'terrain' ? - 1 : ( KIND_SURFACE[ kind ] ?? Surface.ASPHALT );
		this._colliderMeta.set( collider.handle, { kind, surface, record } );
		this._pending.push( collider );

	}

	_shapeDesc( shape ) {

		const C = this.RAPIER.ColliderDesc;
		switch ( shape.type ) {

			case 'box':
				return C.cuboid( shape.halfExtents[ 0 ], shape.halfExtents[ 1 ], shape.halfExtents[ 2 ] );
			case 'cylinder':
				return C.cylinder( shape.halfHeight, shape.radius );
			case 'hull': {

				const desc = C.convexHull( scalePoints( shape.points, shape.scale ?? 1 ) );
				if ( desc === null ) throw new Error( 'addDynamicBody: the hull points do not span a convex hull' );
				return desc;

			}

			default:
				throw new Error( `addDynamicBody: unknown shape type "${shape.type}"` );

		}

	}

	/** Records the impacts a vehicle body received during the step that just ran. */
	_collectImpacts( record ) {

		const body = record.body, dt = this.dt, mass = record.mass;
		const v = body.linvel( this._vec );
		const jx = mass * ( v.x - record.preLinvel.x ) - record.userForce.x * dt;
		const jy = mass * ( v.y - record.preLinvel.y ) - ( record.userForce.y + mass * this._gravity * body.gravityScale() ) * dt;
		const jz = mass * ( v.z - record.preLinvel.z ) - record.userForce.z * dt;
		if ( ! ( jx * jx + jy * jy + jz * jz >= record.impulseThreshold * record.impulseThreshold ) ) return;

		this._impulse[ 0 ] = jx; this._impulse[ 1 ] = jy; this._impulse[ 2 ] = jz;
		this._record = record;
		for ( let i = 0; i < record.colliders.length; i ++ ) {

			this._ownCollider = record.colliders[ i ];
			this.world.contactPairsWith( this._ownCollider, this._onContactPair );

		}

		this._record = null;
		this._ownCollider = null;
		this._otherCollider = null;

	}

	/** Appends the impact of the collider pair gathered in _pairNormal / _pairPoint to the record being processed. */
	_recordImpact() {

		const record = this._record;
		const normal = this._pairNormal, point = this._pairPoint;
		const length = Math.hypot( normal[ 0 ], normal[ 1 ], normal[ 2 ] );
		if ( ! ( length > 1e-9 ) ) return;
		const nx = normal[ 0 ] / length, ny = normal[ 1 ] / length, nz = normal[ 2 ] / length;

		// Share of the measured impulse that this pair's normal explains (friction and other pairs fall away).
		const impulse = this._impulse[ 0 ] * nx + this._impulse[ 1 ] * ny + this._impulse[ 2 ] * nz;
		if ( impulse < record.impulseThreshold || record.impactCount >= MAX_PENDING_IMPACTS ) return;

		// Mean local contact point -> world space of the vehicle collider.
		const lx = point[ 0 ] / this._pairCount, ly = point[ 1 ] / this._pairCount, lz = point[ 2 ] / this._pairCount;
		const q = this._ownCollider.rotation( this._quat );
		const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
		const tx = 2 * ( qy * lz - qz * ly ), ty = 2 * ( qz * lx - qx * lz ), tz = 2 * ( qx * ly - qy * lx );
		const t = this._ownCollider.translation( this._vec );
		const px = t.x + lx + qw * tx + ( qy * tz - qz * ty );
		const py = t.y + ly + qw * ty + ( qz * tx - qx * tz );
		const pz = t.z + lz + qw * tz + ( qx * ty - qy * tx );

		// Approach speed along the normal, from the velocities both bodies had before the step.
		const com = record.body.worldCom( this._vec );
		const rx = px - com.x, ry = py - com.y, rz = pz - com.z;
		const lin = record.preLinvel, ang = record.preAngvel;
		let vx = lin.x + ang.y * rz - ang.z * ry;
		let vy = lin.y + ang.z * rx - ang.x * rz;
		let vz = lin.z + ang.x * ry - ang.y * rx;
		const otherMeta = this._colliderMeta.get( this._otherCollider.handle );
		const other = otherMeta === undefined ? null : otherMeta.record;
		if ( other !== null && other.stamp === this.stepCount ) {

			const otherCom = other.body.worldCom( this._vec );
			const ox = px - otherCom.x, oy = py - otherCom.y, oz = pz - otherCom.z;
			const olin = other.preLinvel, oang = other.preAngvel;
			vx -= olin.x + oang.y * oz - oang.z * oy;
			vy -= olin.y + oang.z * ox - oang.x * oz;
			vz -= olin.z + oang.x * oy - oang.y * ox;

		}

		const impact = record.impacts[ record.impactCount ] ?? ( record.impacts[ record.impactCount ] = createImpact() );
		record.impactCount ++;
		impact.impulse = impulse;
		impact.speed = Math.max( 0, - ( vx * nx + vy * ny + vz * nz ) );
		impact.kind = otherMeta === undefined ? 'other' : otherMeta.kind;
		impact.point[ 0 ] = px; impact.point[ 1 ] = py; impact.point[ 2 ] = pz;
		impact.normal[ 0 ] = nx; impact.normal[ 1 ] = ny; impact.normal[ 2 ] = nz;

	}

}

/** @returns {ImpactEvent} */
function createImpact() {

	return { impulse: 0, point: [ 0, 0, 0 ], normal: [ 0, 1, 0 ], kind: 'other', speed: 0 };

}

function toRotation( q ) {

	return { x: q[ 0 ], y: q[ 1 ], z: q[ 2 ], w: q[ 3 ] };

}

function placeDesc( desc, position, quaternion ) {

	if ( position ) desc.setTranslation( position[ 0 ], position[ 1 ], position[ 2 ] );
	if ( quaternion ) desc.setRotation( toRotation( quaternion ) );
	return desc;

}

function scalePoints( points, scale ) {

	const sx = typeof scale === 'number' ? scale : scale[ 0 ];
	const sy = typeof scale === 'number' ? scale : scale[ 1 ];
	const sz = typeof scale === 'number' ? scale : scale[ 2 ];
	const scaled = new Float32Array( points.length );
	for ( let i = 0; i < points.length; i += 3 ) {

		scaled[ i ] = points[ i ] * sx;
		scaled[ i + 1 ] = points[ i + 1 ] * sy;
		scaled[ i + 2 ] = points[ i + 2 ] * sz;

	}

	return scaled;

}
