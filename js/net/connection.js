export class Connection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map();
    this.intentionalClose = false; // ADDED: set by close(); lets a later reconnect flow (step 3) tell "user left on purpose" apart from "connection dropped"
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
      // ADDED: surface close to app instead of silent dead socket
      this.ws.addEventListener("close", (event) => {
        const list = this.handlers.get("__close");
        if (list) list.forEach((cb) => cb(event));
      });
    });
  }

  on(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(callback);
  }

  send(msg) {
    // FIXED: guard against sending on dead socket
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("send skipped, socket not open:", msg.type);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // ADDED: explicit teardown for "the user walked away" (back to menu,
  // cancel waiting room, starting a different match). Without this the old
  // socket just sits open in the background forever — the server's
  // disconnect/abort handling only ever runs off a real 'close' event, so
  // if we never close it, the server has no idea the player left.
  close() {
    this.intentionalClose = true;
    this.ws?.close();
  }
}
