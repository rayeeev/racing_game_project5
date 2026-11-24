// UI system: main menu, settings, countdown, HUD, pause and photo-mode hints - plain DOM on top of the canvas.
// Reads frame.hud every frame (writing to the DOM only when a displayed value changes) and calls ctx.game for commands.

import './styles.css';
import { KMH_PER_MS, MPH_PER_MS, clamp, formatDelta, formatLapTime } from '../core/math.js';
import { HEAD_TAS, INSTRUCTOR, LEVELS, STAFF_REMARKS, TAS, pickRivals } from '../game/staff.js';

const MEDAL_COLORS = { gold: 'var(--gold)', silver: 'var(--silver)', bronze: 'var(--bronze)' };
const CAMERA_NAMES = { chase: 'Chase', chaseFar: 'Far chase', bonnet: 'Bonnet', cockpit: 'Cockpit' };

/** Small DOM helper: h( 'div.cls', { attrs }, ...children ). */
function h( spec, attrs = {}, ...children ) {

	const [ tag, ...classes ] = spec.split( '.' );
	const node = document.createElement( tag || 'div' );
	if ( classes.length ) node.className = classes.join( ' ' );
	for ( const [ key, value ] of Object.entries( attrs ) ) {

		if ( key === 'text' ) node.textContent = value;
		else if ( key === 'html' ) node.innerHTML = value;
		else if ( key.startsWith( 'on' ) ) node.addEventListener( key.slice( 2 ), value );
		else if ( key === 'style' ) node.style.cssText = value;
		else node.setAttribute( key, value );

	}

	for ( const child of children ) if ( child ) node.append( child );
	return node;

}

/** A text node wrapper that only touches the DOM when the value changes. */
function field( node ) {

	let last = null;
	return ( value ) => {

		if ( value !== last ) {

			node.textContent = value;
			last = value;

		}

	};

}

/**
 * @param {import('../game/context.js').GameContext} ctx
 */
export async function createUI( ctx ) {

	const { game, settings, events, input, track } = ctx;
	const root = ctx.uiRoot;
	const disposers = [];
	const on = ( name, fn ) => disposers.push( events.on( name, fn ) );

	// ════════════════════════ main menu ════════════════════════
	const paints = ctx.systems.car?.paints ?? [];
	const ghostTimes = () => ctx.assets.index.ghosts?.[ ctx.sky.wetness > 0.5 ? 'wet' : 'dry' ] ?? null;

	const swatches = h( '.ag-swatches' );
	for ( const p of paints ) swatches.append( h( 'button.ag-swatch', { 'data-id': p.id, title: p.name, style: `background:${p.swatch}`, onclick: () => game.setPaint( p.id ) } ) );

	const ghostSeg = h( '.ag-seg' );
	for ( const mode of [ 'off', 'best', 'bronze', 'silver', 'gold' ] ) ghostSeg.append( h( 'button', { 'data-id': mode, onclick: () => game.setGhostMode( mode ) }, h( 'span', { text: mode === 'best' ? 'My best' : ( LEVELS[ mode ] ?? mode ) } ), h( 'small' ) ) );

	const recordLine = h( 'div' );
	const menu = h( '.ag-layer.ag-menu.off', {},
		h( '.ag-menu-col', {},
			h( 'div', {}, h( 'h1.ag-title', { text: 'Project 5' } ), h( '.ag-sub', { text: 'CS 61B · Data Structures' } ) ),
			h( 'button.ag-btn.primary', { onclick: () => game.startSession(), 'data-first': '1' }, h( 'span', { text: 'Start' } ), h( 'small', { text: 'Enter' } ) ),
			paints.length ? h( '.ag-group', {}, h( 'label', { text: 'Paint' } ), swatches ) : null,
			h( '.ag-group', {}, h( 'label', { text: 'Rival ghost' } ), ghostSeg ),
			h( '.ag-row', {},
				h( 'button.ag-btn', { onclick: () => openPanel( 'settings' ) }, h( 'span', { text: 'Settings' } ) ),
				h( 'button.ag-btn', { onclick: () => openPanel( 'controls' ) }, h( 'span', { text: 'Controls' } ) ) ),
			h( '.ag-foot', {}, recordLine ) ) );

	// ════════════════════════ panels ════════════════════════
	const segSetting = ( key, label, options, note ) => {

		const seg = h( '.ag-seg' );
		for ( const [ value, text ] of options ) seg.append( h( 'button', { 'data-v': String( value ), text, onclick: () => settings.set( key, value ) } ) );
		const sync = () => {

			for ( const b of seg.children ) b.classList.toggle( 'on', b.dataset.v === String( settings.get( key ) ) );

		};

		sync();
		on( 'settings:change', ( e ) => {

			if ( e.key === key ) sync();

		} );
		return h( '.ag-setting', {}, h( 'span', {}, document.createTextNode( label ), note ? h( 'small', { text: note } ) : null ), seg );

	};

	const rangeSetting = ( key, label, min, max, step ) => {

		const inputEl = h( 'input', { type: 'range', min, max, step, value: settings.get( key ), oninput: () => settings.set( key, Number( inputEl.value ) ) } );
		return h( '.ag-setting', {}, h( 'span', { text: label } ), inputEl );

	};

	const onOff = [ [ true, 'On' ], [ false, 'Off' ] ];
	const settingsPanel = h( '.ag-panel', {},
		h( 'h2', { text: 'Settings' } ),
		segSetting( 'quality', 'Graphics quality', [ [ 'low', 'Low' ], [ 'medium', 'Medium' ], [ 'high', 'High' ], [ 'ultra', 'Ultra' ] ], 'Applies after a reload' ),
		segSetting( 'gearbox', 'Gearbox', [ [ 'auto', 'Automatic' ], [ 'manual', 'Manual' ] ], 'Manual: E / Q or the shoulder buttons' ),
		segSetting( 'tc', 'Traction control', onOff ),
		segSetting( 'abs', 'Anti-lock brakes', onOff ),
		segSetting( 'stability', 'Stability control', onOff ),
		segSetting( 'steerAssist', 'Steering assist', onOff, 'Speed-sensitive lock and counter-steer help' ),
		segSetting( 'units', 'Speed units', [ [ 'kmh', 'km/h' ], [ 'mph', 'mph' ] ] ),
		segSetting( 'showMinimap', 'Minimap', onOff ),
		segSetting( 'showInputs', 'Pedal display', onOff ),
		rangeSetting( 'cameraShake', 'Camera shake', 0, 1, 0.05 ),
		rangeSetting( 'masterVolume', 'Volume', 0, 1, 0.05 ),
		h( '.ag-row', { style: 'margin-top:1em' },
			h( 'button.ag-btn', { onclick: () => closePanel(), 'data-first': '1' }, h( 'span', { text: 'Back' } ), h( 'small', { text: 'Esc' } ) ),
			h( 'button.ag-btn', { onclick: () => location.reload() }, h( 'span', { text: 'Reload now' } ) ) ) );

	const keys = [
		[ 'W / ↑', 'Accelerate' ], [ 'S / ↓', 'Brake · reverse when stopped' ], [ 'A D / ← →', 'Steer' ], [ 'Space', 'Handbrake' ],
		[ 'E / Q', 'Shift up / down (manual gearbox)' ], [ 'R', 'Back onto the road' ], [ 'Backspace', 'Restart from the grid' ],
		[ 'C', 'Change camera' ], [ 'V', 'Look back (hold)' ], [ 'H', 'Headlights' ], [ 'Tab', 'HUD: full / minimal / off' ],
		[ 'F', 'Photo mode' ], [ 'Esc / P', 'Pause' ], [ 'Gamepad', 'RT / LT pedals · left stick steer · A handbrake · Y camera · Start pause' ],
	];
	const controlsPanel = h( '.ag-panel', {},
		h( 'h2', { text: 'Controls' } ),
		h( '.ag-keys', {}, ...keys.flatMap( ( [ k, text ] ) => [ h( 'div', {}, ...k.split( ' / ' ).map( ( part ) => h( 'kbd', { text: part } ) ) ), h( 'span', { text } ) ] ) ),
		h( 'button.ag-btn', { onclick: () => closePanel(), 'data-first': '1' }, h( 'span', { text: 'Back' } ), h( 'small', { text: 'Esc' } ) ) );

	const pausePanel = h( '.ag-panel', {},
		h( 'h2', { text: 'Paused' } ),
		h( 'button.ag-btn.primary', { onclick: () => game.resume(), 'data-first': '1' }, h( 'span', { text: 'Resume' } ), h( 'small', { text: 'Esc' } ) ),
		h( 'button.ag-btn', { onclick: () => game.restartSession() }, h( 'span', { text: 'Restart from the grid' } ), h( 'small', { text: 'Backspace' } ) ),
		h( 'button.ag-btn', { onclick: () => openPanel( 'settings' ) }, h( 'span', { text: 'Settings' } ) ),
		h( 'button.ag-btn', { onclick: () => openPanel( 'controls' ) }, h( 'span', { text: 'Controls' } ) ),
		h( 'button.ag-btn', { onclick: () => game.setPhotoMode( true ) }, h( 'span', { text: 'Photo mode' } ), h( 'small', { text: 'F' } ) ),
		h( 'button.ag-btn', { onclick: () => game.quitToMenu() }, h( 'span', { text: 'Quit to menu' } ) ) );

	const panels = { settings: settingsPanel, controls: controlsPanel, pause: pausePanel };
	const overlay = h( '.ag-layer.ag-center.off' );
	let openName = null;

	function showPanel( name ) {

		openName = name;
		overlay.replaceChildren( panels[ name ] );
		overlay.classList.remove( 'off' );
		focusFirst( panels[ name ] );

	}

	function openPanel( name ) {

		showPanel( name );

	}

	function closePanel() {

		if ( game.phase === 'paused' && openName !== 'pause' ) return showPanel( 'pause' );
		openName = null;
		overlay.classList.add( 'off' );
		if ( game.phase === 'menu' ) focusFirst( menu );

	}

	// ════════════════════════ HUD ════════════════════════
	const lapNo = h( '.ag-lapno' ), lapTime = h( '.ag-laptime', { text: '0:00.000' } );
	const lastT = h( 'span' ), bestT = h( 'span' ), recordT = h( 'span' );
	const sectorBars = [ h( 'i' ), h( 'i' ), h( 'i' ) ];
	const timing = h( '.ag-timing', {}, lapNo, lapTime,
		h( '.ag-times', {}, h( 'span', { text: 'Last' } ), lastT, h( 'span', { text: 'Best' } ), bestT, h( 'span', { text: 'Record' } ), recordT ),
		h( '.ag-sectors', {}, ...sectorBars ) );

	const deltaValue = h( 'b' ), deltaLabel = h( 'small' ), deltaFill = h( 'i' );
	const delta = h( '.ag-delta', { hidden: '' }, deltaLabel, deltaValue, h( '.ag-deltabar', {}, deltaFill ) );

	const mapCanvas = h( 'canvas', { width: 320, height: 320 } );
	const medalRows = {};
	const medalsBox = h( '.ag-medals' );
	for ( const name of [ 'gold', 'silver', 'bronze' ] ) {

		const time = h( 'b' );
		medalRows[ name ] = { row: h( 'div', { style: `--c:${MEDAL_COLORS[ name ]}` }, h( 'span', { text: LEVELS[ name ] } ), time ), set: field( time ) };
		medalsBox.append( medalRows[ name ].row );

	}

	const map = h( '.ag-map', {}, mapCanvas, medalsBox );

	const gear = h( '.ag-gear', { text: 'N' } ), speed = h( '.ag-speed', { text: '0' } ), unit = h( '.ag-unit', { text: 'km/h' } );
	const rpmFill = h( 'i' ), tc = h( 'span', { text: 'TC' } ), abs = h( 'span', { text: 'ABS' } );
	const cluster = h( '.ag-cluster', {},
		h( '.ag-speedrow', {}, gear, h( 'div', {}, speed, unit ) ),
		h( '.ag-rpm', {}, rpmFill ), h( '.ag-aids', {}, tc, abs ) );

	const throttleFill = h( 'i' ), brakeFill = h( 'i' ), steerMark = h( 'i' );
	const inputs = h( '.ag-inputs', {}, h( '.ag-pedal.brake', {}, brakeFill ), h( '.ag-pedal', {}, throttleFill ), h( '.ag-steer', {}, steerMark ) );
	const hint = h( '.ag-hint', { style: 'opacity:0', html: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive &nbsp;·&nbsp; <kbd>Space</kbd> handbrake &nbsp;·&nbsp; <kbd>C</kbd> camera &nbsp;·&nbsp; <kbd>R</kbd> reset &nbsp;·&nbsp; <kbd>Esc</kbd> pause' } );

	const warn = h( '.ag-warn', { hidden: '' } ), toast = h( '.ag-toast' );
	const cardTitle = h( 'small' ), cardTime = h( 'b' ), cardDelta = h( 'em' ), cardTags = h( 'div' );
	const lapCard = h( '.ag-lapcard', {}, cardTitle, cardTime, cardDelta, cardTags );
	const messages = h( '.ag-msg', {}, warn, lapCard, toast );
	const count = h( '.ag-count' );

	const hud = h( '.ag-layer.ag-hud.off', {}, timing, delta, map, cluster, inputs, hint, messages );
	const photo = h( '.ag-layer.off', {}, h( '.ag-photo', { html: '<kbd>W A S D</kbd>move<kbd>Drag</kbd>look<kbd>Q E</kbd>height<kbd>Wheel</kbd>zoom<kbd>[ ]</kbd>roll<kbd>Shift</kbd>faster<kbd>F / Esc</kbd>exit' } ) );
	root.append( hud, count, menu, overlay, photo );

	// ════════════════════════ the course staff ════════════════════════
	// The ghosts are the staff (see ../game/staff.js): a card names your rival at the start, a tag floats over the ghost
	// car, and typing "61b" lists everybody.
	let rivals = pickRivals();
	const eggTitle = h( 'small' ), eggNames = h( 'b' ), eggList = h( 'i' ), eggRemark = h( 'em' );
	const egg = h( '.ag-egg', {}, eggTitle, eggNames, eggList, eggRemark );
	const ghostTag = h( '.ag-ghosttag', { hidden: '' } );
	root.append( ghostTag, egg );
	let typed = '', eggTimer = 0, tagPoint = null, tagText = '';
	function showStaff( title, names, list, seconds ) {

		eggTitle.textContent = title;
		eggNames.textContent = names;
		eggList.textContent = list;
		eggRemark.textContent = STAFF_REMARKS[ Math.floor( Math.random() * STAFF_REMARKS.length ) ];
		egg.classList.add( 'on' );
		clearTimeout( eggTimer );
		eggTimer = setTimeout( () => egg.classList.remove( 'on' ), seconds * 1000 );

	}

	/** New race: new TAs in the ghosts, and the rival is announced. */
	function announceRival() {

		rivals = pickRivals();
		const mode = settings.get( 'ghost' );
		if ( rivals[ mode ] ) showStaff( 'CS 61B · Project 5 is graded against', rivals[ mode ], mode === 'gold' ? 'Instructor' : LEVELS[ mode ], 6 );

	}

	const onType = ( e ) => {

		typed = ( typed + e.key.toLowerCase() ).slice( - 3 );
		if ( typed !== '61b' ) return;
		typed = '';
		showStaff( 'CS 61B · Course staff', INSTRUCTOR, `Head TAs: ${HEAD_TAS.join( ', ' )}\nTAs: ${TAS.join( ', ' )}`, 12 );

	};

	window.addEventListener( 'keydown', onType );
	disposers.push( () => window.removeEventListener( 'keydown', onType ) );

	const setLapNo = field( lapNo ), setLapTime = field( lapTime ), setLast = field( lastT ), setBest = field( bestT ), setRecord = field( recordT );
	const setGear = field( gear ), setSpeed = field( speed ), setUnit = field( unit ), setDelta = field( deltaValue ), setDeltaLabel = field( deltaLabel );

	// minimap: the static track is drawn once into its own canvas
	const mapContext = mapCanvas.getContext( '2d' );
	const trackLayer = document.createElement( 'canvas' );
	trackLayer.width = trackLayer.height = 320;
	const line = track.polyline( 6 );
	let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;
	for ( let i = 0; i < line.length; i += 2 ) {

		minX = Math.min( minX, line[ i ] ); maxX = Math.max( maxX, line[ i ] );
		minZ = Math.min( minZ, line[ i + 1 ] ); maxZ = Math.max( maxZ, line[ i + 1 ] );

	}

	const mapScale = 284 / Math.max( maxX - minX, maxZ - minZ );
	const mapX = ( x ) => 160 + ( x - ( minX + maxX ) / 2 ) * mapScale, mapY = ( z ) => 160 + ( z - ( minZ + maxZ ) / 2 ) * mapScale;
	{

		const g = trackLayer.getContext( '2d' );
		g.lineJoin = g.lineCap = 'round';
		const path = () => {

			g.beginPath();
			for ( let i = 0; i < line.length; i += 2 ) g[ i ? 'lineTo' : 'moveTo' ]( mapX( line[ i ] ), mapY( line[ i + 1 ] ) );
			g.closePath();

		};

		path();
		g.strokeStyle = 'rgba(8,10,14,.55)';
		g.lineWidth = 9;
		g.stroke();
		path();
		g.strokeStyle = 'rgba(245,247,250,.92)';
		g.lineWidth = 4;
		g.stroke();
		// start line and sector marks
		track.sectors.forEach( ( s, k ) => {

			const p = track.pointAt( s, 0 ), f = track.frameAt( s, {} );
			const nx = f.lx * 7 * ( k ? 0.7 : 1.2 ), nz = f.lz * 7 * ( k ? 0.7 : 1.2 );
			g.beginPath();
			g.moveTo( mapX( p[ 0 ] ) - nx, mapY( p[ 2 ] ) - nz );
			g.lineTo( mapX( p[ 0 ] ) + nx, mapY( p[ 2 ] ) + nz );
			g.strokeStyle = k ? 'rgba(245,247,250,.9)' : '#ff8a4c';
			g.lineWidth = k ? 2 : 4;
			g.stroke();

		} );

	}

	function drawMap( state ) {

		mapContext.clearRect( 0, 0, 320, 320 );
		mapContext.drawImage( trackLayer, 0, 0 );
		if ( state.ghostXZ ) {

			mapContext.fillStyle = MEDAL_HEX[ state.ghostLabel ] ?? '#7dd3fc';
			mapContext.beginPath();
			mapContext.arc( mapX( state.ghostXZ[ 0 ] ), mapY( state.ghostXZ[ 1 ] ), 5.5, 0, 6.283 );
			mapContext.fill();

		}

		const x = mapX( state.carXZ[ 0 ] ), y = mapY( state.carXZ[ 1 ] );
		mapContext.save();
		mapContext.translate( x, y );
		mapContext.rotate( - state.carYaw ); // yaw 0 faces -Z = up on the map
		mapContext.beginPath();
		mapContext.moveTo( 0, - 10 );
		mapContext.lineTo( 6.5, 7 );
		mapContext.lineTo( 0, 3.5 );
		mapContext.lineTo( - 6.5, 7 );
		mapContext.closePath();
		mapContext.fillStyle = '#ff8a4c';
		mapContext.strokeStyle = 'rgba(8,10,14,.8)';
		mapContext.lineWidth = 2;
		mapContext.stroke();
		mapContext.fill();
		mapContext.restore();

	}

	// ════════════════════════ state ════════════════════════
	let hudMode = 'full'; // 'full' | 'minimal' | 'off'
	let phase = '';
	let hintTimer = 0, toastTimer = 0, cardTimer = 0, lastSectorLap = - 1;
	let mapTick = 0;

	function syncMenu() {

		const paint = ctx.systems.car?.paint ?? settings.get( 'paint' );
		for ( const c of swatches.children ) c.classList.toggle( 'on', c.dataset.id === paint );
		const times = ghostTimes();
		const record = ctx.records.get( ctx.sky.wetness > 0.5 ? 'wet' : 'dry' );
		for ( const b of ghostSeg.children ) {

			const id = b.dataset.id;
			b.classList.toggle( 'on', id === settings.get( 'ghost' ) );
			const t = id === 'best' ? record?.time : times?.[ id ]?.time;
			b.lastChild.textContent = id === 'off' ? '—' : t ? formatLapTime( t ) : '—';

		}

		recordLine.innerHTML = record ? `Your record${ctx.sky.wetness > 0.5 ? ' (wet)' : ''}: <b>${formatLapTime( record.time )}</b>` : 'No lap recorded yet. Beat a TA to pass Project 5. Beat Josh Hug for full credit.';

	}

	function focusFirst( scope ) {

		( scope.querySelector( '[data-first]' ) ?? scope.querySelector( 'button' ) )?.focus( { preventScroll: true } );

	}

	function setPhase( next ) {

		const previous = phase;
		phase = next;
		const driving = next === 'drive' || next === 'countdown';
		if ( previous === 'menu' && driving ) announceRival();
		menu.classList.toggle( 'off', next !== 'menu' );
		hud.classList.toggle( 'off', ! driving || hudMode === 'off' );
		photo.classList.toggle( 'off', next !== 'photo' );
		if ( next === 'paused' ) showPanel( 'pause' );
		else {

			openName = null;
			overlay.classList.add( 'off' );

		}

		if ( next === 'menu' ) {

			syncMenu();
			focusFirst( menu );

		} else if ( document.activeElement instanceof HTMLElement && root.contains( document.activeElement ) ) document.activeElement.blur();

		if ( next === 'countdown' || ( next === 'drive' && previous === 'menu' ) ) {

			hintTimer = 9;
			hint.style.opacity = '1';
			for ( const bar of sectorBars ) bar.className = '';
			lapCard.classList.remove( 'on' );

		}

	}

	function showToast( text, seconds = 2.6 ) {

		toast.textContent = text;
		toast.classList.add( 'on' );
		toastTimer = seconds;

	}

	on( 'phase', ( e ) => setPhase( e.to ) );
	on( 'sky:changed', syncMenu );
	on( 'car:paint', syncMenu );
	on( 'settings:change', ( e ) => {

		if ( e.key === 'ghost' ) syncMenu();

	} );
	on( 'countdown', ( { n } ) => {

		count.textContent = n === 0 ? 'GO' : String( n );
		count.classList.toggle( 'go', n === 0 );
		count.classList.remove( 'pop' );
		void count.offsetWidth; // restart the animation
		count.classList.add( 'pop' );

	} );
	on( 'race:lapStart', () => {

		for ( const bar of sectorBars ) bar.className = '';

	} );
	on( 'race:sector', ( e ) => {

		sectorBars[ e.index ].className = e.delta === null || e.delta <= 0 ? 'good' : 'slow';
		if ( e.index < 2 && e.delta !== null ) showToast( `Sector ${e.index + 1}  ${formatDelta( e.delta )}`, 2.2 );
		lastSectorLap = e.index;

	} );
	on( 'race:lapComplete', ( e ) => {

		cardTitle.textContent = e.valid ? `Lap ${e.lap}` : `Lap ${e.lap} · not counted`;
		cardTime.textContent = formatLapTime( e.time );
		if ( e.valid && e.previousRecord !== null ) {

			const d = e.time - e.previousRecord;
			cardDelta.textContent = `${formatDelta( d )} to your record`;
			cardDelta.className = d <= 0 ? 'good' : 'bad';

		} else {

			cardDelta.textContent = e.valid ? 'First timed lap' : 'A checkpoint was missed or the car was reset';
			cardDelta.className = '';

		}

		cardTags.replaceChildren();
		if ( e.isRecord ) cardTags.append( h( 'span.tag', { text: 'New record' } ) );
		if ( e.newMedal ) cardTags.append( document.createTextNode( ' ' ), h( 'span.tag', { text: `${LEVELS[ e.newMedal ]} level`, style: `--c:${MEDAL_COLORS[ e.newMedal ]}` } ) );
		lapCard.classList.add( 'on' );
		cardTimer = e.isRecord || e.newMedal ? 6 : 4;

	} );
	on( 'race:invalidated', ( e ) => showToast( e.reason === 'cut' || e.reason === 'missedCheckpoint' ? 'Lap will not count: corner cut' : 'Lap will not count', 3 ) );
	on( 'notify', ( e ) => showToast( e.text, 3.5 ) );
	on( 'camera:mode', ( e ) => showToast( `Camera: ${CAMERA_NAMES[ e.mode ] ?? e.mode}`, 1.6 ) );

	disposers.push( input.actions.on( 'hud', () => {

		hudMode = hudMode === 'full' ? 'minimal' : hudMode === 'minimal' ? 'off' : 'full';
		hud.classList.toggle( 'off', ! ( phase === 'drive' || phase === 'countdown' ) || hudMode === 'off' );

	} ) );

	// keyboard / gamepad navigation: move focus between the buttons of the layer in front
	let lastClick = 0;
	root.addEventListener( 'click', () => {

		lastClick = performance.now();

	}, true );
	disposers.push( input.actions.on( 'menu', ( { dir } ) => {

		const scope = ! overlay.classList.contains( 'off' ) ? overlay : phase === 'menu' ? menu : null;
		if ( ! scope ) return;
		if ( dir === 'back' ) {

			if ( openName && openName !== 'pause' ) closePanel();
			return;

		}

		const items = [ ...scope.querySelectorAll( 'button, input' ) ].filter( ( b ) => b.offsetParent !== null );
		const active = document.activeElement;
		let index = items.indexOf( active );
		if ( dir === 'confirm' ) {

			// native activation already clicked when a real key was used; this covers the gamepad
			setTimeout( () => {

				if ( performance.now() - lastClick > 120 && items.includes( document.activeElement ) ) document.activeElement.click();

			}, 30 );
			return;

		}

		if ( active instanceof HTMLInputElement && ( dir === 'left' || dir === 'right' ) ) return; // the slider handles it
		if ( index < 0 ) index = 0;
		else index = ( index + ( dir === 'down' || dir === 'right' ? 1 : - 1 ) + items.length ) % items.length;
		items[ index ]?.focus( { preventScroll: true } );

	} ) );

	/** Name tag floating over the ghost car: who you are racing. */
	function updateGhostTag( frame ) {

		const ghost = ( phase === 'drive' || phase === 'countdown' ) && hudMode !== 'off' ? frame.ghost : null;
		let shown = false;
		if ( ghost ) {

			const camera = frame.camera, m = camera.matrixWorld.elements;
			tagPoint ??= ghost.position.clone();
			tagPoint.copy( ghost.position ).sub( camera.position );
			const ahead = - ( tagPoint.x * m[ 8 ] + tagPoint.y * m[ 9 ] + tagPoint.z * m[ 10 ] ); // meters in front of the camera
			if ( ahead > 8 && ahead < 400 ) {

				tagPoint.copy( ghost.position );
				tagPoint.y += 1.7;
				tagPoint.project( camera );
				if ( Math.abs( tagPoint.x ) < 1 && Math.abs( tagPoint.y ) < 1 ) {

					shown = true;
					const key = ghost.label.toLowerCase();
					const text = ! rivals[ key ] ? 'Your best lap' : key === 'gold' ? rivals.gold : `${rivals[ key ]} · ${LEVELS[ key ]}`;
					if ( text !== tagText ) ghostTag.textContent = tagText = text;
					ghostTag.style.left = `${( tagPoint.x * 50 + 50 ).toFixed( 2 )}%`;
					ghostTag.style.top = `${( 50 - tagPoint.y * 50 ).toFixed( 2 )}%`;

				}

			}

		}

		if ( ghostTag.hidden === shown ) ghostTag.hidden = ! shown;

	}

	// ════════════════════════ per frame ════════════════════════
	/** @param {import('../game/context.js').Frame} frame */
	function update( frame ) {

		if ( frame.phase !== phase ) setPhase( frame.phase );
		const dt = Math.min( 0.1, frame.realTime - ( update.last ?? frame.realTime ) );
		update.last = frame.realTime;
		if ( toastTimer > 0 && ( toastTimer -= dt ) <= 0 ) toast.classList.remove( 'on' );
		if ( cardTimer > 0 && ( cardTimer -= dt ) <= 0 ) lapCard.classList.remove( 'on' );
		updateGhostTag( frame );
		if ( phase !== 'drive' && phase !== 'countdown' ) return;
		if ( hintTimer > 0 && ( hintTimer -= dt ) <= 0 ) hint.style.opacity = '0';

		const s = frame.hud, mph = s.units === 'mph';
		setSpeed( String( Math.round( s.speed * ( mph ? MPH_PER_MS : KMH_PER_MS ) ) ) );
		setUnit( mph ? 'mph' : 'km/h' );
		setGear( s.gear === - 1 ? 'R' : s.gear === 0 ? 'N' : String( s.gear ) );
		const rev = clamp( s.rpm / s.redline, 0, 1 );
		rpmFill.style.width = `${( rev * 100 ).toFixed( 1 )}%`;
		gear.classList.toggle( 'shift', rev > 0.955 );
		tc.classList.toggle( 'on', s.tcActive );
		abs.classList.toggle( 'on', s.absActive );

		const minimal = hudMode === 'minimal';
		timing.hidden = minimal;
		map.hidden = minimal || ! settings.get( 'showMinimap' );
		inputs.hidden = minimal || ! settings.get( 'showInputs' );

		setLapNo( s.racePhase === 'lap' ? `Lap ${s.lap}` : s.racePhase === 'outlap' ? 'Rolling start' : 'On the grid' );
		setLapTime( formatLapTime( s.lapTime ) );
		lapTime.classList.toggle( 'invalid', ! s.lapValid && s.racePhase === 'lap' );
		setLast( s.lastLap === null ? '—' : formatLapTime( s.lastLap ) );
		setBest( s.bestLap === null ? '—' : formatLapTime( s.bestLap ) );
		setRecord( s.record === null ? '—' : formatLapTime( s.record ) );
		for ( let i = 0; i < 3; i ++ ) if ( sectorBars[ i ].className === '' || sectorBars[ i ].className === 'now' ) sectorBars[ i ].className = s.racePhase === 'lap' && i === s.sector ? 'now' : '';

		if ( s.delta === null ) delta.hidden = true;
		else {

			delta.hidden = false;
			setDelta( formatDelta( s.delta ) );
			setDeltaLabel( `vs ${rivals[ s.ghostLabel.toLowerCase() ] ?? 'my best'}` );
			delta.classList.toggle( 'ahead', s.delta < 0 );
			delta.classList.toggle( 'behind', s.delta >= 0 );
			const w = clamp( Math.abs( s.delta ) / 3, 0, 1 ) * 50;
			deltaFill.style.width = `${w.toFixed( 1 )}%`;
			deltaFill.style.left = s.delta < 0 ? '50%' : `${( 50 - w ).toFixed( 1 )}%`;
			deltaFill.style.background = s.delta < 0 ? 'var(--good)' : 'var(--bad)';

		}

		medalsBox.hidden = ! s.medals;
		if ( s.medals ) for ( const name of [ 'gold', 'silver', 'bronze' ] ) {

			medalRows[ name ].set( formatLapTime( s.medals[ name ] ) );
			medalRows[ name ].row.classList.toggle( 'earned', s.record !== null && s.record <= s.medals[ name ] );

		}

		const warning = s.wrongWay ? 'Wrong way' : '';
		if ( warn.textContent !== warning ) warn.textContent = warning;
		warn.hidden = warning === '';

		throttleFill.style.height = `${( s.throttle * 100 ).toFixed( 0 )}%`;
		brakeFill.style.height = `${( s.brake * 100 ).toFixed( 0 )}%`;
		steerMark.style.left = `${( 50 + s.steer * 50 ).toFixed( 1 )}%`;

		if ( ! map.hidden && ( mapTick ++ & 1 ) === 0 ) drawMap( s );

	}

	setPhase( game.phase );
	void lastSectorLap;

	return {
		update,
		/** @param {'full'|'minimal'|'off'} mode */
		setHudMode( mode ) {

			hudMode = mode;

		},
		dispose() {

			for ( const off of disposers ) off();
			root.replaceChildren();

		},
	};

}

const MEDAL_HEX = { GOLD: '#f5c542', SILVER: '#cfd6de', BRONZE: '#cf8b53', BEST: '#7dd3fc' };
