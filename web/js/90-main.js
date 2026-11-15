// Start-up. /, /control and /statistics are the same document: the path decides
// which page runs, and the markup of the other pages is taken out. The robot
// keeps no page state, so every device chooses its page independently.

Settings.load();
Store.init();
const PAGE = /\/statistics\/?$/.test(location.pathname) ? 'statistics' : /\/control\/?$/.test(location.pathname) ? 'control' : 'cover';
document.body.dataset.page = PAGE;
['cover', 'control', 'statistics'].forEach(p => { if (p !== PAGE) $('#page-' + p).remove(); });
$$('[data-only]').forEach(el => { if (el.dataset.only !== PAGE) el.remove(); });
$$('[data-hide]').forEach(el => { if (el.dataset.hide === PAGE) el.remove(); });
$$('[data-nav]').forEach(a => {
  a.classList.toggle('on', a.dataset.nav === PAGE);
  if (a.dataset.nav === PAGE) a.setAttribute('aria-current', 'page');
});
document.title = PAGE === 'cover' ? 'BalanceBot' : (PAGE === 'control' ? 'Control' : 'Statistics') + ' · BalanceBot';
// The cover is a static page: it does not talk to the robot at all.
window.BB = PAGE === 'control' ? startControl() : PAGE === 'statistics' ? startStats() : {};
window.BB.Store = Store;
window.BB.Lib = Lib;
