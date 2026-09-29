/**
 * The pairing code: four words, then four Crockford characters.
 *
 * A code is the only thing a user ever types, and it carries the whole introduction. It names the
 * room on the relay and it is the secret the proof is derived from. There is no address, no port,
 * and nothing to copy out of a config file.
 *
 * Four words out of this list are about 36 bits, and the tail adds 20 more, so a code is about 56
 * bits. That is what makes the room name safe to publish. The room is stretched out of the code
 * with PBKDF2 rather than hashed from it, so a relay that reads the room name still
 * cannot walk the code space at hash speed.
 *
 * The list is short on purpose. Every word is lowercase, spelled the way it sounds, and free of
 * lookalike characters, because a person may have to read these off a terminal.
 */

/** How many words a generated code starts with. The tail is not counted here. */
export const PHRASES_ARE_WORDS = 4;

/**
 * The characters that ride after the words.
 *
 * Crockford's Base32 alphabet: the digits and the uppercase letters with `I`, `L`, `O` and `U`
 * taken out. The omissions are the point. `O` beside `0` and `I` beside `1` are the mistakes a
 * person actually makes reading a code off a screen, and neither can be produced here.
 */
export const PHRASE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How many of them a code carries. Four characters is 20 bits for four keystrokes. */
export const PHRASE_CODE_LENGTH = 4;

const WORDS: readonly string[] = [
	// nature
	'amber',
	'aspen',
	'autumn',
	'basin',
	'beach',
	'birch',
	'bloom',
	'breeze',
	'brook',
	'cactus',
	'canyon',
	'cedar',
	'cliff',
	'cloud',
	'clover',
	'coast',
	'coral',
	'creek',
	'dawn',
	'delta',
	'desert',
	'dew',
	'dune',
	'dusk',
	'ember',
	'fern',
	'field',
	'fjord',
	'fog',
	'forest',
	'frost',
	'garden',
	'glacier',
	'grove',
	'harbor',
	'heather',
	'hill',
	'island',
	'jungle',
	'lagoon',
	'lake',
	'lantern',
	'leaf',
	'lily',
	'lotus',
	'maple',
	'meadow',
	'mist',
	'moon',
	'moss',
	'mountain',
	'ocean',
	'orchid',
	'pebble',
	'pine',
	'pond',
	'prairie',
	'rain',
	'reef',
	'ridge',
	'river',
	'rock',
	'sand',
	'savanna',
	'sea',
	'shore',
	'sky',
	'snow',
	'spring',
	'stone',
	'storm',
	'stream',
	'summit',
	'sun',
	'surf',
	'swamp',
	'tide',
	'timber',
	'valley',
	'vine',
	'wave',
	'willow',
	'wind',
	'winter',
	'woods',
	// animals
	'badger',
	'beetle',
	'bison',
	'moth',
	'camel',
	'cheetah',
	'cobra',
	'condor',
	'crane',
	'crow',
	'dolphin',
	'dove',
	'eagle',
	'falcon',
	'ferret',
	'finch',
	'fox',
	'gecko',
	'goose',
	'heron',
	'hippo',
	'horse',
	'iguana',
	'jay',
	'koala',
	'lemur',
	'leopard',
	'lion',
	'llama',
	'lobster',
	'lynx',
	'magpie',
	'mole',
	'moose',
	'narwhal',
	'newt',
	'ocelot',
	'octopus',
	'osprey',
	'otter',
	'owl',
	'panda',
	'parrot',
	'pelican',
	'penguin',
	'pigeon',
	'puma',
	'quail',
	'rabbit',
	'raven',
	'robin',
	'salmon',
	'seal',
	'shark',
	'sparrow',
	'squid',
	'stork',
	'swan',
	'tiger',
	'toucan',
	'trout',
	'turtle',
	'viper',
	'walrus',
	'weasel',
	'whale',
	'wolf',
	'wombat',
	'wren',
	'zebra',
	// things around a desk and a home
	'anchor',
	'anvil',
	'arrow',
	'axe',
	'badge',
	'balloon',
	'banner',
	'barrel',
	'basket',
	'bell',
	'bench',
	'blanket',
	'boat',
	'bottle',
	'box',
	'bridge',
	'broom',
	'brush',
	'bucket',
	'button',
	'cabin',
	'candle',
	'canoe',
	'canvas',
	'carpet',
	'castle',
	'chair',
	'chalk',
	'chimney',
	'clock',
	'coin',
	'compass',
	'copper',
	'cradle',
	'crown',
	'cup',
	'cushion',
	'dagger',
	'desk',
	'diamond',
	'door',
	'drum',
	'engine',
	'envelope',
	'fabric',
	'fence',
	'flag',
	'flute',
	'frame',
	'gate',
	'glass',
	'glove',
	'guitar',
	'hammer',
	'harp',
	'hat',
	'helmet',
	'hive',
	'hook',
	'horn',
	'hourglass',
	'ink',
	'iron',
	'jacket',
	'jar',
	'journal',
	'kettle',
	'key',
	'kite',
	'knot',
	'ladder',
	'lamp',
	'lens',
	'letter',
	'lock',
	'magnet',
	'mask',
	'medal',
	'mirror',
	'needle',
	'net',
	'notebook',
	'oar',
	'oven',
	'paddle',
	'page',
	'paint',
	'palette',
	'paper',
	'pen',
	'pencil',
	'pillar',
	'pipe',
	'piston',
	'plate',
	'pocket',
	'prism',
	'puzzle',
	'quilt',
	'raft',
	'ribbon',
	'ring',
	'rope',
	'rudder',
	'rug',
	'sail',
	'saw',
	'scissors',
	'screw',
	'shelf',
	'ship',
	'shovel',
	'sign',
	'silk',
	'sled',
	'spoon',
	'stamp',
	'statue',
	'string',
	'sword',
	'table',
	'tent',
	'thread',
	'throne',
	'ticket',
	'torch',
	'tower',
	'toy',
	'train',
	'trumpet',
	'tunnel',
	'umbrella',
	'vase',
	'violin',
	'wagon',
	'wallet',
	'wheel',
	'whistle',
	'window',
	'wire',
	'yarn',
	// colours and manner
	'azure',
	'blue',
	'bronze',
	'brown',
	'brave',
	'bright',
	'brisk',
	'calm',
	'cheerful',
	'clever',
	'cozy',
	'crisp',
	'curly',
	'dainty',
	'dapper',
	'eager',
	'early',
	'elegant',
	'fancy',
	'fierce',
	'fluffy',
	'gentle',
	'giant',
	'glad',
	'glossy',
	'golden',
	'grand',
	'grateful',
	'happy',
	'hardy',
	'hollow',
	'honest',
	'humble',
	'jolly',
	'keen',
	'kind',
	'lively',
	'lucky',
	'mellow',
	'merry',
	'mighty',
	'modest',
	'nimble',
	'noble',
	'patient',
	'peaceful',
	'playful',
	'polite',
	'proud',
	'quick',
	'quiet',
	'rapid',
	'rosy',
	'royal',
	'rustic',
	'sandy',
	'shiny',
	'silent',
	'silver',
	'simple',
	'sleepy',
	'smooth',
	'soft',
	'solar',
	'solid',
	'sparkly',
	'steady',
	'sturdy',
	'sunny',
	'swift',
	'tender',
	'tidy',
	'tiny',
	'velvet',
	'vivid',
	'warm',
	'witty',
	'young',
	'zealous',
	// the kitchen
	'almond',
	'apple',
	'apricot',
	'banana',
	'basil',
	'berry',
	'biscuit',
	'bread',
	'butter',
	'cherry',
	'cocoa',
	'cookie',
	'cream',
	'fig',
	'ginger',
	'grape',
	'honey',
	'lemon',
	'lime',
	'mango',
	'melon',
	'mint',
	'muffin',
	'nutmeg',
	'olive',
	'onion',
	'orange',
	'peach',
	'peanut',
	'pear',
	'pepper',
	'plum',
	'potato',
	'pumpkin',
	'raisin',
	'saffron',
	'sesame',
	'sugar',
	'tomato',
	'vanilla',
	'walnut',
	'wheat',
	// places
	'alley',
	'arch',
	'attic',
	'bakery',
	'balcony',
	'barn',
	'basement',
	'bazaar',
	'camp',
	'cellar',
	'chapel',
	'cinema',
	'circus',
	'city',
	'cottage',
	'dock',
	'farm',
	'ferry',
	'fountain',
	'gallery',
	'garage',
	'hamlet',
	'hostel',
	'hotel',
	'kitchen',
	'library',
	'lighthouse',
	'mansion',
	'market',
	'mill',
	'museum',
	'office',
	'orchard',
	'palace',
	'park',
	'pier',
	'plaza',
	'port',
	'quarry',
	'ranch',
	'school',
	'stable',
	'station',
	'studio',
	'tavern',
	'temple',
	'theater',
	'village',
	'villa',
	'workshop',
	// things a person does
	'bake',
	'blend',
	'build',
	'carve',
	'catch',
	'chase',
	'climb',
	'cook',
	'dance',
	'dream',
	'drift',
	'explore',
	'float',
	'fly',
	'fold',
	'gather',
	'glide',
	'grow',
	'harvest',
	'hike',
	'hop',
	'hum',
	'journey',
	'juggle',
	'leap',
	'learn',
	'listen',
	'march',
	'measure',
	'mend',
	'mix',
	'navigate',
	'notice',
	'ponder',
	'pose',
	'pour',
	'print',
	'push',
	'read',
	'recite',
	'ride',
	'roam',
	'sew',
	'shape',
	'shine',
	'sing',
	'sketch',
	'skip',
	'smell',
	'soar',
	'solve',
	'spin',
	'splash',
	'stack',
	'stitch',
	'swim',
	'swing',
	'taste',
	'tell',
	'think',
	'travel',
	'trek',
	'wander',
	'weave',
	'whisper',
	'wrap',
	'write'
];

/** Every word a code may be built from. Read-only, and duplicated nowhere. */
export const PHRASE_WORDS: readonly string[] = WORDS;

export function isPhraseWord(word: string): boolean {
	return WORDS.includes(word);
}

function pickWord(): string {
	// Rejection sampling keeps every word equally likely; a modulo bias would shrink the code
	// space by a hair, which is a silly thing to leave in security math.
	const limit = Math.floor(0x100000000 / WORDS.length) * WORDS.length;
	const buffer = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(buffer);
		if (buffer[0] < limit) return WORDS[buffer[0] % WORDS.length];
	}
}

/** The same rejection sampling, over the 32 symbol tail alphabet. */
function pickCode(): string {
	const size = PHRASE_CODE_ALPHABET.length;
	const limit = Math.floor(0x100000000 / size) * size;
	const buffer = new Uint32Array(1);
	let code = '';
	while (code.length < PHRASE_CODE_LENGTH) {
		crypto.getRandomValues(buffer);
		if (buffer[0] >= limit) continue;
		code += PHRASE_CODE_ALPHABET[buffer[0] % size];
	}
	return code;
}

/**
 * `amber-cobalt-summit-drift-4G2X` — four words, then four characters, one dash between each.
 *
 * The dashes are a canonical spelling rather than part of the secret: {@link normalizePhrase}
 * accepts spaces, capitals and any other punctuation and folds them all onto this shape.
 */
export function generatePhrase(wordCount = PHRASES_ARE_WORDS): string {
	const words: string[] = [];
	while (words.length < wordCount) {
		const word = pickWord();
		if (!words.includes(word)) words.push(word);
	}
	return [...words, pickCode()].join('-');
}

/**
 * Whatever the user typed, in the one spelling the rooms are derived from.
 *
 * People paste with spaces, type with capitals, and occasionally leave a trailing dash. Digits are
 * kept, because the tail needs them. All of that lands on the same phrase, and it has to derive the
 * same room and the same proof on both ends.
 */
export function normalizePhrase(input: string): string {
	return input
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');
}

export function splitPhrase(phrase: string): string[] {
	const normalized = normalizePhrase(phrase);
	return normalized ? normalized.split('-') : [];
}

/** True when `tail` is exactly one code's worth of the tail alphabet. */
function isCodeShaped(tail: string): boolean {
	if (tail.length !== PHRASE_CODE_LENGTH) return false;
	return [...tail].every((character) => PHRASE_CODE_ALPHABET.includes(character.toUpperCase()));
}

/**
 * Three to six words with a code tail is what a person meant to type. Fewer words is a typo, more is
 * a paste accident, and a missing tail is the part people drop, so all three are worth saying out
 * loud before a WebRTC handshake is attempted.
 */
export function isPhraseShaped(phrase: string): boolean {
	const parts = splitPhrase(phrase);
	if (parts.length < 2) return false;
	const words = parts.slice(0, -1);
	return words.length >= 3 && words.length <= 6 && isCodeShaped(parts[parts.length - 1]);
}

/**
 * The code the way a terminal shows it: uppercase, spaces instead of dashes.
 *
 * Spaces are safe here because {@link normalizePhrase} turns any run of punctuation back into a
 * single dash, so what a person reads off the screen and types derives exactly the same room and
 * the same proof as the phrase the daemon generated.
 */
export function displayPhrase(phrase: string): string {
	return splitPhrase(phrase).join(' ').toUpperCase();
}
