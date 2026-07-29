export class Connection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map(); // type -> [callback, ...]
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
      this.ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const list = this.handlers.get(msg.type);
        if (list) list.forEach((cb) => cb(msg));
      });
    });
  }

  on(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(callback);
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
}
