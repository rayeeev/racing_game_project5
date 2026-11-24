// The joke: this game is "Project 5" of CS 61B, and the rival ghosts are the course staff.
//   gold ghost   = the instructor
//   silver ghost = one of the Head TAs (a different one each race)
//   bronze ghost = one of the TAs (a different one each race)
// Typing "61b" anywhere shows the whole staff. Names as listed on https://fa26.datastructur.es/staff/ (Fall 2026,
// read 2026-11-23) - edit freely.

export const INSTRUCTOR = 'Josh Hug';

/** @type {string[]} */
export const HEAD_TAS = [ 'Amy Wang', 'Marcus Koh', 'Michelle Koga' ];

/** @type {string[]} */
export const TAS = [
	'Alon Shakevsky', 'Avik Gautam', 'Benjamin Yi', 'Dawn Schumacher', 'Esha Potharaju', 'Isabel Dong', 'Lilah Durney',
	'Rushil Saraf', 'Samuel Hudson', 'Sarveshan Saravanan', 'Selina Fang',
];

/** What the three medal levels are called in the interface. */
export const LEVELS = { gold: INSTRUCTOR, silver: 'Head TA', bronze: 'TA' };

const pick = ( list ) => list[ Math.floor( Math.random() * list.length ) ];

/** Who drives each ghost this race. */
export function pickRivals() {

	return { gold: INSTRUCTOR, silver: pick( HEAD_TAS ) ?? 'Head TA', bronze: pick( TAS ) ?? 'TA' };

}

/** Lines the autograder may add (one is picked at random). */
export const STAFF_REMARKS = [
	'Regrade requests for lap times will not be accepted.',
	'Office hours are held at the hairpin. Bring your own guard rail.',
	'The autograder timed out. Your lap did not.',
	'Style check failed: racing line exceeds 80 characters.',
	'Reminder: the ghost car is not a valid collaboration partner.',
	'Runtime must be O(1) lap. You are currently O(n) corners behind.',
];
