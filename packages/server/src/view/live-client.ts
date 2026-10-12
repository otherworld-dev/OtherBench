/**
 * `grunt-live.js` (spec 2026-10-12-live-artifacts): what a live page includes
 * to ask Grunt's app frame for data. Served only beside a live version, under
 * its strict policy. It has no dependencies and no eval. `grunt.live(callId,
 * params)` resolves to `{ text, json, structured, cached, at }` or rejects
 * with an Error whose `code` says why (`timeout` after 45 s). Replies count
 * only from the parent window; the page's origin is opaque, so both sides
 * post with '*'.
 */
export const LIVE_CLIENT_FILE = 'grunt-live.js';

export const LIVE_CLIENT_JS = `(function () {
  'use strict';
  var pending = Object.create(null);
  var next = 0;
  function fail(code, message) { var e = new Error(message); e.code = code; return e; }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.grunt !== 'live-result' || d.v !== 1 || typeof d.requestId !== 'string') return;
    var p = pending[d.requestId];
    if (!p) return;
    delete pending[d.requestId];
    clearTimeout(p.timer);
    if (d.ok === true) p.resolve({ text: d.text, json: d.json, structured: d.structured, cached: d.cached === true, at: d.at });
    else p.reject(fail(typeof d.code === 'string' ? d.code : 'failed', typeof d.message === 'string' ? d.message : 'Live data failed.'));
  });
  function live(call, params) {
    return new Promise(function (resolve, reject) {
      var requestId = 'r' + (++next);
      var timer = setTimeout(function () { delete pending[requestId]; reject(fail('timeout', 'Grunt did not answer within 45 seconds.')); }, 45000);
      pending[requestId] = { resolve: resolve, reject: reject, timer: timer };
      parent.postMessage({ grunt: 'live-call', v: 1, requestId: requestId, call: String(call), params: params === undefined ? {} : params }, '*');
    });
  }
  Object.defineProperty(window, 'grunt', { value: Object.freeze({ live: live }), writable: false, configurable: false });
})();
`;
