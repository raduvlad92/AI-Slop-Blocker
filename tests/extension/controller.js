// Injected only into a disposable copy by run.mjs; never packaged for users.
(async () => {
  const api = typeof browser === 'undefined' ? chrome : browser;
  const base = '__TEST_ORIGIN__';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const send = async (message) => {
    const result = await api.runtime.sendMessage(message);
    assert(result?.ok, result?.error || 'Background message failed');
    return result;
  };
  try {
    const initial = await api.storage.local.get(['installId', 'reportingConsent']);
    assert(/^[a-f0-9-]{36}$/i.test(initial.installId), 'No installation ID initialized');
    assert(initial.reportingConsent.enabled === false, 'Reporting was enabled at install');
    await send({ type: 'asb-sync-now' });
    await send({ type: 'asb-settings', settings: { hideYouTube: true, hideAIOverview: true, watchAction: 'overlay' } });
    const backup = { format: 'ai-slop-blocker', version: 1, personal: { videos: { AAAAAAAAAAA: { channelName: 'Imported' } }, channels: {} }, settings: {} };
    await send({ type: 'asb-import', text: JSON.stringify(backup) });
    const exported = await send({ type: 'asb-export' });
    assert(!JSON.stringify(exported.data).includes(initial.installId), 'Export leaked installation ID');
    assert(exported.data.personal.videos.AAAAAAAAAAA, 'Import/export round trip failed');
    const blocked = await send({ type: 'asb-block', scope: 'channel', info: { videoId: 'BBBBBBBBBBB', channelId: '@example', channelName: 'Example' } });
    await send({ type: 'asb-undo', token: blocked.undoToken });
    let state = await api.storage.local.get(['personal', 'installId', 'reportingConsent']);
    assert(!state.personal.channels['@example'] && !state.personal.videos.BBBBBBBBBBB, 'Undo did not restore lists');
    assert(state.installId === initial.installId && state.reportingConsent.enabled === false, 'Import changed identity or sharing');
    await send({ type: 'asb-block', scope: 'channel', info: { videoId: 'BBBBBBBBBBB', channelId: '@example', channelName: 'Example' } });
    if (api.runtime.getBrowserInfo) {
      const denied = await api.runtime.sendMessage({ type: 'asb-set-reporting', enabled: true });
      assert(denied?.ok === false, 'Firefox sharing enabled without native data permission');
    }
    await api.tabs.create({ url: base + '/watch?v=BBBBBBBBBBB', active: true });
    await api.tabs.create({ url: base + '/search?q=fixture', active: true });
    await fetch(base + '/result', { method: 'POST', body: JSON.stringify({ suite: 'storage', ok: true, assertions: 9, permissions: await api.permissions.getAll() }) });
  } catch (error) {
    await fetch(base + '/result', { method: 'POST', body: JSON.stringify({ suite: 'storage', ok: false, error: error.message }) });
  }
})();
