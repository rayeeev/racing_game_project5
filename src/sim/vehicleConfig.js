// Every tunable number of the player car: a ~570 hp mid-engine, rear-wheel-drive, naturally aspirated V8 sports car.
// Units are SI (m, kg, s, N, rad) unless a comment says otherwise. Vehicle frame: forward = -Z, right = +X, up = +Y;
// the body origin lies on the ground under the middle of the wheelbase when the car rests at static ride height.

/**
 * @typedef {Object} MeasuredGeometry  dimensions measured on the 3D car model (all optional)
 * @property {number} [wheelbase]     m
 * @property {number} [frontTrack]    m
 * @property {number} [rearTrack]     m
 * @property {number} [wheelRadius]   m (both axles) - or frontWheelRadius / rearWheelRadius
 * @property {number} [frontWheelRadius] m
 * @property {number} [rearWheelRadius]  m
 * @property {number} [wheelWidth]    m
 * @property {number} [frontAxleZ]    m, z of the front axle in the model frame (negative = ahead of the origin)
 * @property {number} [rearAxleZ]     m, z of the rear axle in the model frame
 * @property {number[]} [bodyMin]     [x,y,z] lower corner of the body-shell bounding box in the model frame
 * @property {number[]} [bodyMax]     [x,y,z] upper corner of the body-shell bounding box in the model frame
 */

/** The player car. Treat as immutable: derive variants with structuredClone() / applyModelGeometry(). */
export const SPORTS_CAR = {

	name: 'sports-car',

	/** Dimensions; overwritten from the measured 3D model by applyModelGeometry(). */
	geometry: {
		wheelbase: 2.65, // m
		frontTrack: 1.67, // m, between the front tire centres
		rearTrack: 1.61, // m
		frontAxleZ: - 1.325, // m, z of the front axle (forward = -Z)
		rearAxleZ: 1.325, // m
		frontWheelRadius: 0.358, // m, loaded radius
		rearWheelRadius: 0.358, // m
		wheelWidth: 0.27, // m, mean tread width (visual / skid marks)
		groundClearance: 0.11, // m, lowest point of the shell above the ground at static ride height
		bodyHalfWidth: 0.96, // m, half width of the body shell
		bodyFrontZ: - 2.24, // m, z of the nose
		bodyRearZ: 2.26, // m, z of the tail
		beltHeight: 0.72, // m, height of the widest part of the shell (top of the lower body) above the ground
		roofHeight: 1.19, // m, height of the roof above the ground
		cabinFrontZ: - 0.55, // m, z of the front edge of the roof
		cabinRearZ: 0.95, // m, z of the rear edge of the roof
		cabinHalfWidth: 0.6, // m, half width of the roof
	},

	/** Mass properties of the whole car (sprung + unsprung, with driver). */
	mass: {
		total: 1480, // kg
		frontWeightFraction: 0.42, // share of the static weight on the front axle
		comHeight: 0.44, // m above the ground at static ride height
		inertia: [ 1950, 2100, 520 ], // kg m^2 about the body axes through the centre of mass: [pitch (X), yaw (Y), roll (Z)]
	},

	/** Body shell contact behaviour. */
	shell: {
		friction: 0.22, // low, so wall contact scrubs speed instead of grabbing
		restitution: 0.08,
	},

	suspension: {
		// Fore / aft offsets (in wheel radii) of the rays that sample the ground under each wheel. The wheel sits on the
		// highest sample, corrected for the tire's round profile, which rounds off kerbs and steps.
		rayOffsets: [ 0, - 0.55, 0.55 ],
		front: {
			frequency: 2.25, // Hz, ride frequency of the corner (defines the spring rate with the static corner load)
			dampingRatio: 0.72, // mean damping ratio (bump and rebound are split below)
			bumpReboundSplit: 0.62, // bump damping = ratio * this, rebound damping = ratio * (2 - this)
			droopTravel: 0.075, // m of extension available below static ride height
			bumpTravel: 0.085, // m of compression available above static ride height (before the bump stop is solid)
			bumpStopLength: 0.035, // m, the progressive bump stop acts over the last part of the bump travel
			bumpStopRate: 420000, // N/m reached at the end of the travel (grows linearly from 0, on top of the spring)
			antiRollRate: 20000, // N per m of left / right compression difference
		},
		rear: {
			frequency: 2.45,
			dampingRatio: 0.72,
			bumpReboundSplit: 0.62,
			droopTravel: 0.08,
			bumpTravel: 0.085,
			bumpStopLength: 0.035,
			bumpStopRate: 520000,
			antiRollRate: 15000,
		},
		damperKneeSpeed: 0.45, // m/s, above this damper speed the damping rate drops (digressive valving)
		damperHighSpeedRatio: 0.38, // damping rate above the knee relative to the low-speed rate
		maxForceFactor: 7, // suspension force per wheel is clamped to this multiple of its static load
	},

	tires: {
		// Normalised slip curve g(s) = sin( C * atan( B s - E ( B s - atan( B s ) ) ) ); B is solved so that g(1) = 1.
		shapeC: 1.42, // shape factor: sliding grip = sin( C * 90 deg ) of the peak (0.79 here)
		shapeE: - 0.6, // curvature factor: more negative = rounder, more progressive peak
		loadSensitivity: 0.08, // grip coefficient lost per 100 % of load above the tire's reference load
		peakSlipLoadGain: 0.12, // peak slip grows by this fraction per 100 % of load above the reference
		front: {
			referenceLoad: 3050, // N, load at which the nominal coefficients apply (the static wheel load: the tires are sized for it)
			muLat: 1.35, // peak lateral friction coefficient on dry asphalt at the reference load
			muLong: 1.2, // peak longitudinal friction coefficient
			peakSlipAngle: 0.126, // rad, slip angle of peak lateral grip (7.2 deg)
			peakSlipRatio: 0.095, // slip ratio of peak longitudinal grip
			relaxationLength: 0.32, // m, lateral force build-up distance
		},
		rear: {
			referenceLoad: 4200,
			muLat: 1.38,
			muLong: 1.40,
			peakSlipAngle: 0.112, // 6.4 deg: the wider rear tire is stiffer, giving understeer in the linear range
			peakSlipRatio: 0.09,
			relaxationLength: 0.28,
		},
		wheelInertia: 1.4, // kg m^2 per wheel (tire, rim, brake disc, hub)
		lowSpeed: 3.0, // m/s, slip-ratio denominator floor (keeps the slip model well-conditioned near standstill)
		staticSpeed: 0.6, // m/s, below this speed a held wheel grips statically (see holdStiffness)
		holdStiffness: 160000, // N/m, longitudinal stiffness of a locked tire's static grip
		lowSpeedDamping: 9000, // N s/m, extra contact-patch damping near standstill (fades out by 4 m/s)
		maxSlipDeflection: 9, // lateral deflection clamp at speed, in multiples of the peak slip
	},

	engine: {
		// Full-throttle torque curve [rpm, Nm]: 540 Nm at 6000 rpm, 423 kW at 8600 rpm.
		torqueCurve: [
			[ 800, 300 ], [ 1500, 365 ], [ 2500, 425 ], [ 3500, 470 ], [ 4500, 508 ], [ 5500, 533 ], [ 6000, 540 ],
			[ 6800, 536 ], [ 7600, 516 ], [ 8200, 492 ], [ 8600, 470 ], [ 9000, 440 ], [ 9300, 360 ],
		],
		idleRpm: 950,
		limiterRpm: 9000,
		limiterResumeRpm: 8880, // the limiter cut ends below this speed
		inertia: 0.13, // kg m^2, crankshaft + flywheel + clutch
		frictionTorque: 38, // Nm, engine braking at idle speed with a closed throttle
		frictionPerRpm: 0.0085, // Nm per rpm, growth of the engine braking torque
		throttleExponent: 1.0, // pedal map: applied = pedal ^ exponent
		throttleRate: 20, // 1/s, how fast the applied throttle follows the pedal
	},

	drivetrain: {
		gearRatios: [ 3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69 ],
		reverseRatio: 2.98,
		finalDrive: 5.14, // 7th gear reaches the power peak at about 330 km/h
		efficiency: 0.86, // share of the engine torque reaching the wheels
		shiftTime: 0.085, // s, duration of the torque cut of a gear change
		clutchBiteRpm: 1250, // launch: the clutch starts to transmit at this engine speed ...
		clutchLaunchRpm: 3600, // ... plus up to this much more at full throttle
		clutchGain: 5.5, // Nm per rad/s of engine speed above the bite point
		clutchMaxTorque: 900, // Nm, torque capacity of the clutch
		clutchReleaseRpm: 1150, // the locked clutch opens again below this input-shaft speed (anti-stall)
		differential: {
			preload: 60, // Nm, locking torque without drive torque
			powerLock: 0.32, // locking torque per Nm of drive torque at the differential under power
			coastLock: 0.18, // ... and on the overrun
			viscousRate: 320, // Nm per rad/s of wheel speed difference (the locking torque is capped by the above)
		},
		// Automatic gearbox.
		upshiftRpm: [ 4200, 8750 ], // up-shift speed at zero / full throttle
		downshiftRpm: [ 1900, 5200 ], // down-shift below this speed at zero / full throttle (kick-down)
		brakingDownshiftRpm: 5600, // while braking hard the gearbox shifts down early to stay in the power band
		shiftCooldown: 0.32, // s, minimum time between automatic gear changes
		corneringHoldG: 0.75, // g, automatic shifts are suppressed above this lateral acceleration ...
		corneringHoldRpm: [ 2600, 8850 ], // ... unless the engine would leave this band
		reverseDelay: 0.3, // s the brake must be held at standstill before reverse is selected
		standstillSpeed: 0.6, // m/s
	},

	brakes: {
		maxTorque: 9400, // Nm, sum over all four wheels at full pedal
		frontBias: 0.62, // share of the brake torque on the front axle
		handbrakeTorque: 4200, // Nm per rear wheel
		rate: 18, // 1/s, how fast the applied brake follows the pedal
	},

	aero: {
		dragArea: 0.74, // m^2, Cd * A
		liftArea: 1.0, // m^2, Cl * A (downforce)
		frontDownforceFraction: 0.4, // share of the downforce on the front axle
	},

	steering: {
		maxAngle: 0.6, // rad, mean front road-wheel angle at full lock
		ackermann: 0.8, // 0 = parallel steering, 1 = full Ackermann geometry
		// Keyboard (digital) input shaping.
		rateLow: 3.6, // 1/s, steering-input speed at standstill (full lock in 1 / rate seconds)
		rateHigh: 1.5, // 1/s at rateSpeed and above
		rateSpeed: 60, // m/s
		returnRate: 5.0, // 1/s, speed at which the input returns to centre when the key is released
		counterRate: 7.0, // 1/s, speed when steering through centre to the other side
		analogRate: 12, // 1/s, slew limit in analog mode
		// Speed-dependent lock: lock = atan( wheelbase * lockLatAccel / v^2 ) + lockSlipFactor * front peak slip angle.
		// (The geometric part steers the tightest corner the grip allows; the rest is the front-minus-rear slip angle.)
		lockLatAccel: 13.5, // m/s^2
		lockSlipFactor: 0.7,
		// Counter-steer assistance: the front wheels follow the direction of travel when the car slides.
		counterSteerGain: 1.0, // rad of steer per rad of rear-axle slip angle beyond the threshold
		counterSteerThreshold: 1.0, // in multiples of the rear tires' peak slip angle
		counterSteerMax: 0.45, // rad
		counterSteerMinSpeed: 6, // m/s, fades in above this speed
	},

	assists: {
		abs: true,
		tc: true,
		stability: true,
		steerAssist: true,
		autoGearbox: true,
		absSlip: 1.15, // target braking slip in multiples of the peak slip
		absBand: 0.9, // the brake pressure fades to absMinPressure over this much extra slip
		absMinPressure: 0.08,
		absMinSpeed: 2.5, // m/s
		tcTorqueFactor: 0.97, // drive torque cap as a share of what the rear tires can transmit (feed-forward part)
		tcLateralWeight: 0.85, // how much the lateral tire force in use reduces that cap (friction ellipse = 1)
		tcSlip: 1.0, // target drive slip in multiples of the peak slip, straight ahead (feedback part)
		tcCorneringSlip: 0.45, // target at tcCorneringG of lateral acceleration and above
		tcCorneringG: 1.1, // g
		tcBand: 1.4, // the throttle fades to zero over this much extra slip
		tcMinSpeed: 1.0, // m/s
		stabilitySlip: 1.1, // rear-axle slip angle at which the stability control starts to act, in multiples of the peak slip angle
		stabilityBand: 0.14, // rad, full intervention this far beyond the threshold
		stabilityYawBrake: 2600, // Nm, brake torque on the outer front wheel at full intervention
		stabilityThrottleCut: 0.85, // share of the throttle removed at full intervention
		stabilityMinSpeed: 10, // m/s
	},

};

/**
 * Returns a copy of `config` whose geometry is taken from dimensions measured on the 3D model. Missing measurements
 * keep the configured values; the track, wheelbase and axle positions are kept consistent with each other.
 * @param {typeof SPORTS_CAR} config
 * @param {MeasuredGeometry} measured
 * @returns {typeof SPORTS_CAR} a new config object
 */
export function applyModelGeometry( config, measured ) {

	const result = structuredClone( config );
	const g = result.geometry;
	const has = ( key ) => Number.isFinite( measured[ key ] );

	if ( has( 'frontTrack' ) ) g.frontTrack = measured.frontTrack;
	if ( has( 'rearTrack' ) ) g.rearTrack = measured.rearTrack;
	if ( has( 'wheelWidth' ) ) g.wheelWidth = measured.wheelWidth;
	if ( has( 'wheelRadius' ) ) g.frontWheelRadius = g.rearWheelRadius = measured.wheelRadius;
	if ( has( 'frontWheelRadius' ) ) g.frontWheelRadius = measured.frontWheelRadius;
	if ( has( 'rearWheelRadius' ) ) g.rearWheelRadius = measured.rearWheelRadius;

	if ( has( 'frontAxleZ' ) && has( 'rearAxleZ' ) ) {

		g.frontAxleZ = measured.frontAxleZ;
		g.rearAxleZ = measured.rearAxleZ;
		g.wheelbase = g.rearAxleZ - g.frontAxleZ;

	} else if ( has( 'wheelbase' ) ) {

		const mid = has( 'frontAxleZ' ) ? measured.frontAxleZ + measured.wheelbase / 2
			: has( 'rearAxleZ' ) ? measured.rearAxleZ - measured.wheelbase / 2
				: ( g.frontAxleZ + g.rearAxleZ ) / 2;
		g.wheelbase = measured.wheelbase;
		g.frontAxleZ = mid - g.wheelbase / 2;
		g.rearAxleZ = mid + g.wheelbase / 2;

	}

	if ( Array.isArray( measured.bodyMin ) && Array.isArray( measured.bodyMax ) ) {

		const [ minX, , minZ ] = measured.bodyMin, [ maxX, maxY, maxZ ] = measured.bodyMax;
		const scaleY = maxY / g.roofHeight, cabinLength = ( maxZ - minZ ) / ( g.bodyRearZ - g.bodyFrontZ );
		const oldMid = ( g.bodyFrontZ + g.bodyRearZ ) / 2, newMid = ( minZ + maxZ ) / 2;
		g.cabinHalfWidth *= ( maxX - minX ) / 2 / g.bodyHalfWidth;
		g.bodyHalfWidth = ( maxX - minX ) / 2;
		g.cabinFrontZ = newMid + ( g.cabinFrontZ - oldMid ) * cabinLength;
		g.cabinRearZ = newMid + ( g.cabinRearZ - oldMid ) * cabinLength;
		g.bodyFrontZ = minZ;
		g.bodyRearZ = maxZ;
		g.beltHeight *= scaleY;
		g.roofHeight = maxY;

	}

	return result;

}
