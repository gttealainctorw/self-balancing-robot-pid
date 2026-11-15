// Start-up. /control and /statistics are the same document: the path decides
// which page runs, and the other page's markup is taken out. The robot keeps
// no page state, so every device chooses its page independently.

Settings.load();
Store.init();
const PAGE = /\/statistics\/?$/.test(location.pathname) ? 'statistics' : 'control';
document.body.dataset.page = PAGE;
$('#page-' + (PAGE === 'control' ? 'statistics' : 'control')).remove();
$$('[data-only]').forEach(el => { if (el.dataset.only !== PAGE) el.remove(); });
$$('[data-nav]').forEach(a => {
  a.classList.toggle('on', a.dataset.nav === PAGE);
  if (a.dataset.nav === PAGE) a.setAttribute('aria-current', 'page');
});
document.title = (PAGE === 'control' ? 'Control' : 'Statistics') + ' · BalanceBot';
window.BB = PAGE === 'control' ? startControl() : startStats();   // handle for debugging and tests
window.BB.Store = Store;
window.BB.Lib = Lib;
