(function () {
  window.connectState = function (onState, onInfo) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    function open() {
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'state' && onState) onState(m.state);
        if (m.type === 'info' && onInfo) onInfo(m);
        if (m.type === 'scoreResult' && window.onScoreResult) window.onScoreResult(m);
      };
      ws.onclose = () => setTimeout(open, 1000);
      window._ws = ws;
    }
    open();
  };
  window.sendWS = function (obj) {
    const ws = window._ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
})();
