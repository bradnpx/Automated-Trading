import { Server } from "socket.io";
import { AccountPayload, HealthStatus, SOCKET_EVENTS } from "@my-platform/types";

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

  broadcastScannerAlert(symbol: string, rvol: number) {
    this.io.emit("scanner alert", { symbol, rvol, timestamp: new Date() });
  }

  broadcastHealth(alpacaConnected: boolean) {
    const memory = process.memoryUsage().heapUsed / 1024 / 1024;
    const health: HealthStatus = {
      latency: 0, // Calculated by the client (ping/pong)
      alpacaStream: alpacaConnected ? "CONNECTED" : "DISCONNECTED",
      memoryUsage: `${memory.toFixed(2)} MB`,
      uptime: `${Math.floor(process.uptime())}s`,
      timestamp: new Date().toISOString(),
    };
    this.io.emit(SOCKET_EVENTS.HEALTH, health);
  }
}
