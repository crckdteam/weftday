// The page an invite link opens (invite.html). The link's code, after the "#", holds the Google
// sign-in setup of the copy of Weftday it was made in. Nothing is taken until the person presses
// Accept; then the code is handed to the app through this tab's own storage (it never leaves this
// browser), and the app opens with the setup in place. A browser that already has its own setup is
// left exactly as it is.
import { unpackInvite } from './util.js';

const $ = id => document.getElementById(id);
const code = location.hash.replace(/^#(t=)?/, '');
const setup = unpackInvite(code);
history.replaceState(null, '', location.pathname); // the code does not stay in the address bar or the history
// A second invite link opened in this same tab only changes the part after "#": read it afresh.
addEventListener('hashchange', () => location.reload());

let has = false; // this browser already has a sign-in setup of its own
try { has = !!JSON.parse(localStorage.getItem('planner.v1') || 'null')?.settings?.clientId; } catch { /* nothing saved here */ }

function only(title, lead) {
  $('title').textContent = title; $('lead').textContent = lead;
  $('steps').hidden = true; $('accept').hidden = true; $('small').hidden = true; $('open').hidden = false;
  $('open').className = 'btn primary';
}
if (has) only('Weftday is already set up here', 'This browser has Weftday ready, so the invite is not needed. Nothing was changed.');
else if (!setup) only('This invite link is not complete', 'Part of the link is missing, which can happen when it is copied by hand. Ask for it again and open it straight from the message.');
else $('accept').addEventListener('click', () => {
  try { sessionStorage.setItem('weftday.invite', code); } catch { return only('This browser will not keep the invite', 'Its storage is switched off, perhaps in a private window. Open the link in an ordinary window.'); }
  location.href = './';
});
