// The notes editor: headings, bullets and tick-boxes that you type the way you would in any notes
// app ("- " starts a bullet, "[] " a tick-box, "# " a heading), shown as what they are.
//
// What is kept is still plain text, one line per block, exactly as before:
//     Decisions            a heading
//     - Price is 40        a bullet
//     - [ ] Send contract  a tick-box   (- [x] when ticked)
// so notes stay readable anywhere, sync the way they always did, and the rest of the app (making
// tasks from action points, the AI layout) reads them without knowing this editor exists.
//
// attach(textarea) puts the editor in place of a textarea and keeps the textarea as the one source of
// truth: reading or setting textarea.value, and its "input" and "change" events, work as they always did.

const SECTIONS = /^(Summary|Decisions|Action points|Waiting on others|Open questions|Also noted)$/;
const MARK = /^—\s.+\s—$/; // a dividing line such as "— Your notes —"

// One line of text -> what kind of block it is, the text shown, and what is put back in front when saved.
function read(line) {
  let m;
  if ((m = /^(\s*[-*•]\s*\[( |x|X)?\]\s+)(.*)$/.exec(line)) || (m = /^(\[( |x|X)?\]\s+)(.*)$/.exec(line))) return { kind: 'todo', done: /x/i.test(m[2] || ''), text: m[3] };
  if ((m = /^(\s*[-*•]\s+)(.*)$/.exec(line))) return { kind: 'li', pre: m[1], text: m[2] };
  if ((m = /^(#{1,3}\s+)(.*)$/.exec(line))) return { kind: 'h', pre: m[1], text: m[2] };
  if (SECTIONS.test(line.trim())) return { kind: 'sec', text: line };
  if (MARK.test(line.trim())) return { kind: 'mark', text: line };
  if (/^Next:\s/.test(line)) return { kind: 'next', text: line };
  return { kind: 'p', text: line };
}
function block(doc, { kind = 'p', text = '', pre = '', done = false }) {
  const el = doc.createElement('div');
  el.className = `b ${kind}`;
  if (pre) el.dataset.pre = pre;
  if (kind === 'todo' && done) el.dataset.done = '1';
  if (text) el.textContent = text; else el.append(doc.createElement('br'));
  return el;
}
const textOf = el => el.textContent.replace(/ /g, ' ').replace(/\n/g, ' ');
const kindOf = el => (el.classList ? ['todo', 'li', 'h', 'sec', 'mark', 'next'].find(k => el.classList.contains(k)) || 'p' : 'p');
function write(el) {
  if (el.nodeType === 3) return el.nodeValue.replace(/ /g, ' ');
  if (el.nodeName === 'BR') return '';
  const kind = kindOf(el), text = textOf(el);
  if (kind === 'todo') return `- [${el.dataset.done ? 'x' : ' '}] ${text}`;
  if (kind === 'li') return `${el.dataset.pre || '- '}${text}`;
  if (kind === 'h') return `${el.dataset.pre || '# '}${text}`;
  return text;
}

export function attach(area) {
  const doc = area.ownerDocument, ed = doc.createElement('div');
  ed.className = 'ed';
  ed.contentEditable = 'true';
  ed.spellcheck = true;
  ed.setAttribute('role', 'textbox');
  ed.setAttribute('aria-multiline', 'true');
  ed.setAttribute('aria-label', area.getAttribute('aria-label') || area.closest('label')?.querySelector('span')?.textContent || 'Notes');
  ed.dataset.placeholder = area.placeholder || '';
  area.classList.add('edsrc');
  area.after(ed);

  const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const blank = () => ed.classList.toggle('blank', ed.children.length <= 1 && !ed.textContent);
  const show = text => { ed.replaceChildren(...String(text).split('\n').map(line => block(doc, read(line)))); blank(); };
  const save = () => [...ed.childNodes].map(write).join('\n');
  // what was typed goes into the textarea, and the textarea says so, as if it had been typed there
  const tell = () => { native.set.call(area, save()); blank(); area.dispatchEvent(new Event('input', { bubbles: true })); };

  // the textarea still answers for the text: the rest of the app reads and sets it there
  Object.defineProperty(area, 'value', { configurable: true, get: () => native.get.call(area), set: text => { native.set.call(area, text); show(native.get.call(area)); } });
  Object.defineProperty(area, 'placeholder', { configurable: true, get: () => ed.dataset.placeholder, set: text => { ed.dataset.placeholder = text; } });
  area.focus = () => { ed.focus(); const last = ed.lastElementChild; if (last) caret(last, textOf(last).length); };
  area.scrollIntoView = options => ed.scrollIntoView(options);

  // where the cursor is: the block it is in, and how many characters into that block
  const here = () => {
    const sel = doc.getSelection();
    if (!sel.rangeCount || !ed.contains(sel.anchorNode)) return null;
    let el = sel.anchorNode;
    while (el && el.parentNode !== ed) el = el.parentNode;
    if (!el || el.nodeType !== 1) return null;
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return { el, at: range.toString().length, collapsed: sel.isCollapsed };
  };
  function caret(el, at) {
    const sel = doc.getSelection(), range = doc.createRange(), node = el.firstChild;
    if (node && node.nodeType === 3) range.setStart(node, Math.min(at, node.nodeValue.length)); else range.setStart(el, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const swap = (el, spec, at) => { const fresh = block(doc, spec); el.replaceWith(fresh); caret(fresh, at); return fresh; };

  ed.addEventListener('beforeinput', e => {
    if (/^format/.test(e.inputType)) return e.preventDefault(); // plain text only: no bold or colours to lose on the way to Google
    const pos = here();
    if (!pos) return;
    const { el, at } = pos, kind = kindOf(el), text = textOf(el);
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      if (!pos.collapsed) return; // a selection is replaced by the browser's own new line
      e.preventDefault();
      if ((kind === 'li' || kind === 'todo') && !text) { swap(el, { kind: 'p' }, 0); return tell(); } // Enter on an empty bullet ends the list
      const carries = kind === 'li' || kind === 'todo' ? kind : 'p'; // a list goes on; a heading is followed by ordinary text
      const next = block(doc, { kind: carries, pre: carries === 'li' ? el.dataset.pre : '', text: text.slice(at) });
      const kept = block(doc, { kind, pre: el.dataset.pre, done: !!el.dataset.done, text: text.slice(0, at) });
      el.replaceWith(kept, next);
      caret(next, 0);
      next.scrollIntoView({ block: 'nearest' });
      return tell();
    }
    if (e.inputType === 'deleteContentBackward' && pos.collapsed && at === 0 && kind !== 'p') { // Backspace at the start turns a bullet or heading back into plain text
      e.preventDefault();
      swap(el, { kind: 'p', text }, 0);
      return tell();
    }
  });
  ed.addEventListener('input', () => {
    if (!ed.firstChild) ed.append(block(doc, {}));
    const pos = here();
    const at = pos ? kindOf(pos.el) : '';
    if (at === 'li' && /^\[( |x)?\] /i.test(textOf(pos.el))) { // "[] " at the start of a bullet makes it a tick-box
      const text = textOf(pos.el);
      swap(pos.el, { kind: 'todo', done: /x/i.test(text.slice(0, 3)), text: text.replace(/^\[( |x)?\] /i, '') }, 0);
    } else if (at === 'p') { // the shortcuts: typed at the start of a line
      const text = textOf(pos.el);
      const made = /^\[( |x)?\] /i.exec(text) ? { kind: 'todo', done: /x/i.test(text.slice(0, 3)), text: text.replace(/^\[( |x)?\] /i, '') }
        : /^[-*] /.test(text) ? { kind: 'li', text: text.slice(2) }
          : /^#{1,3} /.test(text) ? { kind: 'h', pre: /^#{1,3} /.exec(text)[0], text: text.replace(/^#{1,3} /, '') } : null;
      if (made) swap(pos.el, made, 0);
    }
    tell();
  });
  ed.addEventListener('paste', e => { // only the words are taken, never another page's styling
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n'), pos = here();
    if (!text) return;
    if (!text.includes('\n') || !pos) { doc.execCommand('insertText', false, text.replace(/\n/g, ' ')); return; }
    if (!pos.collapsed) doc.getSelection().deleteFromDocument();
    const now = here() || pos, whole = write(now.el), cut = whole.length - textOf(now.el).length + now.at;
    const lines = `${whole.slice(0, cut)}${text}`.split('\n'), tail = whole.slice(cut);
    const blocks = lines.map((line, i) => block(doc, read(i === lines.length - 1 ? line + tail : line)));
    now.el.replaceWith(...blocks);
    const last = blocks[blocks.length - 1];
    caret(last, textOf(last).length - tail.length);
    tell();
  });
  ed.addEventListener('mousedown', e => { // a press on a tick-box ticks it
    const el = e.target.closest?.('.b.todo');
    if (!el || e.clientX - el.getBoundingClientRect().left > 22) return;
    e.preventDefault();
    if (el.dataset.done) delete el.dataset.done; else el.dataset.done = '1';
    tell();
  });
  ed.addEventListener('blur', () => area.dispatchEvent(new Event('change', { bubbles: true })));

  show(native.get.call(area));
  return ed;
}
