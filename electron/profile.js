// A profile that builds itself. Plain statements about the user ("I drive a 2016
// Corolla", "my dog is named Max") are spotted by pattern, with no model involved,
// and become short lines in Memory. A newer fact replaces an older one about the
// same thing, so a new car replaces the old car and nothing is saved twice.

const QUESTION = /^(what|who|whom|whose|where|when|why|how|which|do|does|did|can|could|would|should|will|is|are|am|was|were|have|has|tell|remind|remember)\b/i;
const SAFE = "[A-Za-z0-9][A-Za-z0-9 '&/#+-]{1,38}?"; // lazy: stops at the first place the sentence ends or turns
const NAME = '[A-Z][a-z]{1,19}(?: [A-Z][a-z]{1,19})?';
const RELATIONS = { wife: 'Wife', husband: 'Husband', girlfriend: 'Partner', boyfriend: 'Partner', partner: 'Partner', fiancee: 'Partner', fiance: 'Partner', son: 'Son', daughter: 'Daughter', dog: 'Dog', cat: 'Cat', brother: 'Brother', sister: 'Sister', mom: 'Mom', dad: 'Dad' };
// Only one of these at a time: a new answer replaces the old one. The rest add up.
const SINGLE = new Set(['Car', 'Name', 'Lives in', 'Works at', 'Job', 'Birthday', 'Wife', 'Husband', 'Partner', 'Mom', 'Dad', 'Children', 'Kids', 'Dogs', 'Cats', 'Pets']);

// "I have three kids", "I'm a dad of 2"
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNT = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})';
const countOf = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[String(w).toLowerCase()]);
const GROUP = { kids: 'Children', children: 'Children', child: 'Children', dogs: 'Dogs', dog: 'Dogs', cats: 'Cats', cat: 'Cats', pets: 'Pets', pet: 'Pets' };
// Kids' names: "Mia, Leo and Sam"
const NAMES = `${NAME}(?:\\s*(?:,|&|\\band\\b)\\s*(?:and\\s+)?${NAME})*`;
const splitNames = (s) => s.split(/\s*(?:,|&|\band\b)\s*/).map((x) => x.trim()).filter(Boolean);

// Capitalised words that follow "my son is" but are feelings or places, not names.
const NOT_NAMES = new Set('tired sick sad happy angry home here fine good great bad ill late sleeping working busy hungry bored not very so'.split(' '));

const clean = (s) => s.replace(/\s+/g, ' ').replace(/[\s.,!;]+$/, '').trim();

// Returns [{ label, value }] for each plain statement in the text.
function extract(text) {
  const facts = [];
  const add = (label, value) => {
    value = clean(value || '');
    if (value.length >= 1 && value.length <= (label === 'Note' || label === 'Preference' ? 160 : label === 'Kids' ? 80 : 40)) facts.push({ label, value });
  };
  // Questions are not facts: look at one sentence at a time.
  const sentences = String(text || '').slice(0, 1500).split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/\?\s*$/.test(sentence) || QUESTION.test(sentence)) continue;
    let m;
    // How the user wants Ilyra to behave: "stop telling me what you are", "never use emojis", "always keep it short".
    if ((m = /^(?:(?:also|and|please|okay|ok|so|but)[,\s]+)*((?:stop|quit|don't|do not|never|always|from now on|no more)\b[^.!?\n]{8,150})/i.exec(sentence)) && !/^(?:never mind|don't worry|do not worry|stop it|stop that|don't know|do not know)\b/i.test(m[1])) add('Preference', m[1].replace(/^./, (c) => c.toLowerCase()));
    else if (!ASKED.test(sentence) && (m = /\bi (?:don't|do not) want (?:you to )?([^.!?\n]{6,140})/i.exec(sentence))) add('Preference', "don't " + m[1].replace(/^to /, ''));
    else if (!ASKED.test(sentence) && (m = /\bi (?:want|prefer|need) you to ([^.!?\n]{6,140})/i.exec(sentence))) add('Preference', m[1]);
    if ((m = new RegExp(`\\b[Mm]y name is (${NAME})`).exec(sentence)) || (m = new RegExp(`\\b(?:i am|i'm) called (${NAME})`).exec(sentence))) add('Name', m[1]);
    if ((m = new RegExp(`\\bi (?:drive|own) (?:a|an|the) (${SAFE})(?=\\s+(?:and|but|because|so|to)\\b|[.,!;]|$)`, 'i').exec(sentence))) add('Car', m[1]);
    else if ((m = new RegExp(`\\bi (?:have|got|bought|just bought) (?:a|an|the|my) (${SAFE} (?:car|truck|suv|van|sedan|motorcycle|minivan|pickup))\\b`, 'i').exec(sentence))) add('Car', m[1]);
    if ((m = /\b[Ii] (?:live|reside|stay) in ([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,2}(?:, [A-Z][A-Za-z.]*(?: [A-Z][A-Za-z.]*)?)?)/.exec(sentence))) add('Lives in', m[1]);
    if ((m = new RegExp(`\\bi work (?:at|for) (${SAFE})(?=\\s+(?:as|and|but|because|so)\\b|[.,!;]|$)`, 'i').exec(sentence))) add('Works at', m[1]);
    if ((m = new RegExp(`\\bi work as (?:a|an|the)? ?(${SAFE})(?=\\s+(?:at|for|and|but|because|so)\\b|[.,!;]|$)`, 'i').exec(sentence))) add('Job', m[1]);
    // "I am a sales rep for Gordon Food Service": a job at a named place.
    if ((m = new RegExp(`\\bi(?:'m| am) (?:a|an) (?!(?:bit|little|lot|big|huge|fan|bit of)\\b)(${SAFE}) (?:for|at|with) ([A-Z][A-Za-z0-9&'.-]*(?: [A-Z&][A-Za-z0-9&'.-]*){0,4})`, 'i').exec(sentence))) { add('Job', m[1]); add('Works at', m[2]); }
    // How many children, dogs or cats; and the kids' names.
    let counted = false;
    // "I have 2 dogs and 3 kids": every count in the sentence.
    const haveSome = new RegExp(`(?:\\b[Ii] (?:have|got|'ve got)|\\band|,) ${COUNT} (kids|children|child|dogs?|cats?|pets?)\\b`, 'g');
    const own = /\b[Ii] (?:have|got|'ve got)\b/.exec(sentence);
    for (const c of own ? sentence.slice(own.index).matchAll(haveSome) : []) {
      const n = countOf(c[1]);
      const group = GROUP[c[2].toLowerCase().replace(/(?<=dog|cat|pet)s$/, '')] || GROUP[c[2].toLowerCase()];
      if (n && group) { add(group, String(n)); if (group === 'Children') counted = true; }
    }
    if ((m = new RegExp(`\\b[Ii](?:'m| am) (?:a |the )?(?:dad|father|mom|mum|mother|parent) (?:of|to) ${COUNT}\\b`).exec(sentence))) {
      const n = countOf(m[1]);
      if (n) { add('Children', String(n)); counted = true; }
    }
    const kids = new RegExp(`\\b(?:[Mm]y (?:kids|children|sons|daughters)(?:'? names)?(?: are| is)?(?: named| called)?|[Kk]ids|[Cc]hildren)\\s*(?:[:,-]|are named|are called|named|called|are)\\s*(${NAMES})`).exec(sentence);
    if (kids) {
      const names = splitNames(kids[1]).filter((x) => !NOT_NAMES.has(x.toLowerCase()));
      if (names.length) {
        add('Kids', names.join(', '));
        if (!counted && names.length > 1) add('Children', String(names.length));
      }
    }
    const rel = new RegExp(`\\b[Mm]y (${Object.keys(RELATIONS).join('|')})(?:'s name is| is named| is called| named| called|'s| is) (${NAME})\\b`).exec(sentence);
    const direct = rel ? null : new RegExp(`\\b[Mm]y (${Object.keys(RELATIONS).join('|')}) (${NAME})(?= is\\b|[.,!;]|$)`).exec(sentence);
    const hit = rel || direct;
    if (hit && !NOT_NAMES.has(hit[2].toLowerCase())) add(RELATIONS[hit[1].toLowerCase()], hit[2]);
    if ((m = new RegExp(`\\bi(?:'m| am) allergic to (${SAFE})(?=\\s+(?:and|but|because|so)\\b|[.,!;]|$)`, 'i').exec(sentence))) add('Allergic to', m[1]);
    if ((m = /\bmy birthday is (?:on )?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i.exec(sentence))) add('Birthday', m[1]);
  }
  // The same thing said twice in one message counts once.
  return facts.filter((f, i) => facts.findIndex((g) => g.label === f.label && g.value.toLowerCase() === f.value.toLowerCase()) === i);
}

const line = (f) => `- ${f.label}: ${f.value}`;

// Memory text with the facts folded in. `added` lists what actually changed.
function apply(memory, facts, max = 6000) {
  let lines = String(memory || '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const added = [];
  for (const f of facts) {
    const mine = (l) => l.toLowerCase().startsWith(`- ${f.label.toLowerCase()}:`);
    const existing = lines.filter(mine);
    if (existing.some((l) => l.slice(l.indexOf(':') + 1).trim().toLowerCase() === f.value.toLowerCase())) continue;
    const next = SINGLE.has(f.label) ? lines.filter((l) => !mine(l)) : lines.slice();
    next.push(line(f));
    // Never cut memory off silently: if it won't fit, skip the fact.
    if (next.join('\n').length + 1 > max) continue;
    lines = next;
    added.push(f);
  }
  return { text: lines.length ? lines.join('\n') + '\n' : '', added };
}

// "Add this to your memory", "remember that…": the user asked for it to be kept.
const ASKED = /\b(add (?:this |that |it )?to (?:your |my )?memory|to your memory|for your memory|remember (?:that|this)|keep in mind|make a note|note that|don't forget)\b/i;
function askedToRemember(text) {
  // "Can you remember that…" is a polite request, not a question about memory.
  const t = String(text || '').trim().replace(/^(?:please )?(?:can|could|would|will) you (?:please )?(?=remember|add|keep|make a note|note|not forget)/i, '');
  // "Did you add that to your memory?" is a question about memory, not a request.
  return ASKED.test(t) && !/[?/]\s*$/.test(t) && !/^(what|who|where|when|why|how|which|do|does|did|can|could|would|should|will|is|are|am|was|were|have|has)\b/i.test(t);
}

// When the user asks Ilyra to remember something that isn't a known kind of fact,
// keep their own words as a note so the request is never silently dropped.
function note(text) {
  // "...stop doing that. Please save that to your memory because I'm tired of it": the thing to keep is what came
  // before the request (or the first sentences), not the request itself or its "because" tail.
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const keep = sentences.filter((s) => !ASKED.test(s) && !/\?\s*$/.test(s) && !/^(?:wrong|no|ok|okay|yes|thanks?)[.!]*$/i.test(s));
  if (keep.length && keep.length < sentences.length) {
    const value = keep.join(' ').replace(/[.!\s]+$/, '').slice(0, 160);
    if (value.length >= 8) return { label: 'Note', value };
  }
  const said = String(text || '').replace(/\s+/g, ' ').trim()
    .replace(/^.*?\b(?:add (?:this |that |it )?to (?:your |my )?memory(?: of me)?|to your memory(?: of me)?|for your memory|remember (?:that|this)|keep in mind(?: that)?|make a note(?: that)?|note that|don't forget(?: that)?)\b[\s,:-]*/i, '')
    .replace(/[.!\s]+$/, '');
  return said.length >= 3 ? { label: 'Note', value: said.slice(0, 160) } : null;
}

module.exports = { extract, apply, line, askedToRemember, note, SINGLE };
