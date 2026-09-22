export interface HelloMessage {
  type: "gcode-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "gcode-hello-ack";
  version: string;
  clientId: string;
}
