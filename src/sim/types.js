// Shared data contracts of the simulation layer (JSDoc typedefs only - this module has no runtime exports).
// Every sim module and every consumer (rendering, audio, HUD, camera, FX) codes against these shapes.
// See src/sim/constants.js for the axis / sign conventions. Fields may be ADDED by implementers, never renamed or removed.

/**
 * A point of the road centreline with its local frame.
 * The road surface point at lateral offset d is:  P(s, d) = (x, y, z) + d * (lx, ly, lz).
 * @typedef {Object} TrackFrame
 * @property {number} s          distance along the centreline, [0, length)
 * @property {number} x
 * @property {number} y          road surface height at the centreline
 * @property {number} z
 * @property {number} tx         unit tangent = driving direction (includes the slope)
 * @property {number} ty
 * @property {number} tz
 * @property {number} lx         unit LEFT vector lying in the road surface (includes banking), perpendicular to the tangent
 * @property {number} ly
 * @property {number} lz
 * @property {number} ux         unit road-surface normal ("up" of the road): up = tangent x left, and left = up x tangent
 * @property {number} uy
 * @property {number} uz
 * @property {number} curvature  signed horizontal curvature in 1/m; POSITIVE = the road turns LEFT
 * @property {number} halfWidth  half of the paved width in meters
 * @property {number} bank       banking angle in rad; positive = left edge lower (banked for a left turn)
 * @property {number} grade      longitudinal slope dy/ds (positive = uphill)
 */

/**
 * Result of projecting a world position onto the track.
 * @typedef {Object} TrackProjection
 * @property {number} s          distance along the centreline of the nearest centreline point
 * @property {number} d          signed lateral offset (positive = left of the driving direction)
 * @property {number} halfWidth  paved half width at s
 * @property {boolean} onRoad    |d| <= halfWidth
 */

/**
 * Driver controls for one physics step.
 * @typedef {Object} VehicleInput
 * @property {number} steer      -1 (full left) .. +1 (full right)
 * @property {number} throttle   0..1
 * @property {number} brake      0..1
 * @property {number} handbrake  0..1
 * @property {boolean} [shiftUp]   edge-triggered manual up-shift request (ignored in automatic mode)
 * @property {boolean} [shiftDown] edge-triggered manual down-shift request (ignored in automatic mode)
 */

/**
 * Per-wheel telemetry. Wheel order is always [FL, FR, RL, RR].
 * @typedef {Object} WheelState
 * @property {boolean} contact        wheel touches the ground this step
 * @property {number} surface         Surface id under the wheel (valid when contact)
 * @property {number[]} position      [x,y,z] world position of the wheel centre (follows the suspension)
 * @property {number[]} contactPoint  [x,y,z] world position of the tire contact patch (valid when contact)
 * @property {number[]} contactNormal [x,y,z] ground normal at the contact (valid when contact)
 * @property {number} compression     suspension compression in meters (0 = fully extended)
 * @property {number} travel          compression normalised to 0..1 over the full travel
 * @property {number} steer           wheel steer angle in rad (positive = left)
 * @property {number} spin            accumulated rolling rotation angle in rad (for the visual wheel; positive = rolling forward)
 * @property {number} angularVelocity wheel angular velocity in rad/s (positive = rolling forward)
 * @property {number} slipRatio       longitudinal slip ratio (>0 wheelspin, <0 locking)
 * @property {number} slipAngle       lateral slip angle in rad
 * @property {number} slip            combined slip normalised by the surface's peak slip (1 = at peak grip, >1 = sliding)
 * @property {number} skid            0..1 intensity for skid marks / tire smoke / squeal (0 below the grip limit)
 * @property {number} load            vertical tire load in N
 * @property {number} longForce       longitudinal tire force in N (positive = pushes the car forward)
 * @property {number} latForce        lateral tire force in N (positive = toward the car's left)
 */

/**
 * A collision of the chassis with the world during the last step (for audio, sparks, camera shake).
 * @typedef {Object} ImpactEvent
 * @property {number} impulse   magnitude of the contact impulse in N*s
 * @property {number[]} point   [x,y,z] world position
 * @property {number[]} normal  [x,y,z] contact normal pointing away from the other object
 * @property {string} kind      'terrain' | 'rail' | 'rock' | 'tree' | 'prop' | 'road' | 'other'
 * @property {number} speed     relative speed along the normal in m/s
 */

/**
 * Full vehicle telemetry after a physics step. Arrays are reused between steps: copy what you need to keep.
 * The rigid-body origin coincides with the car MODEL origin: on the ground plane under the middle of the car when the car
 * rests on a flat road at static ride height (so the visual model is placed directly at `position`/`quaternion`).
 * @typedef {Object} VehicleState
 * @property {number[]} position         [x,y,z] world position of the body origin
 * @property {number[]} quaternion       [x,y,z,w] world orientation
 * @property {number[]} linearVelocity   [x,y,z] m/s (world)
 * @property {number[]} angularVelocity  [x,y,z] rad/s (world)
 * @property {number} speed              |linearVelocity| in m/s
 * @property {number} forwardSpeed       signed speed along the car's forward axis in m/s
 * @property {number} lateralSpeed       signed speed along the car's left axis in m/s
 * @property {number} yaw                heading in rad (see conventions)
 * @property {number} yawRate            rad/s, positive = turning left
 * @property {number} driftAngle         angle between heading and velocity in rad (0 when slow)
 * @property {number} rpm                engine speed
 * @property {number} gear               -1 = reverse, 0 = neutral, 1..N forward gears
 * @property {boolean} shifting          true while a gear change is in progress (torque cut)
 * @property {number} throttle           throttle actually applied 0..1 (after assists / shift cut)
 * @property {number} brake              brake actually applied 0..1
 * @property {number} handbrake          0..1
 * @property {number} steerInput         smoothed steering command -1..1 (negative = left)
 * @property {number} steerAngle         average front road-wheel angle in rad (positive = left)
 * @property {number} steerLock          road-wheel angle in rad that full steering input currently commands (speed dependent)
 * @property {number} engineLoad         0..1 (how hard the engine is working; drives the engine sound)
 * @property {boolean} revLimiter        true while the limiter is cutting
 * @property {number} longG              longitudinal acceleration in g (positive = accelerating)
 * @property {number} latG               lateral acceleration in g (positive = toward the car's left)
 * @property {WheelState[]} wheels       [FL, FR, RL, RR]
 * @property {number} wheelsOnGround     0..4
 * @property {boolean} airborne          no wheel touches the ground
 * @property {boolean} upsideDown        the car's up axis points below the horizon
 * @property {boolean} tcActive          traction control is intervening
 * @property {boolean} absActive         ABS is intervening
 * @property {ImpactEvent[]} impacts     chassis collisions detected during the last step (empty array if none)
 * @property {number} odometer           meters travelled since the last reset
 */

/**
 * Pose used to place a vehicle.
 * @typedef {Object} SpawnPose
 * @property {number[]} position  [x,y,z] of the body origin (ground level under the car)
 * @property {number} yaw         heading in rad
 */

export {};
