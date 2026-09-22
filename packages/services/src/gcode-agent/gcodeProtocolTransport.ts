import type { Event, IDisposable } from "@gcode/rpc";
import type { GCodeProtocolMessage } from "@gcode/shared";

export type GCodeProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface GCodeProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface GCodeProtocolTransport extends IDisposable {
  readonly kind: GCodeProtocolTransportKind;
  readonly onMessage: Event<GCodeProtocolMessage>;
  readonly onClose: Event<GCodeProtocolTransportClosedEvent>;
  send(message: GCodeProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
