// Exercises actual installed content scripts on local fixtures, with real APIs.
(async () => {
  const base = '__TEST_ORIGIN__';
  const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await wait(); }
    throw new Error('Timed out waiting for installed content script');
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const suite = location.pathname === '/search' ? 'google' : 'youtube';
  try {
    if (suite === 'google') {
      await until(() => document.querySelector('#overview')?.getAttribute('data-asb-hidden') === '1');
      assert(getComputedStyle(document.querySelector('#organic')).display !== 'none', 'Organic result hidden');
    } else {
      await until(() => document.querySelector('.asb-player-overlay'));
      assert(document.querySelector('.asb-overlay-sub').textContent.includes('Your channel block'), 'Personal block explanation missing');
      document.querySelector('.asb-overlay-controls button').click();
      await until(() => !document.querySelector('.asb-player-overlay'));
      history.replaceState({}, '', '/watch?v=CCCCCCCCCCC');
      window.dispatchEvent(new Event('yt-navigate-finish'));
      await until(() => document.querySelector('.asb-player-overlay'));
      document.querySelectorAll('.asb-overlay-controls button')[2].click();
      await until(() => !document.querySelector('.asb-player-overlay'));
      assert((await ASB.getState()).allowlist.channels['@example'], 'Permanent exception not stored');
    }
    await fetch(base + '/result', { method: 'POST', body: JSON.stringify({ suite, ok: true }) });
  } catch (error) {
    await fetch(base + '/result', { method: 'POST', body: JSON.stringify({ suite, ok: false, error: error.message }) });
  }
})();
