// No lectures. Models pad answers with boilerplate ("I'm not a medical professional...", "consult a
// doctor", "As an AI..."), and a rule in the prompt does not reliably stop them. So Ilyra also removes those
// sentences from what is shown, a sentence at a time as the answer streams in. Real safety advice that says
// what to do ("call 911", "seek emergency care") is left alone, and so is plainly saying who Ilyra is when asked.

// Sentences that are only boilerplate about what the assistant is or is not, or generic "ask a professional".
const NATURE = [
  /\b(?:i'?m|i am) (?:just |only |really )?(?:not|no) (?:an? )?(?:[\w-]+ ){0,4}(?:doctor|physician|nurse|lawyer|attorney|professional|expert|therapist|advis[eo]r|specialist)\b/i,
  /\b(?:i'?m|i am) (?:just|only) (?:an? )?(?:ai|assistant|chatbot|language model|virtual assistant|text-based)/i,
  /\b(?:i'?m|i am) an? (?:text-based|virtual) /i,
  /\bas an? (?:ai|artificial intelligence|language model|assistant|chatbot)\b/i,
  /\bi (?:don'?t|do not|can'?t|cannot) (?:have )?(?:direct |personal |real-time )?(?:access to|browse|experience|opinions|feelings)\b/i,
  /\b(?:this|that|it) is not (?:a substitute for|intended as|medical advice|legal advice|financial advice)/i,
  /\bnot a substitute for (?:professional|medical|legal|financial)/i
];
const ASK_A_PRO = /\b(?:consult(?:ing)?|see(?:ing)?|speak(?:ing)? (?:to|with)|talk(?:ing)? to|check(?:ing)? with|contact(?:ing)?|ask(?:ing)?|visit(?:ing)?) (?:with )?(?:a|an|your|the) (?:doctor|physician|gp|healthcare (?:professional|provider)|health care (?:professional|provider)|medical (?:professional|provider)|qualified (?:\w+ )?(?:professional|expert)|licensed (?:\w+ )?(?:professional|expert)|lawyer|attorney|financial advis[eo]r|therapist|professional)\b/i;
// What to do in an emergency is never boilerplate.
const URGENT = /\b(?:911|emergency|urgent|immediately|right away|call (?:a |your )?(?:doctor|ambulance)|seek (?:immediate |urgent )?(?:medical )?(?:care|attention|help))\b/i;
// Said when someone asks who or what Ilyra is.
const ASKS_IDENTITY = /\b(?:who|what)(?:'s| is| are| r)? (?:you|u|your name)\b|\byour name\b|\bwhat should i call you\b|\bintroduce yourself\b|\btell me about yourself\b/i;

function isBoilerplate(sentence, { allowIdentity = false } = {}) {
  const s = sentence.replace(/^[\s*\-•>#]+/, '').trim();
  if (s.length < 8) return false;
  if (URGENT.test(s)) return false;
  if (!allowIdentity && NATURE.some((re) => re.test(s))) return true;
  // Keeps "I'm not a doctor" gone even when asked who Ilyra is: that is a disclaimer, not an identity.
  if (allowIdentity && NATURE[0].test(s)) return true;
  return ASK_A_PRO.test(s);
}

// A sentence at a time, as it arrives. emit(text) shows what is kept.
function createToneFilter(emit, options = {}) {
  let buffer = '';
  let raw = '';
  let shown = '';
  const unit = (text) => {
    if (isBoilerplate(text, options)) return;
    const out = shown ? text : text.replace(/^\s+/, ''); // a dropped first sentence leaves no gap at the start
    if (!out) return;
    shown += out;
    emit(out);
  };
  return {
    push(chunk) {
      raw += chunk;
      buffer += chunk;
      const boundary = /[.!?]+(?=\s)|\n/g;
      let last = 0;
      let m;
      while ((m = boundary.exec(buffer))) {
        const end = m.index + m[0].length;
        unit(buffer.slice(last, end));
        last = end;
      }
      buffer = buffer.slice(last);
    },
    flush() {
      if (buffer) unit(buffer);
      buffer = '';
      // If everything was boilerplate, show it rather than nothing.
      if (!shown.trim() && raw.trim()) { shown = raw; emit(raw); }
    },
    result() { return shown.replace(/\n{3,}/g, '\n\n').trim(); }
  };
}

// The same filter over a finished text.
function stripBoilerplate(text, options) {
  let out = '';
  const f = createToneFilter((t) => { out += t; }, options);
  f.push(String(text || ''));
  f.flush();
  return f.result();
}

module.exports = { createToneFilter, stripBoilerplate, isBoilerplate, ASKS_IDENTITY };
