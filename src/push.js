'use strict';
// Web Push for the video-review PWA. No-ops when VAPID keys are not set.

class Push {
  constructor(cfg, store, log) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this._client = null;
  }
  configured() {
    return Boolean(this._client) || Boolean(this.cfg.vapidPublicKey && this.cfg.vapidPrivateKey);
  }
  client() {
    if (this._client) return this._client;
    if (!this.cfg.vapidPublicKey || !this.cfg.vapidPrivateKey) return null;
    try {
      const webpush = require('web-push');
      webpush.setVapidDetails(
        this.cfg.vapidSubject || 'mailto:bot@jmags.local',
        this.cfg.vapidPublicKey,
        this.cfg.vapidPrivateKey,
      );
      this._client = webpush;
      return webpush;
    } catch (e) {
      this.log.warn('web push unavailable', e.message);
      return null;
    }
  }
  async notify(payload) {
    const client = this.client();
    if (!client) return { sent: 0, skipped: true };
    const subs = this.store.readSubscriptions();
    const keep = [];
    let sent = 0;
    for (const sub of subs) {
      try {
        await client.sendNotification(sub, JSON.stringify(payload));
        sent += 1;
        keep.push(sub);
      } catch (e) {
        const status = e.statusCode || e.status;
        if (status === 404 || status === 410) continue;
        keep.push(sub);
        this.log.warn('push failed', e.message);
      }
    }
    if (keep.length !== subs.length) this.store.writeSubscriptions(keep);
    return { sent, skipped: false };
  }
}
module.exports = { Push };
