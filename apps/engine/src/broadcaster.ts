import { Server } from "socket.io";
import { AccountPayload, SOCKET_EVENTS } from "@my-platform/types";

export class Broadcaster {
  private io: Server;

  constructor(port: number = 4000) {
    this.io = new Server(port, {
      cors: { origin: "*" }, // adjust for production later
    });
    console.log(`📡 WebSocket Server running on port ${port}`);
  }

  broadcastBar(symbol: string, price: number) {
    this.io.emit(SOCKET_EVENTS.BAR, { symbol, price, timestamp: new Date() });
  }

  broadcastSignal(signal: any) {
    this.io.emit(SOCKET_EVENTS.SIGNAL, signal);
  }

  broadcastStatus(status: "ACTIVE" | "KILLED") {
    this.io.emit(SOCKET_EVENTS.STATUS, {
      status,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastPortfolio(positions: any[]) {
    this.io.emit(SOCKET_EVENTS.UPDATE, positions);
  }

  broadcastAccount(data: AccountPayload) {
    this.io.emit(SOCKET_EVENTS.ACCOUNT, data);
  }
}
