// The little the website does by itself: plays its clip only while it is in view (and never for
// someone who has asked for less motion), and marks the tab of the card being read.
const clip = document.getElementById('tour'), button = document.getElementById('tourBtn');
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
let wanted = !calm; // whether the visitor wants it playing
const show = () => { button.setAttribute('aria-pressed', String(!clip.paused)); button.setAttribute('aria-label', clip.paused ? 'Play the clip' : 'Pause the clip'); };
if (clip && button) {
  button.addEventListener('click', () => { wanted = clip.paused; wanted ? clip.play().catch(() => {}) : clip.pause(); });
  clip.addEventListener('play', show);
  clip.addEventListener('pause', show);
  new IntersectionObserver(([seen]) => { if (seen.isIntersecting && wanted) clip.play().catch(() => {}); else clip.pause(); }, { threshold: 0.35 }).observe(clip);
  show();
}

const tabs = new Map([...document.querySelectorAll('.tabs a')].map(a => [a.dataset.tab, a]));
const reading = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const tab = tabs.get(entry.target.id);
    if (tab) tab.classList.toggle('on', entry.isIntersecting);
  }
}, { rootMargin: '-45% 0px -50% 0px' });
for (const id of tabs.keys()) { const card = document.getElementById(id); if (card) reading.observe(card); }
