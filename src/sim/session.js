// Assembles a drivable simulation from a baked World: physics world (terrain + road colliders), the car, obstacles.
// Used by the game (src/game/sessionController.js) and by the Node tools (lap simulation, ghost baking). No rendering.
//
// Per fixed step:   sim.step( input )   =   vehicle.step( input ); physics.step(); vehicle.afterStep();
//
// Obstacle descriptors for addObstacles( list ) - plain objects, positions in world space:
//   { type: 'box',      position: [x,y,z], quaternion?: [x,y,z,w], halfExtents: [hx,hy,hz], kind }
//   { type: 'cylinder', position: [x,y,z], quaternion?, radius, halfHeight, kind }              (axis = local Y)
//   { type: 'hull',     position: [x,y,z], quaternion?, scale?: number, points: number[][] | Float32Array, kind }
//   kind: 'rail' | 'tree' | 'rock' | 'prop' | 'other'  (reported in ImpactEvent.kind)
//   Add  dynamic: true, mass: <kg>  (+ optional friction, restitution, userData) for things the car can knock over;
//   those return a handle { body, collider, kind, userData } whose body.translation() / body.rotation() the renderer reads.

import { GRAVITY } from './constants.js';
import { PhysicsWorld, loadRapier } from './physics.js';
import { buildRoadRibbon } from './roadGeometry.js';
import { Vehicle } from './vehicle.js';
import { SPORTS_CAR, applyModelGeometry } from './vehicleConfig.js';

/**
 * Vehicle configuration with the geometry measured on the 3D car model (public/assets/car/car.json).
 * @param {Object} carSpec parsed car.json
 * @param {typeof SPORTS_CAR} [base]
 */
export function vehicleConfigFromCar( carSpec, base = SPORTS_CAR ) {

	const w = carSpec?.wheels;
	if ( ! w?.fl?.position || ! w?.rl?.position ) return base;
	return applyModelGeometry( base, {
		frontTrack: carSpec.trackFront ?? ( w.fr.position[ 0 ] - w.fl.position[ 0 ] ),
		rearTrack: carSpec.trackRear ?? ( w.rr.position[ 0 ] - w.rl.position[ 0 ] ),
		frontAxleZ: w.fl.position[ 2 ],
		rearAxleZ: w.rl.position[ 2 ],
		frontWheelRadius: w.fl.radius,
		rearWheelRadius: w.rl.radius,
		wheelWidth: ( w.fl.width + w.rl.width ) / 2,
	} );

}

/**
 * @param {import('./world.js').World} world
 * @param {Object} [options]
 * @param {number} [options.wetness=0]     0 dry .. 1 wet
 * @param {typeof SPORTS_CAR} [options.vehicleConfig]
 * @returns {Promise<Simulation>}
 */
export async function createSimulation( world, { wetness = 0, vehicleConfig = SPORTS_CAR } = {} ) {

	const RAPIER = await loadRapier();
	const physics = new PhysicsWorld( RAPIER, { gravity: - GRAVITY } );
	const track = world.track;

	physics.addHeightfield( { heights: world.heights, n: world.n, cell: world.cell, minX: world.minX, minZ: world.minZ, kind: 'terrain' } );
	const ribbon = buildRoadRibbon( track );
	physics.addTriMesh( { positions: ribbon.positions, indices: ribbon.indices, kind: 'road' } );
	physics.setSurfaceQuery( ( x, z ) => world.surfaceAt( x, z ) );

	const vehicle = new Vehicle( physics, vehicleConfig );
	vehicle.setWetness( wetness );
	vehicle.reset( track.spawnPose( track.gridS ), 0 );

	/**
	 * @typedef {Object} Simulation
	 * @property {PhysicsWorld} physics
	 * @property {Vehicle} vehicle
	 * @property {import('./world.js').World} world
	 * @property {import('./track.js').Track} track
	 * @property {number} dt              fixed step in seconds
	 * @property {(input: import('./types.js').VehicleInput) => void} step
	 * @property {(list: Object[]) => (Object|null)[]} addObstacles   returns one entry per descriptor: the handle of a dynamic body, null for static ones
	 */
	return {
		physics,
		vehicle,
		world,
		track,
		dt: physics.dt,

		step( input ) {

			vehicle.step( input );
			physics.step();
			vehicle.afterStep();

		},

		addObstacles( list ) {

			const handles = [];
			for ( const o of list ) {

				const kind = o.kind ?? 'other';
				if ( o.dynamic ) {

					const shape = o.type === 'box' ? { type: 'box', halfExtents: o.halfExtents }
						: o.type === 'cylinder' ? { type: 'cylinder', radius: o.radius, halfHeight: o.halfHeight }
							: { type: 'hull', points: o.points, scale: o.scale };
					handles.push( physics.addDynamicBody( {
						shape, position: o.position, quaternion: o.quaternion, mass: o.mass ?? 10, kind,
						friction: o.friction, restitution: o.restitution, userData: o.userData, sleeping: true,
					} ) );
					continue;

				}

				if ( o.type === 'box' ) physics.addStaticBox( { center: o.position, halfExtents: o.halfExtents, quaternion: o.quaternion, kind } );
				else if ( o.type === 'cylinder' ) physics.addStaticCylinder( { center: o.position, radius: o.radius, halfHeight: o.halfHeight, quaternion: o.quaternion, kind } );
				else if ( o.type === 'hull' ) physics.addStaticHull( { points: o.points, position: o.position, quaternion: o.quaternion, scale: o.scale ?? 1, kind } );
				else throw new Error( `addObstacles: unknown obstacle type "${o.type}"` );
				handles.push( null );

			}

			return handles;

		},
	};

}
