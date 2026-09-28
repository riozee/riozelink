/**
 * The four words.
 *
 * A pairing phrase is the only thing a user ever types, and it carries the whole introduction: the
 * words name the room on the relay and they are the secret the proof is derived from. There is no
 * address, no port, and nothing to copy out of a config file.
 *
 * The list is short on purpose. Five hundred plain English words are enough for four words of
 * phrase (about 36 bits), which no stranger could ever walk through before the phrase expires and
 * the attempts run out. Every word is lowercase, three to eight letters, spelled the way it
 * sounds, and free of lookalike characters, because a person may have to read these aloud off a
 * terminal.
 */

export const PHRASES_ARE_WORDS = 4;

const WORDS: readonly string[] = [
	// nature
	'amber', 'aspen', 'autumn', 'basin', 'beach', 'birch', 'bloom', 'breeze',
	'brook', 'cactus', 'canyon', 'cedar', 'cliff', 'cloud', 'clover', 'coast',
	'coral', 'creek', 'dawn', 'delta', 'desert', 'dew', 'dune', 'dusk',
	'ember', 'fern', 'field', 'fjord', 'fog', 'forest', 'frost', 'garden',
	'glacier', 'grove', 'harbor', 'heather', 'hill', 'island', 'jungle', 'lagoon',
	'lake', 'lantern', 'leaf', 'lily', 'lotus', 'maple', 'meadow', 'mist',
	'moon', 'moss', 'mountain', 'ocean', 'orchid', 'pebble', 'pine', 'pond',
	'prairie', 'rain', 'reef', 'ridge', 'river', 'rock', 'sand', 'savanna',
	'sea', 'shore', 'sky', 'snow', 'spring', 'stone', 'storm', 'stream',
	'summit', 'sun', 'surf', 'swamp', 'tide', 'timber', 'valley', 'vine',
	'wave', 'willow', 'wind', 'winter', 'woods',
	// animals
	'badger', 'beetle', 'bison', 'moth', 'camel', 'cheetah', 'cobra', 'condor',
	'crane', 'crow', 'dolphin', 'dove', 'eagle', 'falcon', 'ferret', 'finch',
	'fox', 'gecko', 'goose', 'heron', 'hippo', 'horse', 'iguana', 'jay',
	'koala', 'lemur', 'leopard', 'lion', 'llama', 'lobster', 'lynx', 'magpie',
	'mole', 'moose', 'narwhal', 'newt', 'ocelot', 'octopus', 'osprey', 'otter',
	'owl', 'panda', 'parrot', 'pelican', 'penguin', 'pigeon', 'puma', 'quail',
	'rabbit', 'raven', 'robin', 'salmon', 'seal', 'shark', 'sparrow', 'squid',
	'stork', 'swan', 'tiger', 'toucan', 'trout', 'turtle', 'viper', 'walrus',
	'weasel', 'whale', 'wolf', 'wombat', 'wren', 'zebra',
	// things around a desk and a home
	'anchor', 'anvil', 'arrow', 'axe', 'badge', 'balloon', 'banner', 'barrel',
	'basket', 'bell', 'bench', 'blanket', 'boat', 'bottle', 'box', 'bridge',
	'broom', 'brush', 'bucket', 'button', 'cabin', 'candle', 'canoe', 'canvas',
	'carpet', 'castle', 'chair', 'chalk', 'chimney', 'clock', 'coin', 'compass',
	'copper', 'cradle', 'crown', 'cup', 'cushion', 'dagger', 'desk', 'diamond',
	'door', 'drum', 'engine', 'envelope', 'fabric', 'fence', 'flag', 'flute',
	'frame', 'gate', 'glass', 'glove', 'guitar', 'hammer', 'harp', 'hat',
	'helmet', 'hive', 'hook', 'horn', 'hourglass', 'ink', 'iron', 'jacket',
	'jar', 'journal', 'kettle', 'key', 'kite', 'knot', 'ladder', 'lamp',
	'lens', 'letter', 'lock', 'magnet', 'mask', 'medal', 'mirror', 'needle',
	'net', 'notebook', 'oar', 'oven', 'paddle', 'page', 'paint', 'palette',
	'paper', 'pen', 'pencil', 'pillar', 'pipe', 'piston', 'plate', 'pocket',
	'prism', 'puzzle', 'quilt', 'raft', 'ribbon', 'ring', 'rope', 'rudder',
	'rug', 'sail', 'saw', 'scissors', 'screw', 'shelf', 'ship', 'shovel',
	'sign', 'silk', 'sled', 'spoon', 'stamp', 'statue', 'string', 'sword',
	'table', 'tent', 'thread', 'throne', 'ticket', 'torch', 'tower', 'toy',
	'train', 'trumpet', 'tunnel', 'umbrella', 'vase', 'violin', 'wagon', 'wallet',
	'wheel', 'whistle', 'window', 'wire', 'yarn',
	// colours and manner
	'azure', 'blue', 'bronze', 'brown', 'brave', 'bright', 'brisk', 'calm',
	'cheerful', 'clever', 'cozy', 'crisp', 'curly', 'dainty', 'dapper', 'eager',
	'early', 'elegant', 'fancy', 'fierce', 'fluffy', 'gentle', 'giant', 'glad',
	'glossy', 'golden', 'grand', 'grateful', 'happy', 'hardy', 'hollow', 'honest',
	'humble', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'mellow', 'merry',
	'mighty', 'modest', 'nimble', 'noble', 'patient', 'peaceful', 'playful', 'polite',
	'proud', 'quick', 'quiet', 'rapid', 'rosy', 'royal', 'rustic', 'sandy',
	'shiny', 'silent', 'silver', 'simple', 'sleepy', 'smooth', 'soft', 'solar',
	'solid', 'sparkly', 'steady', 'sturdy', 'sunny', 'swift', 'tender', 'tidy',
	'tiny', 'velvet', 'vivid', 'warm', 'witty', 'young', 'zealous',
	// the kitchen
	'almond', 'apple', 'apricot', 'banana', 'basil', 'berry', 'biscuit', 'bread',
	'butter', 'cherry', 'cocoa', 'cookie', 'cream', 'fig', 'ginger', 'grape',
	'honey', 'lemon', 'lime', 'mango', 'melon', 'mint', 'muffin', 'nutmeg',
	'olive', 'onion', 'orange', 'peach', 'peanut', 'pear', 'pepper', 'plum',
	'potato', 'pumpkin', 'raisin', 'saffron', 'sesame', 'sugar', 'tomato', 'vanilla',
	'walnut', 'wheat',
	// places
	'alley', 'arch', 'attic', 'bakery', 'balcony', 'barn', 'basement', 'bazaar',
	'camp', 'cellar', 'chapel', 'cinema', 'circus', 'city', 'cottage', 'dock',
	'farm', 'ferry', 'fountain', 'gallery', 'garage', 'hamlet', 'hostel', 'hotel',
	'kitchen', 'library', 'lighthouse', 'mansion', 'market', 'mill', 'museum', 'office',
	'orchard', 'palace', 'park', 'pier', 'plaza', 'port', 'quarry', 'ranch',
	'school', 'stable', 'station', 'studio', 'tavern', 'temple', 'theater', 'village',
	'villa', 'workshop',
	// things a person does
	'bake', 'blend', 'build', 'carve', 'catch', 'chase', 'climb', 'cook',
	'dance', 'dream', 'drift', 'explore', 'float', 'fly', 'fold', 'gather',
	'glide', 'grow', 'harvest', 'hike', 'hop', 'hum', 'journey', 'juggle',
	'leap', 'learn', 'listen', 'march', 'measure', 'mend', 'mix', 'navigate',
	'notice', 'ponder', 'pose', 'pour', 'print', 'push', 'read', 'recite',
	'ride', 'roam', 'sew', 'shape', 'shine', 'sing', 'sketch', 'skip',
	'smell', 'soar', 'solve', 'spin', 'splash', 'stack', 'stitch', 'swim',
	'swing', 'taste', 'tell', 'think', 'travel', 'trek', 'wander', 'weave',
	'whisper', 'wrap', 'write'
];

/** Every word a phrase may be built from. Read-only, and duplicated nowhere. */
export const PHRASE_WORDS: readonly string[] = WORDS;

export function isPhraseWord(word: string): boolean {
	return WORDS.includes(word);
}

function pickWord(): string {
	// Rejection sampling keeps every word equally likely; a modulo bias would shrink the phrase
	// space by a hair, which is a silly thing to leave in security math.
	const limit = Math.floor(0x100000000 / WORDS.length) * WORDS.length;
	const buffer = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(buffer);
		if (buffer[0] < limit) return WORDS[buffer[0] % WORDS.length];
	}
}

/** `amber-cobalt-summit-drift` — four words, one dash between each, nothing else. */
export function generatePhrase(wordCount = PHRASES_ARE_WORDS): string {
	const words: string[] = [];
	while (words.length < wordCount) {
		const word = pickWord();
		if (!words.includes(word)) words.push(word);
	}
	return words.join('-');
}

/**
 * Whatever the user typed, in the one spelling the rooms are derived from.
 *
 * People paste with spaces, type with capitals, and occasionally leave a trailing dash. All of
 * that is the same phrase, and it has to hash to the same room on both ends.
 */
export function normalizePhrase(input: string): string {
	return input
		.toLowerCase()
		.replaceAll(/[^a-z]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');
}

export function splitPhrase(phrase: string): string[] {
	const normalized = normalizePhrase(phrase);
	return normalized ? normalized.split('-') : [];
}

/**
 * Three to six words is a phrase a person meant to type. Fewer is a typo, more is a paste
 * accident, and both are worth saying out loud before a WebRTC handshake is attempted.
 */
export function isPhraseShaped(phrase: string): boolean {
	const words = splitPhrase(phrase);
	return words.length >= 3 && words.length <= 6;
}
